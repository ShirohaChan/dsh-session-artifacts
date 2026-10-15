import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createArtifactHandlers, createPreviewStore, hostRequestFence, sameOriginRequest } from '../src/index.js'

/** Minimal req/res doubles for the HTTP boundary. */
const makeReq = options => {
  const {
    body, action = 'preview-artifacts', method = 'POST', origin, host = '127.0.0.1:19387',
    contentType = 'application/json',
  } = options
  const headers = { host }
  // `action: undefined` must mean "send no action header", so the key is added
  // conditionally rather than through a destructuring default.
  if (options.action !== undefined || !('action' in options)) headers['x-dsh-session-artifacts-action'] = action
  if (origin !== undefined) headers.origin = origin
  if (contentType !== null) headers['content-type'] = contentType
  const chunks = [Buffer.from(JSON.stringify(body ?? {}))]
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
    once() {}, off() {},
  }
}

const makeRes = () => {
  const res = { status: undefined, body: undefined, headers: undefined }
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers }
  res.end = payload => { res.body = payload === undefined ? undefined : JSON.parse(payload) }
  return res
}

const alwaysTrusted = () => true

test('the preview store hands out single-use nonces and expires them', () => {
  let clock = 1000
  const store = createPreviewStore({ ttlMs: 100, now: () => clock })
  const nonce = store.put({ cwd: '/ws', files: [{ path: '/ws/a.md', bytes: 1 }] })
  assert.match(nonce, /^[0-9a-f-]{36}$/)

  // A second take must fail: the nonce is consumed on first use.
  assert.ok(store.take(nonce))
  assert.equal(store.take(nonce), undefined)

  const expiring = store.put({ cwd: '/ws', files: [] })
  clock += 101
  assert.equal(store.take(expiring), undefined)
})

test('the preview store caps its size', () => {
  const store = createPreviewStore({ max: 2 })
  const a = store.put({ files: [] })
  store.put({ files: [] })
  store.put({ files: [] })
  assert.equal(store.size, 2)
  assert.equal(store.take(a), undefined)
})

test('preview reports the artifact set and issues a nonce', async () => {
  const previews = createPreviewStore()
  const handlers = createArtifactHandlers({
    discover: async () => ({
      header: { cwd: '/ws' },
      files: [{ path: '/ws/a.md', display: 'a.md', bytes: 5, tool: 'write', delivered: false }],
      skipped: [],
      created: 1,
      updated: 0,
    }),
    remove: async () => ({ removed: [], failed: [], bytes: 0 }),
    previews,
    isTrustedRequest: alwaysTrusted,
  })

  const res = makeRes()
  await handlers.preview(makeReq({ body: { sessionId: 'session-1' } }), res)
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.value.total, 1)
  assert.equal(res.body.value.bytes, 5)
  assert.match(res.body.value.nonce, /^[0-9a-f-]{36}$/)
  // The response never leaks the absolute path to the client.
  assert.equal(JSON.stringify(res.body.value).includes('/ws/a.md'), false)
})

test('a session without a workspace reports an empty, non-removable preview', async () => {
  const previews = createPreviewStore()
  const handlers = createArtifactHandlers({
    discover: async () => ({ header: {}, files: [], skipped: [], created: 0, updated: 0 }),
    remove: async () => { throw new Error('must not run') },
    previews,
    isTrustedRequest: alwaysTrusted,
  })
  const res = makeRes()
  await handlers.preview(makeReq({ body: { sessionId: 'session-1' } }), res)
  assert.equal(res.status, 200)
  assert.equal(res.body.value.noWorkspace, true)
  assert.equal(res.body.value.nonce, undefined)
})

test('removal runs only with a nonce issued by a preview', async () => {
  const previews = createPreviewStore()
  let removedWith
  const handlers = createArtifactHandlers({
    discover: async () => ({
      header: { cwd: '/ws' },
      files: [{ path: '/ws/a.md', display: 'a.md', bytes: 5, tool: 'write' }],
      skipped: [], created: 1, updated: 0,
    }),
    remove: async entry => { removedWith = entry; return { removed: [{ path: '/ws/a.md', bytes: 5 }], failed: [], bytes: 5 } },
    previews,
    isTrustedRequest: alwaysTrusted,
  })

  // An invented nonce is refused.
  const bad = makeRes()
  await handlers.remove(makeReq({ action: 'delete-artifacts', body: { nonce: 'not-a-nonce' } }), bad)
  assert.equal(bad.status, 400)

  const forged = makeRes()
  await handlers.remove(makeReq({
    action: 'delete-artifacts',
    body: { nonce: '11111111-1111-1111-1111-111111111111' },
  }), forged)
  assert.equal(forged.status, 409)
  assert.equal(removedWith, undefined)

  // The real flow: preview, then remove with the issued nonce.
  const previewRes = makeRes()
  await handlers.preview(makeReq({ body: { sessionId: 'session-1' } }), previewRes)
  const { nonce } = previewRes.body.value

  const ok = makeRes()
  await handlers.remove(makeReq({ action: 'delete-artifacts', body: { nonce } }), ok)
  assert.equal(ok.status, 200)
  assert.equal(ok.body.value.bytes, 5)
  assert.equal(removedWith.cwd, '/ws')
  assert.equal(removedWith.files[0].path, '/ws/a.md')

  // Replaying the same nonce cannot remove anything twice.
  const replay = makeRes()
  await handlers.remove(makeReq({ action: 'delete-artifacts', body: { nonce } }), replay)
  assert.equal(replay.status, 409)
})

