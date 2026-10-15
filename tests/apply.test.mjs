import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { apply, resolveOptions } from '../src/index.js'

/**
 * Integration coverage for the real `apply()` wiring: the fences and the retry
 * nonce must survive the trip from plugin config, through the registered HTTP
 * routes, into the filesystem.
 */

const call = (callId, name, args) => ({ type: 'tool/call', data: { callId, name, arguments: JSON.stringify(args) } })
const result = (callId, meta) => ({ type: 'tool/result', data: { message: { toolCallId: callId, isError: false }, meta } })

/** A Cordis-shaped ctx capturing the routes the plugin registers. */
const makeCtx = ({ header, events, sessionRoot, agents, sessions }) => {
  const routes = new Map()
  const effects = []
  const ctx = {
    sessionPersistence: {
      config: { root: sessionRoot },
      open: async () => ({ header, read: async () => ({ events }), close: async () => {} }),
      list: async () => [{ header }],
    },
    // `connection` is what the request fence resolves; the other services are
    // optional lookups, so an unknown key must be undefined rather than a
    // connection-shaped object.
    get: key => {
      if (key === 'connection') return { requestRejection: () => undefined }
      if (key === 'agents') return agents
      if (key === 'sessions') return sessions
      return undefined
    },
    webServer: {
      register: route => { routes.set(route.path, route.handler); return () => routes.delete(route.path) },
    },
    effect: (fn) => { effects.push(fn); const d = fn(); return d },
  }
  return { ctx, routes, effects }
}

const req = (body, action) => {
  const buf = Buffer.from(JSON.stringify(body))
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-session-artifacts-action': action },
    async *[Symbol.asyncIterator]() { yield buf },
  }
}
const res = () => {
  const out = {}
  return { out, writeHead: s => { out.status = s }, end: t => { out.body = JSON.parse(t) } }
}

test('apply() wires both routes and honors the DSH home fence end to end', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-home-'))
  const sessionRoot = join(home, 'sessions')
  const workspace = join(home, 'scratch')       // a workspace nested inside the home
  const plugins = join(home, 'plugins')          // DSH's own state, off limits
  await mkdir(workspace, { recursive: true })
  await mkdir(plugins, { recursive: true })

  const mine = join(workspace, 'out.md')
  const installed = join(plugins, 'installed-plugin.js')
  await writeFile(mine, 'session output')
  await writeFile(installed, 'module.exports = 1')

  const header = { version: 4, id: 's1', createdAt: 1, cwd: workspace, isSeeded: false }
  const events = [
    call('c1', 'write', { file_path: mine }),
    result('c1', { operation: 'create' }),
    // A Session with a broad cwd trying to reach DSH's own state.
    call('c2', 'write', { file_path: installed }),
    result('c2', { operation: 'create' }),
  ]

  const { ctx, routes } = makeCtx({ header, events, sessionRoot })
  apply(ctx, {})

  assert.ok(routes.has('/plugins/dsh-session-artifacts/preview'))
  assert.ok(routes.has('/plugins/dsh-session-artifacts/remove'))

  const previewRes = res()
  await routes.get('/plugins/dsh-session-artifacts/preview')(
    req({ sessionId: 's1' }, 'preview-artifacts'), previewRes,
  )
  assert.equal(previewRes.out.status, 200)
  // Only the workspace file is offered; the installed plugin is fenced out.
  assert.equal(previewRes.out.body.value.total, 1)
  assert.equal(previewRes.out.body.value.files[0].display, 'out.md')

  const removeRes = res()
  await routes.get('/plugins/dsh-session-artifacts/remove')(
    req({ nonce: previewRes.out.body.value.nonce }, 'delete-artifacts'), removeRes,
  )
  assert.equal(removeRes.out.status, 200)
  assert.equal(removeRes.out.body.value.removed.length, 1)
  assert.equal(existsSync(mine), false)
  assert.equal(existsSync(installed), true, 'the installed plugin must survive')
})

