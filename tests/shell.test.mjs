import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  attributeByCreationWindow,
  collectShellWindows,
  listWorkspaceFiles,
  mergeWindows,
  otherWindowsOf,
} from '../src/host/shell.mjs'
import { discoverSessionArtifacts } from '../src/host/artifacts.mjs'

const call = (callId, name, args, time) => ({ type: 'tool/call', time, data: { callId, name, arguments: JSON.stringify(args) } })
const result = (callId, time) => ({ type: 'tool/result', time, data: { message: { toolCallId: callId, isError: false } } })

test('collectShellWindows pairs a shell call with its result', () => {
  const windows = collectShellWindows([
    call('c1', 'pwsh', { command: 'python x.py' }, 1000),
    result('c1', 5000),
    call('c2', 'read', { file_path: '/w/a' }, 6000),
    result('c2', 6100),
  ])
  assert.deepEqual(windows, [{ start: 1000, end: 5000 }])
})

test('collectShellWindows ignores a call with no recorded result', () => {
  // Without an end time the window is unknown, so it must not become a claim.
  assert.deepEqual(collectShellWindows([call('c1', 'pwsh', { command: 'x' }, 1000)]), [])
})

test('collectShellWindows records every shell tool, not just pwsh', () => {
  const windows = collectShellWindows([
    call('c1', 'bash', { command: 'x' }, 10),
    result('c1', 20),
    call('c2', 'shell', { command: 'y' }, 30),
    result('c2', 40),
  ])
  assert.deepEqual(windows, [{ start: 10, end: 20 }, { start: 30, end: 40 }])
})

test('mergeWindows joins overlapping and near-adjacent windows', () => {
  assert.deepEqual(
    mergeWindows([{ start: 0, end: 100 }, { start: 50, end: 200 }, { start: 100000, end: 100100 }], 2000),
    [{ start: 0, end: 200 }, { start: 100000, end: 100100 }],
  )
  // A gap wider than the threshold stays separate.
  assert.equal(mergeWindows([{ start: 0, end: 10 }, { start: 9000, end: 9010 }], 2000).length, 2)
})

test('otherWindowsOf excludes the own session', () => {
  const map = new Map([
    ['me', [{ start: 0, end: 10 }]],
    ['other', [{ start: 20, end: 30 }]],
  ])
  assert.deepEqual(otherWindowsOf(map, 'me'), [{ start: 20, end: 30 }])
})

test('a file born inside the window is attributed; one born outside is not', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dsa-shell-'))
  const file = join(ws, 'created-now.py')
  await writeFile(file, 'a')

  const now = Date.now()
  // `birthtime` is immutable on NTFS, so a file cannot be backdated. Instead
  // move the *window* into the past: the file is then genuinely outside it.
  const mine = [{ start: now - 86_400_000, end: now - 86_390_000 }]
  const outside = await attributeByCreationWindow({
    mine, others: [], files: [file], slackMs: 5000,
  })
  assert.deepEqual(outside.created, [])

  // The same file with a window that contains its creation time is attributed.
  const inside = await attributeByCreationWindow({
    mine: [{ start: now - 60_000, end: now }], others: [], files: [file], slackMs: 5000,
  })
  assert.deepEqual(inside.created, [file])
  assert.deepEqual(inside.ambiguous, [])
})

test('a file two sessions could have created is claimed by neither', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dsa-shell-'))
  const shared = join(ws, 'shared.py')
  await writeFile(shared, 'x')
  const now = Date.now()
  const mine = [{ start: now - 60_000, end: now }]
  const others = [{ start: now - 30_000, end: now + 1000 }]
  const { created, ambiguous } = await attributeByCreationWindow({
    mine, others, files: [shared], slackMs: 5000,
  })
  assert.deepEqual(created, [])
  assert.deepEqual(ambiguous, [shared])
})

test('a file created after the last command is not attributed', async () => {
  // The real case this rule exists for: a session runs two short commands and
  // then spends twenty minutes on web fetches while another process writes.
  const ws = await mkdtemp(join(tmpdir(), 'dsa-shell-'))
  const file = join(ws, 'later.py')
  await writeFile(file, 'x')
  const now = Date.now()
  const mine = [{ start: now - 600_000, end: now - 590_000 }]
  const { created } = await attributeByCreationWindow({
    mine, others: [], files: [file], slackMs: 5000,
  })
  assert.deepEqual(created, [])
})

