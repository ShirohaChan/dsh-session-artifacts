import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  classifyCandidate,
  collectArtifactCandidates,
  discoverSessionArtifacts,
  resolveArtifacts,
  resolveDshHome,
} from '../src/host/artifacts.mjs'
import { removeArtifacts } from '../src/host/remove.mjs'

const call = (callId, name, args) => ({ type: 'tool/call', data: { callId, name, arguments: JSON.stringify(args) } })
const result = (callId, meta, extra = {}) => ({
  type: 'tool/result',
  data: { message: { toolCallId: callId, isError: false }, ...(meta ? { meta } : {}), ...extra },
})
const failed = (callId, code) => ({
  type: 'tool/result',
  data: { message: { toolCallId: callId, isError: true }, error: { name: 'Error', code } },
})

/** A Session store path shaped like the shipped layout, so the home fence derives. */
const storeUnder = home => join(home, 'sessions')

test('a successful write with operation=create is a created artifact', () => {
  const { created, updated } = collectArtifactCandidates([
    call('c1', 'write', { file_path: '/w/report.md' }),
    result('c1', { operation: 'create' }),
  ])
  assert.deepEqual([...created.keys()], ['/w/report.md'])
  assert.equal(updated.size, 0)
})

test('a write with operation=update is never treated as created', () => {
  const { created, updated } = collectArtifactCandidates([
    call('c1', 'write', { file_path: '/w/existing.md' }),
    result('c1', { operation: 'update' }),
  ])
  assert.equal(created.size, 0)
  assert.deepEqual([...updated.keys()], ['/w/existing.md'])
})

test('edit alone never establishes authorship', () => {
  const { created, updated } = collectArtifactCandidates([
    call('c1', 'edit', { file_path: '/w/user-file.md', old_string: 'a', new_string: 'b' }),
    result('c1', undefined),
  ])
  assert.equal(created.size, 0)
  assert.deepEqual([...updated.keys()], ['/w/user-file.md'])
})

test('a failed write contributes nothing', () => {
  for (const code of ['FS_SANDBOX_DENIED', 'FS_NOT_OBSERVED', 'FS_STALE_VERSION']) {
    const { created, updated } = collectArtifactCandidates([
      call('c1', 'write', { file_path: '/w/x.md' }),
      failed('c1', code),
    ])
    assert.equal(created.size, 0, code)
    assert.equal(updated.size, 0, code)
  }
})

test('a create followed by an edit stays a created artifact', () => {
  const { created, updated } = collectArtifactCandidates([
    call('c1', 'write', { file_path: '/w/out.md' }),
    result('c1', { operation: 'create' }),
    call('c2', 'edit', { file_path: '/w/out.md', old_string: 'a', new_string: 'b' }),
    result('c2', undefined),
  ])
  assert.deepEqual([...created.keys()], ['/w/out.md'])
  assert.equal(updated.size, 0)
})

test('present is recorded as delivered, never as created', () => {
  // `present` records a hand-off, not authorship: a file the user supplied to
  // the Session must not become deletable just because it was delivered.
  const { created, delivered, updated } = collectArtifactCandidates([
    call('c1', 'present', { files: [{ path: '/w/user-supplied.md', description: 'x' }] }),
    result('c1', undefined),
  ])
  assert.equal(created.size, 0)
  assert.equal(updated.size, 0)
  assert.deepEqual([...delivered.keys()], ['/w/user-supplied.md'])
  assert.equal(delivered.get('/w/user-supplied.md').delivered, true)
})

test('a path both created and presented stays a created artifact', () => {
  const { created, delivered } = collectArtifactCandidates([
    call('c1', 'write', { file_path: '/w/mine.md' }),
    result('c1', { operation: 'create' }),
    call('c2', 'present', { files: [{ path: '/w/mine.md' }] }),
    result('c2', undefined),
  ])
  assert.deepEqual([...created.keys()], ['/w/mine.md'])
  assert.equal(delivered.size, 0)
})