test('apply() refuses to remove a file that changed after the preview, and issues a retry nonce', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-home-'))
  const sessionRoot = join(home, 'sessions')
  const workspace = join(home, 'ws')
  await mkdir(workspace, { recursive: true })
  const target = join(workspace, 'out.md')
  await writeFile(target, 'original')

  const header = { version: 4, id: 's1', createdAt: 1, cwd: workspace, isSeeded: false }
  const events = [call('c1', 'write', { file_path: target }), result('c1', { operation: 'create' })]
  const { ctx, routes } = makeCtx({ header, events, sessionRoot })
  apply(ctx, {})

  const previewRes = res()
  await routes.get('/plugins/dsh-session-artifacts/preview')(
    req({ sessionId: 's1' }, 'preview-artifacts'), previewRes,
  )
  // The file changes size between the preview and the removal.
  await writeFile(target, 'original plus more text')

  const removeRes = res()
  await routes.get('/plugins/dsh-session-artifacts/remove')(
    req({ nonce: previewRes.out.body.value.nonce }, 'delete-artifacts'), removeRes,
  )
  assert.equal(removeRes.out.status, 200)
  assert.equal(removeRes.out.body.value.removed.length, 0)
  assert.equal(removeRes.out.body.value.failed[0].reason, 'size-changed-since-preview')
  // The leftover is reachable again through the retry nonce, which is the only
  // way back to it now that the preview nonce is spent.
  assert.match(removeRes.out.body.value.retryNonce, /^[0-9a-f-]{36}$/)
  assert.equal(await readFile(target, 'utf8'), 'original plus more text')

  // Retrying after the size is reconciled removes it.
  const retryRes = res()
  await routes.get('/plugins/dsh-session-artifacts/remove')(
    req({ nonce: removeRes.out.body.value.retryNonce }, 'delete-artifacts'), retryRes,
  )
  assert.equal(retryRes.out.status, 200)
  assert.equal(retryRes.out.body.value.removed.length, 1)
  assert.equal(existsSync(target), false)
})

/**
 * A live-registry double shaped like the real `agents`/`sessions` services: the
 * tracker patches whatever object it is handed, so `create`/`resume` must exist
 * and produce a handle that unregisters the agent.
 */
const makeLive = () => {
  const liveAgents = new Map()
  const liveSessions = new Map()
  // The real host detaches the session as part of disposing the agent, so the
  // double does both — otherwise the wait-for-drain loop could never succeed.
  const disposeOf = id => async () => {
    liveAgents.delete(id)
    liveSessions.delete(id)
  }
  const agents = {
    live: liveAgents,
    async resume({ resumeSessionId }) {
      const agent = { id: resumeSessionId, status: 'idle', cancel() {} }
      liveAgents.set(resumeSessionId, agent)
      liveSessions.set(resumeSessionId, { id: resumeSessionId })
      return { agent, dispose: disposeOf(resumeSessionId) }
    },
    async create({ sessionId }) {
      const agent = { id: sessionId, status: 'idle', cancel() {} }
      liveAgents.set(sessionId, agent)
      liveSessions.set(sessionId, { id: sessionId })
      return { agent, dispose: disposeOf(sessionId) }
    },
    enter(agent) { liveAgents.set(agent.id, agent); return () => liveAgents.delete(agent.id) },
    get(id) { return liveAgents.get(id) },
  }
  const sessions = {
    get(id) { return liveSessions.get(id) },
  }
  return { agents, sessions, liveAgents, liveSessions }
}

test('apply() deletes an OPEN (live, idle) session — the reported bug', async () => {
  // An open session is live and idle. Before the handle tracker this was
  // refused with "仍在运行或未从宿主摘除", because nothing ever unregisters it.
  const home = await mkdtemp(join(tmpdir(), 'dsa-home-'))
  const sessionRoot = join(home, 'sessions')
  const workspace = join(home, 'ws')
  const sessionId = 'open-1'
  const sessionDir = join(sessionRoot, '--proj--', sessionId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'header\n')
  await mkdir(workspace, { recursive: true })

  const header = { version: 4, id: sessionId, createdAt: 1, cwd: workspace, isSeeded: false }
  const live = makeLive()
  const { ctx, routes } = makeCtx({ header, events: [], sessionRoot, agents: live.agents, sessions: live.sessions })
  apply(ctx, {})

  // The agent is live the way the host creates it — AFTER the tracker installed.
  await live.agents.resume({ resumeSessionId: sessionId })
  assert.equal(live.liveAgents.has(sessionId), true)
  assert.equal(live.liveSessions.has(sessionId), true)

  const delRes = res()
  await routes.get('/plugins/dsh-session-artifacts/delete-session')(
    req({ sessionId }, 'delete-session'), delRes,
  )
  assert.equal(delRes.out.status, 200, JSON.stringify(delRes.out.body))
  assert.equal(delRes.out.body.value.deleted, true)
  assert.equal(existsSync(sessionDir), false, 'storage is gone')
  assert.equal(live.liveAgents.has(sessionId), false, 'the agent was torn down')
  assert.equal(live.liveSessions.has(sessionId), false, 'the session was detached')
})

