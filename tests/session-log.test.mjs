import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { deleteSessionLog, locateSessionLog, sessionPathsFor } from '../src/host/session-log.mjs'
import { quiesceSession } from '../src/host/lifecycle.mjs'

/**
 * Build a real session-store layout:
 *   <root>/<project>/<sessionId>/session.v4.jsonl.zstd
 */
const makeStore = async (sessionId = 'abc-123') => {
  const root = await mkdtemp(join(tmpdir(), 'dsa-store-'))
  const project = join(root, '--C-Users-me-ws--')
  const sessionDir = join(project, sessionId)
  await mkdir(sessionDir, { recursive: true })
  const log = join(sessionDir, 'session.v4.jsonl.zstd')
  await writeFile(log, 'header\nevent\n')
  return { root, project, sessionDir, log, sessionId }
}

/** A persistence double exposing only the locator this module needs. */
const persistenceFor = logPath => ({
  name: 'session-persistence-jsonl',
  resolveCurrentLog: async () => logPath,
})

test('sessionPathsFor accepts the documented layout and refuses everything else', () => {
  const root = process.platform === 'win32' ? 'C:\\store' : '/store'
  const good = join(root, 'proj', 'sess', 'session.v4.jsonl.zstd')
  const paths = sessionPathsFor(root, good)
  assert.equal(paths.sessionDirectory, join(root, 'proj', 'sess'))
  assert.equal(paths.transcript, good)

  // Depth must be exactly three segments under the root.
  assert.equal(sessionPathsFor(root, join(root, 'sess', 'session.v4.jsonl.zstd')), undefined)
  assert.equal(sessionPathsFor(root, join(root, 'a', 'b', 'c', 'session.v4.jsonl.zstd')), undefined)
  // The leaf must be a session log.
  assert.equal(sessionPathsFor(root, join(root, 'proj', 'sess', 'notes.txt')), undefined)
  assert.equal(sessionPathsFor(root, join(root, 'proj', 'sess', 'session.v4.jsonl.bak')), undefined)
  // Outside the root is refused.
  const outside = process.platform === 'win32' ? 'C:\\elsewhere\\p\\s\\session.v4.jsonl.zstd' : '/elsewhere/p/s/session.v4.jsonl.zstd'
  assert.equal(sessionPathsFor(root, outside), undefined)
  // Older generations are still removable.
  assert.ok(sessionPathsFor(root, join(root, 'p', 's', 'session.jsonl')))
  assert.ok(sessionPathsFor(root, join(root, 'p', 's', 'session.v2.jsonl.zstd')))
})

test('locateSessionLog prefers the backend locator, then falls back to a scan', async () => {
  const { root, log, sessionId } = await makeStore()
  assert.equal(await locateSessionLog({
    sessionPersistence: persistenceFor(log), sessionRoot: root, sessionId,
  }), log)

  // No locator available: the scan finds it.
  assert.equal(await locateSessionLog({
    sessionPersistence: {}, sessionRoot: root, sessionId,
  }), log)

  // Unknown session: nothing to find.
  assert.equal(await locateSessionLog({
    sessionPersistence: {}, sessionRoot: root, sessionId: 'nope',
  }), undefined)
})

test('deleteSessionLog removes the session directory and leaves the store intact', async () => {
  const { root, project, sessionDir, sessionId } = await makeStore()
  // A sibling session must survive.
  const sibling = join(project, 'other-session')
  await mkdir(sibling, { recursive: true })
  await writeFile(join(sibling, 'session.v4.jsonl.zstd'), 'x')

  const result = await deleteSessionLog({
    sessionPersistence: persistenceFor(join(sessionDir, 'session.v4.jsonl.zstd')),
    sessionRoot: root,
    sessionId,
  })

  assert.equal(result.ok, true)
  assert.equal(result.value.deleted, true)
  assert.equal(existsSync(sessionDir), false)
  assert.equal(existsSync(sibling), true, 'a sibling session must survive')
  assert.equal(existsSync(project), true, 'the project directory must survive')
  assert.equal(existsSync(root), true, 'the store root must survive')
  // No quarantine leftovers.
  const { readdir } = await import('node:fs/promises')
  const leftovers = (await readdir(root)).filter(n => n.startsWith('.dsh-session-artifacts-delete-'))
  assert.deepEqual(leftovers, [])
})

test('deleteSessionLog reports alreadyAbsent when the session never materialized', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsa-store-'))
  const result = await deleteSessionLog({
    sessionPersistence: {}, sessionRoot: root, sessionId: 'never-existed',
  })
  assert.equal(result.ok, true)
  assert.equal(result.value.alreadyAbsent, true)
  assert.equal(result.value.deleted, false)
})