test('a partial removal issues a retry nonce covering only the leftovers', async () => {
  const previews = createPreviewStore()
  const handlers = createArtifactHandlers({
    discover: async () => ({
      header: { cwd: '/ws' },
      files: [
        { path: '/ws/ok.md', display: 'ok.md', bytes: 5, tool: 'write' },
        { path: '/ws/locked.md', display: 'locked.md', bytes: 6, tool: 'write' },
      ],
      skipped: [], created: 2, updated: 0,
    }),
    // The first pass removes one file and leaves the other behind.
    remove: async () => ({
      removed: [{ path: '/ws/ok.md', bytes: 5 }],
      failed: [{ path: '/ws/locked.md', reason: 'remove-failed' }],
      bytes: 5,
      retry: [{ path: '/ws/locked.md', bytes: 6 }],
    }),
    previews,
    isTrustedRequest: alwaysTrusted,
  })

  const previewRes = makeRes()
  await handlers.preview(makeReq({ body: { sessionId: 'session-1' } }), previewRes)
  const first = makeRes()
  await handlers.remove(makeReq({ action: 'delete-artifacts', body: { nonce: previewRes.body.value.nonce } }), first)

  assert.equal(first.status, 200)
  assert.match(first.body.value.retryNonce, /^[0-9a-f-]{36}$/)
  // The internal retry list is not part of the response contract.
  assert.equal('retry' in first.body.value, false)

  // The retry nonce resolves to exactly the leftover file.
  const entry = previews.take(first.body.value.retryNonce)
  assert.deepEqual(entry.files.map(f => f.path), ['/ws/locked.md'])
  assert.equal(entry.cwd, '/ws')
})

test('a fully successful removal issues no retry nonce', async () => {
  const previews = createPreviewStore()
  const handlers = createArtifactHandlers({
    discover: async () => ({
      header: { cwd: '/ws' },
      files: [{ path: '/ws/a.md', display: 'a.md', bytes: 5, tool: 'write' }],
      skipped: [], created: 1, updated: 0,
    }),
    remove: async () => ({
      removed: [{ path: '/ws/a.md', bytes: 5 }], failed: [], bytes: 5, retry: [],
    }),
    previews,
    isTrustedRequest: alwaysTrusted,
  })
  const previewRes = makeRes()
  await handlers.preview(makeReq({ body: { sessionId: 'session-1' } }), previewRes)
  const res = makeRes()
  await handlers.remove(makeReq({ action: 'delete-artifacts', body: { nonce: previewRes.body.value.nonce } }), res)
  assert.equal(res.status, 200)
  assert.equal(res.body.value.retryNonce, undefined)
  assert.equal(previews.size, 0)
})

test('the action header and content type are enforced', async () => {
  const previews = createPreviewStore()
  const handlers = createArtifactHandlers({
    discover: async () => ({ header: { cwd: '/ws' }, files: [], skipped: [], created: 0, updated: 0 }),
    remove: async () => ({ removed: [], failed: [], bytes: 0 }),
    previews,
    isTrustedRequest: alwaysTrusted,
  })

  const missingHeader = makeRes()
  await handlers.preview(makeReq({ action: undefined, body: { sessionId: 's' } }), missingHeader)
  assert.equal(missingHeader.status, 403)

  const wrongHeader = makeRes()
  await handlers.preview(makeReq({ action: 'delete-artifacts', body: { sessionId: 's' } }), wrongHeader)
  assert.equal(wrongHeader.status, 403)

  const wrongType = makeRes()
  await handlers.preview(makeReq({ body: { sessionId: 's' }, contentType: 'text/plain' }), wrongType)
  assert.equal(wrongType.status, 415)

  const wrongMethod = makeRes()
  await handlers.preview(makeReq({ body: { sessionId: 's' }, method: 'GET' }), wrongMethod)
  assert.equal(wrongMethod.status, 405)
})

test('an untrusted request is refused even with a valid action header', async () => {
  const previews = createPreviewStore()
  const handlers = createArtifactHandlers({
    discover: async () => { throw new Error('must not run') },
    remove: async () => { throw new Error('must not run') },
    previews,
    isTrustedRequest: () => false,
  })
  const res = makeRes()
  await handlers.preview(makeReq({ body: { sessionId: 'session-1' } }), res)
  assert.equal(res.status, 403)
})

test('an invalid session id is refused', async () => {
  const previews = createPreviewStore()
  const handlers = createArtifactHandlers({
    discover: async () => { throw new Error('must not run') },
    remove: async () => ({ removed: [], failed: [], bytes: 0 }),
    previews,
    isTrustedRequest: alwaysTrusted,
  })
  for (const sessionId of [undefined, '', 42, 'a'.repeat(513), 'bad\0id']) {
    const res = makeRes()
    await handlers.preview(makeReq({ body: { sessionId } }), res)
    assert.equal(res.status, 400, String(sessionId))
  }
})

test('the same-origin fallback matches the exact Origin', () => {
  assert.equal(sameOriginRequest({ headers: { host: 'h:1', origin: 'http://h:1' } }), true)
  assert.equal(sameOriginRequest({ headers: { host: 'h:1', origin: 'http://evil' } }), false)
  assert.equal(sameOriginRequest({ headers: { host: 'h:1' } }), false)
})

test('the host fence defers to the connection when it provides one', () => {
  const connection = { requestRejection: req => (req.ok ? undefined : { code: 'x' }) }
  const fence = hostRequestFence(connection)
  assert.equal(fence({ ok: true }), true)
  assert.equal(fence({ ok: false }), false)
  // A core without the fence keeps the same-origin fallback.
  assert.equal(hostRequestFence(undefined), sameOriginRequest)
})