test('apply() explains an untracked live session instead of blaming a running turn', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-home-'))
  const sessionRoot = join(home, 'sessions')
  const workspace = join(home, 'ws')
  const sessionId = 'preexisting-1'
  const sessionDir = join(sessionRoot, '--proj--', sessionId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'header\n')
  await mkdir(workspace, { recursive: true })

  const header = { version: 4, id: sessionId, createdAt: 1, cwd: workspace, isSeeded: false }
  // The agent is already live BEFORE apply(), so no handle can be captured.
  const live = makeLive()
  live.liveAgents.set(sessionId, { id: sessionId, status: 'idle', cancel() {} })
  live.liveSessions.set(sessionId, { id: sessionId })

  const { ctx, routes } = makeCtx({ header, events: [], sessionRoot, agents: live.agents, sessions: live.sessions })
  // A short lifecycle timeout keeps this test off the wall clock.
  apply(ctx, { lifecycleTimeoutMs: 150 })

  const delRes = res()
  await routes.get('/plugins/dsh-session-artifacts/delete-session')(
    req({ sessionId }, 'delete-session'), delRes,
  )
  assert.equal(delRes.out.status, 409)
  assert.equal(delRes.out.body.error.code, 'lifecycle-unavailable')
  assert.match(delRes.out.body.error.message, /重启/)
  assert.equal(existsSync(sessionDir), true, 'storage must be left alone')
})

test('apply() deletes the session record itself, with no chat-manager involved', async () => {
  // This is the regression that matters: the plugin must not depend on
  // dsh-chat-manager's /plugins/dsh-session-delete route, which is absent
  // whenever that plugin is disabled.
  const home = await mkdtemp(join(tmpdir(), 'dsa-home-'))
  const sessionRoot = join(home, 'sessions')
  const workspace = join(home, 'ws')
  const sessionId = 'sess-abc'
  const sessionDir = join(sessionRoot, '--proj--', sessionId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'header\n')
  await mkdir(workspace, { recursive: true })
  const artifact = join(workspace, 'out.md')
  await writeFile(artifact, 'made')

  const header = { version: 4, id: sessionId, createdAt: 1, cwd: workspace, isSeeded: false }
  const events = [call('c1', 'write', { file_path: artifact }), result('c1', { operation: 'create' })]

  const { ctx, routes } = makeCtx({ header, events, sessionRoot })
  apply(ctx, {})

  // The plugin exposes its own routes, including the capability probe.
  assert.ok(routes.has('/plugins/dsh-session-artifacts/delete-session'))
  assert.ok(routes.has('/plugins/dsh-session-artifacts/capability'))

  // Capability reports that this Host can delete a session record.
  const capRes = res()
  await routes.get('/plugins/dsh-session-artifacts/capability')({ method: 'GET', headers: {} }, capRes)
  assert.equal(capRes.out.status, 200)
  assert.equal(capRes.out.body.value.deleteSession, true)

  // Preview then delete the record through the plugin's own route.
  const previewRes = res()
  await routes.get('/plugins/dsh-session-artifacts/preview')(
    req({ sessionId }, 'preview-artifacts'), previewRes,
  )
  const nonce = previewRes.out.body.value.nonce

  const delRes = res()
  await routes.get('/plugins/dsh-session-artifacts/delete-session')(
    req({ sessionId }, 'delete-session'), delRes,
  )
  assert.equal(delRes.out.status, 200)
  assert.equal(delRes.out.body.value.deleted, true)
  assert.equal(existsSync(sessionDir), false, 'the session log directory must be gone')

  // The artifacts remain removable after the record is gone.
  const removeRes = res()
  await routes.get('/plugins/dsh-session-artifacts/remove')(
    req({ nonce }, 'delete-artifacts'), removeRes,
  )
  assert.equal(removeRes.out.status, 200)
  assert.equal(existsSync(artifact), false)
})