test('non-mutating tools and malformed events are ignored', () => {
  const { created, updated, delivered } = collectArtifactCandidates([
    call('c1', 'read', { file_path: '/w/read-only.md' }),
    result('c1', undefined),
    { type: 'tool/call', data: { callId: 'c2', name: 'write', arguments: 'not json' } },
    result('c2', { operation: 'create' }),
    null,
    { type: 'turn/end', data: {} },
  ])
  assert.equal(created.size, 0)
  assert.equal(updated.size, 0)
  assert.equal(delivered.size, 0)
})

test('the workspace fence rejects paths outside the session workspace', () => {
  const cwd = process.platform === 'win32' ? 'C:\\ws' : '/ws'
  const inside = process.platform === 'win32' ? 'C:\\ws\\a.md' : '/ws/a.md'
  const outside = process.platform === 'win32' ? 'C:\\other\\a.md' : '/other/a.md'
  assert.equal(classifyCandidate({ cwd, path: inside }).allowed, true)
  assert.equal(classifyCandidate({ cwd, path: outside }).reason, 'outside-workspace')
  assert.equal(classifyCandidate({ cwd, path: cwd }).reason, 'is-workspace-root')
  assert.equal(classifyCandidate({ cwd: undefined, path: inside }).reason, 'session-has-no-cwd')
})

test('the session store and explicit excludes are refused', () => {
  const cwd = process.platform === 'win32' ? 'C:\\ws' : '/ws'
  const store = join(cwd, '.dsh-store')
  const log = join(store, 'p', 's', 'session.v4.jsonl')
  assert.equal(classifyCandidate({ cwd, sessionRoot: store, path: log }).reason, 'inside-session-store')

  const plugins = join(cwd, 'node_modules')
  const installed = join(plugins, 'some-plugin', 'index.js')
  assert.equal(classifyCandidate({ cwd, path: installed, extraExcludes: [plugins] }).reason, 'excluded')
})

test('the DSH home is refused even when the session cwd is a broad directory', () => {
  const home = process.platform === 'win32' ? 'C:\\Users\\me\\.dsh' : '/home/me/.dsh'
  const broadCwd = process.platform === 'win32' ? 'C:\\Users\\me' : '/home/me'
  const sessionRoot = storeUnder(home)

  // With a home-rooted cwd the workspace fence alone would allow all of these.
  const cases = [
    join(home, 'plugins', 'dsh-session-artifacts', 'src', 'index.js'),
    join(home, 'skills', 'reflect-and-capture', 'SKILL.md'),
    join(home, 'profiles', 'desktop', 'cordis.patch.yml'),
    join(home, '.credentials.yaml'),
    home,
  ]
  for (const path of cases) {
    assert.equal(
      classifyCandidate({ cwd: broadCwd, sessionRoot, dshHome: home, path }).reason,
      'inside-dsh-home',
      path,
    )
  }

  // A workspace rooted at the home itself is still refused its own state.
  assert.equal(
    classifyCandidate({ cwd: home, sessionRoot, dshHome: home, path: join(home, 'plugins', 'x.js') }).reason,
    'inside-dsh-home',
  )
})