test('deleteSessionLog refuses a symlinked session directory', async (t) => {
  const { root, project, sessionId } = await makeStore()
  const outside = await mkdtemp(join(tmpdir(), 'dsa-out-'))
  await writeFile(join(outside, 'session.v4.jsonl.zstd'), 'secret')
  const linked = join(project, 'linked')
  try {
    const { symlink } = await import('node:fs/promises')
    await symlink(outside, linked, 'dir')
  } catch {
    t.skip('symlink creation unavailable')
    return
  }
  const result = await deleteSessionLog({
    sessionPersistence: persistenceFor(join(linked, 'session.v4.jsonl.zstd')),
    sessionRoot: root,
    sessionId,
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'unsafe-location')
  // The real file behind the link is untouched.
  assert.equal(await readFile(join(outside, 'session.v4.jsonl.zstd'), 'utf8'), 'secret')
})

test('deleteSessionLog refuses an unsafe location without touching anything', async () => {
  const { root, sessionDir, sessionId } = await makeStore()
  // A log path outside the store cannot be resolved into a layout.
  const outside = await mkdtemp(join(tmpdir(), 'dsa-out-'))
  const result = await deleteSessionLog({
    sessionPersistence: persistenceFor(join(outside, 'a', 'b', 'session.v4.jsonl.zstd')),
    sessionRoot: root,
    sessionId,
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'unsafe-location')
  assert.equal(existsSync(sessionDir), true)
})

test('deleteSessionLog stops when beforeRemove vetoes', async () => {
  const { root, sessionDir, sessionId } = await makeStore()
  const result = await deleteSessionLog({
    sessionPersistence: persistenceFor(join(sessionDir, 'session.v4.jsonl.zstd')),
    sessionRoot: root,
    sessionId,
    beforeRemove: () => ({ ok: false, error: { code: 'session-reopened', message: 'reopened' } }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'session-reopened')
  assert.equal(existsSync(sessionDir), true, 'a vetoed deletion must leave the directory alone')
})

test('deleteSessionLog restores the directory when the move fails', async () => {
  const { root, sessionDir, sessionId } = await makeStore()
  const result = await deleteSessionLog({
    sessionPersistence: persistenceFor(join(sessionDir, 'session.v4.jsonl.zstd')),
    sessionRoot: root,
    sessionId,
    moveDirectory: async () => { throw new Error('locked') },
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'storage-error')
  assert.equal(existsSync(sessionDir), true)
})

test('deleteSessionLog reports storage-partial when cleanup does not finish', async () => {
  const { root, sessionDir, sessionId } = await makeStore()
  const result = await deleteSessionLog({
    sessionPersistence: persistenceFor(join(sessionDir, 'session.v4.jsonl.zstd')),
    sessionRoot: root,
    sessionId,
    // Simulate a remover that reports success but leaves the directory.
    removeDirectory: async () => {},
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'storage-partial')
})

test('deleteSessionLog refuses a session directory that is not a directory', async () => {
  // Exercises the layout validator without needing symlink support: the
  // "session directory" is a regular file, so the three-segment shape matches
  // but the filesystem check must reject it.
  const root = await mkdtemp(join(tmpdir(), 'dsa-store-'))
  const project = join(root, '--proj--')
  await mkdir(project, { recursive: true })
  const sessionDir = join(project, 'not-a-dir')
  await writeFile(sessionDir, 'i am a file')

  const result = await deleteSessionLog({
    sessionPersistence: persistenceFor(join(sessionDir, 'session.v4.jsonl.zstd')),
    sessionRoot: root,
    sessionId: 'not-a-dir',
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'unsafe-location')
  assert.equal(existsSync(sessionDir), true, 'the file must be left alone')
  assert.equal(await readFile(sessionDir, 'utf8'), 'i am a file')
})

test('deleteSessionLog refuses a log path whose leaf is not a session log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsa-store-'))
  const project = join(root, '--proj--')
  const sessionDir = join(project, 'sess')
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'notes.txt'), 'unrelated')

  const result = await deleteSessionLog({
    sessionPersistence: persistenceFor(join(sessionDir, 'notes.txt')),
    sessionRoot: root,
    sessionId: 'sess',
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'unsafe-location')
  assert.equal(existsSync(sessionDir), true)
})

test('deleteSessionLog refuses a log whose resolved path escapes the store', async () => {
  // A backend that reports a path under the root, but which resolves elsewhere
  // through a directory link, must not have that target deleted.
  const root = await mkdtemp(join(tmpdir(), 'dsa-store-'))
  const elsewhere = await mkdtemp(join(tmpdir(), 'dsa-elsewhere-'))
  await writeFile(join(elsewhere, 'session.v4.jsonl.zstd'), 'secret')

  const result = await deleteSessionLog({
    // Shape is valid (three segments, session log leaf) but the directories do
    // not exist under the root, so validation must refuse.
    sessionPersistence: persistenceFor(join(root, 'ghost', 'sess', 'session.v4.jsonl.zstd')),
    sessionRoot: root,
    sessionId: 'sess',
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'unsafe-location')
  assert.equal(await readFile(join(elsewhere, 'session.v4.jsonl.zstd'), 'utf8'), 'secret')
})

test('deleteSessionLog refuses a different persistence backend by name', async () => {
  // The layout this module removes is the JSONL backend's. A backend that names
  // itself and is not that one must be refused explicitly, not probed with
  // directory surgery (which would report a misleading "unsafe location").
  const { root, sessionDir, sessionId } = await makeStore()
  const result = await deleteSessionLog({
    sessionPersistence: {
      name: 'session-persistence-sqlite',
      resolveCurrentLog: async () => join(sessionDir, 'session.v4.jsonl.zstd'),
    },
    sessionRoot: root,
    sessionId,
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'unsupported-backend')
  assert.match(result.error.message, /session-persistence-sqlite/)
  assert.equal(existsSync(sessionDir), true, 'an unsupported backend must leave storage alone')
})

test('deleteSessionLog accepts the JSONL backend by name', async () => {
  const { root, sessionDir, sessionId } = await makeStore()
  const result = await deleteSessionLog({
    sessionPersistence: {
      name: 'session-persistence-jsonl',
      resolveCurrentLog: async () => join(sessionDir, 'session.v4.jsonl.zstd'),
    },
    sessionRoot: root,
    sessionId,
  })
  assert.equal(result.ok, true)
  assert.equal(existsSync(sessionDir), false)
})

test('deleteSessionLog rejects an invalid session id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsa-store-'))
  for (const bad of [undefined, '', 42, 'a\0b']) {
    const result = await deleteSessionLog({
      sessionPersistence: {}, sessionRoot: root, sessionId: bad,
    })
    assert.equal(result.ok, false, String(bad))
    assert.equal(result.error.code, 'invalid-session-id')
  }
})

test('quiesceSession is a no-op when the session is not live', async () => {
  const result = await quiesceSession({
    agents: { get: () => undefined },
    sessions: { get: () => undefined },
    sessionId: 's1',
  })
  assert.equal(result.ok, true)
  assert.equal(result.stopped, false)
})

test('quiesceSession cancels a running turn and disposes through the handle', async () => {
  let cancelled = 0
  let live = true
  let disposed = 0
  const agent = {
    get status() { return live ? 'running' : 'idle' },
    cancel: cause => { cancelled++; assert.equal(cause.kind, 'user'); live = false },
  }
  let clock = 0
  const result = await quiesceSession({
    agents: { get: () => (live ? agent : undefined) },
    sessions: { get: () => (live ? { id: 's1' } : undefined) },
    // The handle is what actually unregisters the agent.
    handles: {
      dispose: async id => {
        disposed++
        assert.equal(id, 's1')
        live = false
        return true
      },
    },
    sessionId: 's1',
    now: () => clock,
    wait: async ms => { clock += ms },
  })
  assert.equal(result.ok, true)
  assert.equal(result.stopped, true)
  assert.equal(cancelled, 1)
  assert.equal(disposed, 1, 'the turn is cancelled BEFORE the handle is disposed')
})

test('quiesceSession disposes an idle open session without cancelling it', async () => {
  // The reported bug: an open session is live and idle. Nothing is running, yet
  // it must still be removable — the dispatcher tears it down via the handle.
  let live = true
  let cancelled = 0
  let disposed = 0
  let clock = 0
  const result = await quiesceSession({
    agents: { get: () => (live ? { status: 'idle', cancel: () => { cancelled++ } } : undefined) },
    sessions: { get: () => (live ? { id: 's1' } : undefined) },
    handles: { dispose: async () => { disposed++; live = false; return true } },
    sessionId: 's1',
    now: () => clock,
    wait: async ms => { clock += ms },
  })
  assert.equal(result.ok, true)
  assert.equal(disposed, 1)
  assert.equal(cancelled, 0, 'an idle session has no turn to cancel')
})

test('quiesceSession refuses when a running turn cannot be cancelled', async () => {
  const result = await quiesceSession({
    // A live agent with no cancel implementation.
    agents: { get: () => ({ status: 'running' }) },
    sessions: { get: () => ({ id: 's1' }) },
    sessionId: 's1',
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'lifecycle-unavailable')
})

test('quiesceSession explains a missing handle instead of blaming a running turn', async () => {
  // No handle captured (the agent predates the tracker) and it never leaves:
  // the message must tell the user to restart, not to "stop it and retry".
  let clock = 0
  const result = await quiesceSession({
    agents: { get: () => ({ status: 'idle' }) },
    sessions: { get: () => ({ id: 's1' }) },
    handles: { dispose: async () => false },
    sessionId: 's1',
    timeoutMs: 300,
    now: () => clock,
    wait: async ms => { clock += ms },
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'lifecycle-unavailable')
})

test('quiesceSession reports still-live when a successful dispose does not settle', async () => {
  let clock = 0
  const result = await quiesceSession({
    // The handle was disposed, but the registry never drained.
    agents: { get: () => ({ status: 'idle' }) },
    sessions: { get: () => ({ id: 's1' }) },
    handles: { dispose: async () => true },
    sessionId: 's1',
    timeoutMs: 300,
    now: () => clock,
    wait: async ms => { clock += ms },
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'session-still-live')
})

test('quiesceSession reports a lifecycle error when dispose throws', async () => {
  const result = await quiesceSession({
    agents: { get: () => ({ status: 'idle' }) },
    sessions: { get: () => ({ id: 's1' }) },
    handles: { dispose: async () => { throw new Error('boom') } },
    sessionId: 's1',
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'lifecycle-error')
})