test('apply() removes artifacts WITHOUT deleting the session record', async () => {
  // The "clean up the mess, keep the conversation" mode: preview then remove,
  // and the session log must survive untouched.
  const home = await mkdtemp(join(tmpdir(), 'dsa-home-'))
  const sessionRoot = join(home, 'sessions')
  const workspace = join(home, 'ws')
  const sessionId = 'keep-me'
  const sessionDir = join(sessionRoot, '--proj--', sessionId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'header\n')
  await mkdir(workspace, { recursive: true })
  const artifact = join(workspace, 'out.md')
  await writeFile(artifact, 'made')

  const header = { version: 4, id: sessionId, createdAt: 1, cwd: workspace, isSeeded: false }
  const events = [call('c1', 'write', { file_path: artifact }), result('c1', { operation: 'create' })]
  const { ctx, routes } = makeCtx({ header, events, sessionRoot })
  apply(ctx, {})

  const previewRes = res()
  await routes.get('/plugins/dsh-session-artifacts/preview')(
    req({ sessionId }, 'preview-artifacts'), previewRes,
  )
  assert.equal(previewRes.out.body.value.total, 1)

  // Note: delete-session is deliberately never called.
  const removeRes = res()
  await routes.get('/plugins/dsh-session-artifacts/remove')(
    req({ nonce: previewRes.out.body.value.nonce }, 'delete-artifacts'), removeRes,
  )
  assert.equal(removeRes.out.status, 200)
  assert.equal(removeRes.out.body.value.removed.length, 1)
  assert.equal(existsSync(artifact), false, 'the artifact is gone')
  assert.equal(existsSync(join(sessionDir, 'session.v4.jsonl.zstd')), true, 'the session log survives')
})

test('apply() reports 501 for session deletion when the capability is off', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-home-'))
  const sessionRoot = join(home, 'sessions')
  const workspace = join(home, 'ws')
  await mkdir(workspace, { recursive: true })
  const header = { version: 4, id: 's1', createdAt: 1, cwd: workspace, isSeeded: false }
  const { ctx, routes } = makeCtx({ header, events: [], sessionRoot })
  apply(ctx, { deleteSession: false })

  const capRes = res()
  await routes.get('/plugins/dsh-session-artifacts/capability')({ method: 'GET', headers: {} }, capRes)
  assert.equal(capRes.out.body.value.deleteSession, false)

  const delRes = res()
  await routes.get('/plugins/dsh-session-artifacts/delete-session')(
    req({ sessionId: 's1' }, 'delete-session'), delRes,
  )
  assert.equal(delRes.out.status, 501)
  assert.equal(delRes.out.body.error.code, 'unsupported')
})

test('apply() refuses to delete a session that is still live', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-home-'))
  const sessionRoot = join(home, 'sessions')
  const workspace = join(home, 'ws')
  const sessionId = 'live-1'
  const sessionDir = join(sessionRoot, '--proj--', sessionId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'header\n')
  await mkdir(workspace, { recursive: true })

  const header = { version: 4, id: sessionId, createdAt: 1, cwd: workspace, isSeeded: false }
  // A live session with no way to cancel it: the deletion must be refused.
  const { ctx, routes } = makeCtx({
    header, events: [], sessionRoot,
    agents: { get: () => ({ status: 'running' }) },
    sessions: { get: () => ({ id: sessionId }) },
  })
  apply(ctx, {})

  const delRes = res()
  await routes.get('/plugins/dsh-session-artifacts/delete-session')(
    req({ sessionId }, 'delete-session'), delRes,
  )
  assert.equal(delRes.out.status, 409)
  assert.equal(delRes.out.body.error.code, 'lifecycle-unavailable')
  assert.equal(existsSync(sessionDir), true, 'a refused deletion must leave storage alone')
})

test('resolveOptions defaults to the safe settings and reads explicit config', () => {
  const sessionRoot = join('C:', 'Users', 'me', '.dsh', 'sessions')
  const ctx = { sessionPersistence: { config: { root: sessionRoot } } }

  const defaults = resolveOptions({}, ctx)
  assert.equal(defaults.protectPackages, true)
  assert.equal(defaults.includeDelivered, false)
  assert.deepEqual(defaults.extraExcludes, [])

  const explicit = resolveOptions({
    protectPackages: false,
    includeDelivered: true,
    extraExcludes: ['C:\\temp', '', 42],
  }, ctx)
  assert.equal(explicit.protectPackages, false)
  assert.equal(explicit.includeDelivered, true)
  // Only non-empty strings survive.
  assert.deepEqual(explicit.extraExcludes, ['C:\\temp'])
})