test('the DSH home is derived from a shipped session store, and config wins', () => {
  const home = process.platform === 'win32' ? 'C:\\Users\\me\\.dsh' : '/home/me/.dsh'
  const saved = process.env.DSH_HOME
  try {
    delete process.env.DSH_HOME
    // The shipped `<home>/sessions` layout yields the home.
    assert.equal(resolveDshHome({ sessionRoot: storeUnder(home) }), home)
    // A store somewhere else must NOT turn its parent into a blanket exclusion.
    assert.equal(resolveDshHome({ sessionRoot: join(home, 'elsewhere') }), undefined)
    // An explicit config beats every other source.
    assert.equal(resolveDshHome({ dshHome: join(home, 'x'), sessionRoot: storeUnder(home) }), join(home, 'x'))
    process.env.DSH_HOME = home
    assert.equal(resolveDshHome({ sessionRoot: join(home, 'elsewhere') }), home)
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})

test('a workspace nested inside the DSH home still owns its own files', () => {
  const home = process.platform === 'win32' ? 'C:\\Users\\me\\.dsh' : '/home/me/.dsh'
  const scratch = join(home, 'scratch')
  const sessionRoot = storeUnder(home)
  assert.equal(
    classifyCandidate({ cwd: scratch, sessionRoot, dshHome: home, path: join(scratch, 'out.md') }).allowed,
    true,
  )
  // ...but it still cannot reach its neighbours under the same home.
  assert.equal(
    classifyCandidate({ cwd: scratch, sessionRoot, dshHome: home, path: join(home, 'plugins', 'x.js') }).reason,
    'inside-dsh-home',
  )
})

test('a cross-drive path is refused rather than treated as inside the workspace', () => {
  if (process.platform !== 'win32') return
  // `relative()` returns an absolute path across drives; a fence that only
  // checks for a leading ".." would read that as "inside".
  const cwd = 'C:\\ws'
  assert.equal(classifyCandidate({ cwd, path: 'D:\\other\\a.md' }).reason, 'outside-workspace')
})

test('discovery reports existing files with sizes and skips the rest', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dsa-ws-'))
  await mkdir(join(ws, 'sub'), { recursive: true })
  await writeFile(join(ws, 'a.md'), 'hello')
  await writeFile(join(ws, 'sub', 'b.md'), 'world!')

  const candidates = new Map([
    [join(ws, 'a.md'), { path: join(ws, 'a.md'), tool: 'write' }],
    [join(ws, 'sub', 'b.md'), { path: join(ws, 'sub', 'b.md'), tool: 'write' }],
    [join(ws, 'missing.md'), { path: join(ws, 'missing.md'), tool: 'write' }],
  ])
  const { files, skipped } = await resolveArtifacts({ candidates, cwd: ws, dshHome: join(ws, '..', '.dsh-none') })
  assert.deepEqual(files.map(f => f.display), ['a.md', 'sub/b.md'])
  assert.equal(files[0].bytes, 5)
  assert.equal(files[1].bytes, 6)
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].reason, 'already-gone')
})

test('a relative candidate resolves against the session cwd, not the host cwd', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dsa-ws-'))
  await writeFile(join(ws, 'report.md'), 'in workspace')
  const candidates = new Map([['report.md', { path: 'report.md', tool: 'write' }]])
  const { files } = await resolveArtifacts({ candidates, cwd: ws, dshHome: join(ws, '..', '.dsh-none') })
  assert.equal(files.length, 1)
  assert.equal(files[0].path, join(ws, 'report.md'))
})

test('a plugin or skill package inside the workspace is not offered', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dsa-ws-'))
  const dshHome = join(ws, '..', '.dsh-none')
  const plugin = join(ws, 'my-plugin')
  const skill = join(ws, 'my-skill')
  const scratch = join(ws, 'scratch')
  await mkdir(plugin, { recursive: true })
  await mkdir(skill, { recursive: true })
  await mkdir(scratch, { recursive: true })
  await writeFile(join(plugin, 'cordis.patch.yml'), '- insert: []')
  await writeFile(join(plugin, 'src.mjs'), 'export const x = 1')
  await writeFile(join(skill, 'SKILL.md'), '# skill')
  await writeFile(join(skill, 'helper.mjs'), 'export const y = 1')
  await writeFile(join(scratch, 'out.md'), 'scratch')

  const candidates = new Map([
    [join(plugin, 'src.mjs'), { path: join(plugin, 'src.mjs'), tool: 'write' }],
    [join(skill, 'helper.mjs'), { path: join(skill, 'helper.mjs'), tool: 'write' }],
    [join(scratch, 'out.md'), { path: join(scratch, 'out.md'), tool: 'write' }],
  ])
  const { files, skipped } = await resolveArtifacts({ candidates, cwd: ws, dshHome })
  assert.deepEqual(files.map(f => f.display), ['scratch/out.md'])
  assert.deepEqual(skipped.map(s => s.reason).sort(), ['inside-package:SKILL.md', 'inside-package:cordis.patch.yml'])
})