test('listWorkspaceFiles prunes dependency and build directories', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dsa-walk-'))
  await mkdir(join(ws, 'node_modules', 'pkg'), { recursive: true })
  await mkdir(join(ws, '__pycache__'), { recursive: true })
  await mkdir(join(ws, 'src'), { recursive: true })
  await writeFile(join(ws, 'node_modules', 'pkg', 'index.js'), 'x')
  await writeFile(join(ws, '__pycache__', 'm.pyc'), 'x')
  await writeFile(join(ws, 'src', 'app.py'), 'x')
  await writeFile(join(ws, 'top.py'), 'x')

  const { files, skippedDirs } = await listWorkspaceFiles({ root: ws, workspace: ws })
  const names = files.map(f => f.replace(ws, '').replace(/\\/g, '/')).sort()
  assert.deepEqual(names, ['/src/app.py', '/top.py'])
  assert.ok(skippedDirs.some(d => d.reason === 'pruned:node_modules'))
  assert.ok(skippedDirs.some(d => d.reason === 'pruned:__pycache__'))
})

test('listWorkspaceFiles never descends into a package the session built', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dsa-walk-'))
  const plugin = join(ws, 'my-plugin')
  await mkdir(plugin, { recursive: true })
  await writeFile(join(plugin, 'cordis.patch.yml'), '- insert: []')
  await writeFile(join(plugin, 'src.mjs'), 'x')
  await writeFile(join(ws, 'scratch.py'), 'x')

  const { files, skippedDirs } = await listWorkspaceFiles({ root: ws, workspace: ws })
  assert.deepEqual(files.map(f => f.replace(ws, '')).map(f => f.replace(/\\/g, '/')), ['/scratch.py'])
  assert.ok(skippedDirs.some(d => d.reason.startsWith('inside-package')))
})

test('discovery claims nothing when the sibling set cannot be enumerated', async () => {
  // Fail closed: without the other sessions' windows, uniqueness is unprovable.
  const ws = await mkdtemp(join(tmpdir(), 'dsa-failclosed-'))
  const file = join(ws, 'made-by-shell.py')
  await writeFile(file, 'x')
  const now = Date.now()

  const events = [
    call('c1', 'pwsh', { command: 'python make.py' }, now - 2000),
    result('c1', now - 1000),
  ]
  const sessionPersistence = {
    open: async () => ({
      header: { cwd: ws, createdAt: now - 5000 }, read: async () => ({ events }), close: async () => {},
    }),
  }

  const result1 = await discoverSessionArtifacts(
    { sessionPersistence, sessionRoot: join(ws, '..', '.dsh-none', 'sessions'), dshHome: join(ws, '..', '.dsh-none') },
    's1',
  )
  assert.equal(result1.shell.complete, false)
  assert.equal(result1.shell.declined, 'sibling-windows-unavailable')
  assert.deepEqual(result1.files, [])
  assert.equal(result1.shell.attributed, 0)
})

test('discovery attributes a shell-created file once siblings are enumerable', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dsa-shellok-'))
  const file = join(ws, 'made-by-shell.py')
  await writeFile(file, 'x')
  const now = Date.now()

  const events = [
    call('c1', 'pwsh', { command: 'python make.py' }, now - 2000),
    result('c1', now - 1000),
  ]
  const sessionPersistence = {
    open: async id => ({
      header: { id, cwd: ws, createdAt: now - 5000 },
      read: async () => ({ events: id === 's1' ? events : [] }),
      close: async () => {},
    }),
    list: async () => [{ header: { id: 's1', cwd: ws } }, { header: { id: 's2', cwd: ws } }],
  }

  const disc = await discoverSessionArtifacts(
    {
      sessionPersistence,
      // The session store must not be the workspace itself, or every candidate
      // would be fenced as `inside-session-store`.
      sessionRoot: join(ws, '..', '.dsh-none', 'sessions'),
      dshHome: join(ws, '..', '.dsh-none'),
      listSessions: () => sessionPersistence.list(),
    },
    's1',
  )
  assert.equal(disc.shell.complete, true)
  assert.equal(disc.shell.siblings, 1)
  assert.deepEqual(disc.files.map(f => f.display), ['made-by-shell.py'])
  assert.equal(disc.files[0].tool, 'shell')
})

test('includeShell false skips the creation-window pass entirely', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dsa-noshell-'))
  await writeFile(join(ws, 'made-by-shell.py'), 'x')
  const now = Date.now()
  const events = [call('c1', 'pwsh', { command: 'x' }, now - 2000), result('c1', now - 1000)]
  const sessionPersistence = {
    open: async id => ({ header: { id, cwd: ws }, read: async () => ({ events }), close: async () => {} }),
    list: async () => [{ header: { id: 's1', cwd: ws } }],
  }
  const disc = await discoverSessionArtifacts(
    {
      sessionPersistence, sessionRoot: join(ws, '..', '.dsh-none', 'sessions'), dshHome: join(ws, '..', '.dsh-none'),
      includeShell: false, listSessions: () => sessionPersistence.list(),
    },
    's1',
  )
  assert.equal(disc.shell.enabled, false)
  assert.deepEqual(disc.files, [])
})