test('package protection can be turned off', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dsa-ws-'))
  const plugin = join(ws, 'my-plugin')
  await mkdir(plugin, { recursive: true })
  await writeFile(join(plugin, 'cordis.patch.yml'), '- insert: []')
  await writeFile(join(plugin, 'src.mjs'), 'export const x = 1')
  const candidates = new Map([[join(plugin, 'src.mjs'), { path: join(plugin, 'src.mjs'), tool: 'write' }]])
  const { files } = await resolveArtifacts({
    candidates, cwd: ws, dshHome: join(ws, '..', '.dsh-none'), protectPackages: false,
  })
  assert.equal(files.length, 1)
})

test('a symlink pointing outside the workspace is never offered', async (t) => {
  const ws = await mkdtemp(join(tmpdir(), 'dsa-ws-'))
  const outside = await mkdtemp(join(tmpdir(), 'dsa-out-'))
  await writeFile(join(outside, 'secret.txt'), 'private')
  const link = join(ws, 'link.txt')
  try {
    await symlink(join(outside, 'secret.txt'), link, 'file')
  } catch {
    t.skip('symlink creation unavailable')
    return
  }
  const candidates = new Map([[link, { path: link, tool: 'write' }]])
  const { files, skipped } = await resolveArtifacts({ candidates, cwd: ws, dshHome: join(ws, '..', '.dsh-none') })
  assert.equal(files.length, 0)
  assert.equal(skipped[0].reason, 'symlink-escapes-workspace')
})

test('removal deletes previewed files, prunes emptied directories, and reports bytes', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dsa-ws-'))
  await mkdir(join(ws, 'nested', 'deep'), { recursive: true })
  const a = join(ws, 'a.md')
  const b = join(ws, 'nested', 'deep', 'b.md')
  await writeFile(a, 'hello')
  await writeFile(b, 'world!')

  const { removed, failed, bytes, retry } = await removeArtifacts([
    { path: a, bytes: 5 },
    { path: b, bytes: 6 },
  ], { cwd: ws, dshHome: join(ws, '..', '.dsh-none') })

  assert.equal(failed.length, 0)
  assert.equal(removed.length, 2)
  assert.equal(bytes, 11)
  assert.equal(retry.length, 0)
  assert.equal(existsSync(a), false)
  assert.equal(existsSync(b), false)
  // The now-empty directory chain is pruned, but the workspace itself stays.
  assert.equal(existsSync(join(ws, 'nested')), false)
  assert.equal(existsSync(ws), true)
})

test('removal refuses a file whose size changed since the preview, and offers it for retry', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dsa-ws-'))
  const a = join(ws, 'a.md')
  await writeFile(a, 'hello')
  const entry = { path: a, bytes: 999 }
  const { removed, failed, retry } = await removeArtifacts([entry], { cwd: ws, dshHome: join(ws, '..', '.dsh-none') })
  assert.equal(removed.length, 0)
  assert.equal(failed[0].reason, 'size-changed-since-preview')
  // The file is still there and still ours to remove, so it stays retryable.
  // The retry entry re-baselines the size (the preview size is stale by
  // definition) and pins the file identity instead.
  assert.equal(retry.length, 1)
  assert.equal(retry[0].path, a)
  assert.equal(retry[0].bytes, 5)
  assert.equal(typeof retry[0].ino, 'string')
  assert.equal(await readFile(a, 'utf8'), 'hello')
})

test('a retry entry refuses a path swapped for a different file', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dsa-ws-'))
  const dshHome = join(ws, '..', '.dsh-none')
  const a = join(ws, 'a.md')
  await writeFile(a, 'hello')

  // First pass: the size moved, so the entry becomes retryable with a pin.
  const first = await removeArtifacts([{ path: a, bytes: 999 }], { cwd: ws, dshHome })
  assert.equal(first.retry.length, 1)

  // The path is replaced by a different file of the same size before the retry.
  const { rm } = await import('node:fs/promises')
  await rm(a)
  await writeFile(a, 'world')

  const second = await removeArtifacts(first.retry, { cwd: ws, dshHome })
  assert.equal(second.removed.length, 0)
  assert.equal(second.failed[0].reason, 'identity-changed-since-preview')
  assert.equal(await readFile(a, 'utf8'), 'world')
})

test('removal never deletes outside the workspace', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dsa-ws-'))
  const outside = await mkdtemp(join(tmpdir(), 'dsa-out-'))
  const secret = join(outside, 'keep.txt')
  await writeFile(secret, 'keep me')
  const { removed, failed, retry } = await removeArtifacts(
    [{ path: secret, bytes: 7 }],
    { cwd: ws, dshHome: join(ws, '..', '.dsh-none') },
  )
  assert.equal(removed.length, 0)
  assert.equal(failed[0].reason, 'outside-workspace')
  // A refused path will not become acceptable on a retry.
  assert.equal(retry.length, 0)
  assert.equal(await readFile(secret, 'utf8'), 'keep me')
})

test('removal refuses anything under the DSH home even from a broad workspace', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-home-'))
  const plugins = join(home, 'plugins')
  await mkdir(plugins, { recursive: true })
  const installed = join(plugins, 'a-plugin.js')
  await writeFile(installed, 'module.exports = 1')
  const { removed, failed } = await removeArtifacts(
    [{ path: installed, bytes: 19 }],
    { cwd: home, sessionRoot: storeUnder(home), dshHome: home },
  )
  assert.equal(removed.length, 0)
  assert.equal(failed[0].reason, 'inside-dsh-home')
  assert.equal(existsSync(installed), true)
})

test('a directory is never removed as an artifact', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dsa-ws-'))
  const dir = join(ws, 'adir')
  await mkdir(dir)
  const { files, skipped } = await resolveArtifacts({
    candidates: new Map([[dir, { path: dir, tool: 'write' }]]),
    cwd: ws,
    dshHome: join(ws, '..', '.dsh-none'),
  })
  assert.equal(files.length, 0)
  assert.equal(skipped[0].reason, 'is-directory')
})

test('discovery keeps delivered-only files out unless they are opted in', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dsa-ws-'))
  await writeFile(join(ws, 'delivered.md'), 'user file')
  await writeFile(join(ws, 'created.md'), 'session file')
  const events = [
    call('c1', 'present', { files: [{ path: join(ws, 'delivered.md') }] }),
    result('c1', undefined),
    call('c2', 'write', { file_path: join(ws, 'created.md') }),
    result('c2', { operation: 'create' }),
  ]
  const sessionPersistence = {
    open: async () => ({
      header: { cwd: ws }, read: async () => ({ events }), close: async () => {},
    }),
  }
  const base = { sessionPersistence, sessionRoot: join(ws, '..', '.dsh-none'), dshHome: join(ws, '..', '.dsh-none') }

  const strict = await discoverSessionArtifacts(base, 's1')
  assert.deepEqual(strict.files.map(f => f.display), ['created.md'])
  assert.equal(strict.delivered, 1)

  const opted = await discoverSessionArtifacts({ ...base, includeDelivered: true }, 's1')
  assert.deepEqual(opted.files.map(f => f.display).sort(), ['created.md', 'delivered.md'])
})
