import { randomUUID } from 'node:crypto'
import { discoverSessionArtifacts, resolveDshHome } from './host/artifacts.mjs'
import { removeArtifacts } from './host/remove.mjs'
import { deleteSessionLog } from './host/session-log.mjs'
import { quiesceSession } from './host/lifecycle.mjs'
import { installAgentHandleTracker } from './host/agent-handles.mjs'

export const name = 'dsh-session-artifacts'

// `agents` is injected rather than merely looked up, because the handle tracker
// must be installed BEFORE any Agent is created — a tracker installed later
// captures nothing, and an open session then cannot be torn down. Declaring the
// dependency makes Cordis apply this plugin once the registry exists, which is
// the only way to guarantee that ordering. Every shipped composition mounts it
// (`@deepseek-ai/dsh-agent`), and without it there are no sessions to manage.
export const inject = ['webServer', 'sessionPersistence', 'agents']

const MAX_REQUEST_BYTES = 8 * 1024

/**
 * How long one preview stays removable. The Session log is the only record of
 * what a Session produced, and the ordinary flow deletes that log before the
 * files, so the previewed set is held server-side and addressed by an opaque
 * nonce. The client therefore never names paths, and a path the user was never
 * shown cannot be removed.
 */
const PREVIEW_TTL_MS = 10 * 60 * 1000
const MAX_PREVIEWS = 64

const failure = (code, message) => ({ ok: false, error: { code, message } })

/**
 * Group skip reasons by their family so the dialog can explain *why* candidates
 * were withheld. A reason like `inside-package:SKILL.md` carries a suffix, so
 * only the part before the colon is the family.
 */
export const summarizeSkipReasons = skipped => {
  const counts = {}
  for (const item of Array.isArray(skipped) ? skipped : []) {
    const family = typeof item?.reason === 'string' ? item.reason.split(':')[0] : 'unknown'
    counts[family] = (counts[family] ?? 0) + 1
  }
  return counts
}

export function currentConnection(ctx) {
  return typeof ctx.get === 'function' ? ctx.get('connection') : undefined
}

const sendJson = (res, status, body) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

const readJsonBody = async (req, limit) => {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new Error('request-too-large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export const sameOriginRequest = req => (
  typeof req.headers.host === 'string' && req.headers.origin === `http://${req.headers.host}`
)

/**
 * Prefer the Host's own request fence. The desktop app forwards its requests
 * without an Origin header, so a bare same-origin check would reject them;
 * older cores without that fence keep the same-origin fallback.
 */
export function hostRequestFence(connection) {
  if (typeof connection?.requestRejection !== 'function') return sameOriginRequest
  return req => connection.requestRejection(req) === undefined
}

const validSessionId = value => (
  typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0')
)

const validNonce = value => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value)

/**
 * Accept only an explicit JSON POST carrying the plugin's own action header.
 * The header is what an ordinary link or HTML form cannot add, so a cross-site
 * page cannot drive a destructive run.
 */
const acceptAction = (req, res, isTrustedRequest, action) => {
  if (req.method !== 'POST') {
    sendJson(res, 405, failure('method-not-allowed', '只允许使用 POST 管理会话产物。'))
    return false
  }
  if (!isTrustedRequest(req) || req.headers['x-dsh-session-artifacts-action'] !== action) {
    sendJson(res, 403, failure('forbidden', '会话产物请求未通过同源与操作标记校验。'))
    return false
  }
  const contentType = req.headers['content-type']
  if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
    sendJson(res, 415, failure('unsupported-media-type', '会话产物请求必须使用 JSON。'))
    return false
  }
  return true
}

const parseBody = async (req, res, limit) => {
  try {
    return await readJsonBody(req, limit)
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === 'request-too-large'
    sendJson(res, tooLarge ? 413 : 400, failure(
      tooLarge ? 'request-too-large' : 'invalid-json',
      tooLarge ? '请求过大。' : '请求不是有效 JSON。',
    ))
    return undefined
  }
}

/**
 * Server-side preview store. Entries are created by `preview` and consumed
 * once by `remove`; expired entries are pruned on every write.
 */
export function createPreviewStore({ ttlMs = PREVIEW_TTL_MS, max = MAX_PREVIEWS, now = Date.now } = {}) {
  const entries = new Map()

  const prune = () => {
    const current = now()
    for (const [nonce, entry] of entries) {
      if (entry.expiresAt <= current) entries.delete(nonce)
    }
  }

  return {
    put(value) {
      prune()
      const nonce = randomUUID()
      entries.set(nonce, { ...value, expiresAt: now() + ttlMs })
      // Enforce the cap after inserting, so the store never exceeds `max`.
      while (entries.size > max) entries.delete(entries.keys().next().value)
      return nonce
    },
    take(nonce) {
      prune()
      const entry = entries.get(nonce)
      if (entry === undefined) return undefined
      entries.delete(nonce)
      return entry
    },
    get size() { return entries.size },
    clear() { entries.clear() },
  }
}

/**
 * HTTP boundary for artifact discovery and removal.
 *
 * `preview` is read-only and always safe to call. `remove` deletes exactly the
 * set a prior preview resolved, re-validated against the fences and its
 * previewed size immediately before each unlink.
 */
export function createArtifactHandlers({
  discover,
  remove,
  deleteSession,
  isAgentTracking,
  backendName,
  previews,
  isTrustedRequest = sameOriginRequest,
  warn = console.warn,
}) {
  return {
    /**
     * Whether this Host can delete a Session record itself. The client asks
     * before offering the action, so a missing capability surfaces as a clear
     * message instead of a bare HTTP error after the user has committed.
     */
    capability: (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, failure('method-not-allowed', '只允许使用 GET 查询能力。'))
        return
      }
      if (!isTrustedRequest(req)) {
        sendJson(res, 403, failure('forbidden', '请求未通过同源校验。'))
        return
      }
      sendJson(res, 200, {
        ok: true,
        value: {
          deleteSession: typeof deleteSession === 'function',
          preview: typeof discover === 'function',
          remove: typeof remove === 'function',
          // Whether the live-Agent handle tracker is actually installed and
          // working. False means an open session cannot be torn down until DSH
          // is restarted — reported rather than discovered through a failed
          // deletion.
          agentHandleTracking: typeof isAgentTracking === 'function' ? isAgentTracking() : true,
          // The backend whose layout this plugin removes. A different one is
          // refused rather than probed with directory surgery.
          persistenceBackend: typeof backendName === 'function' ? backendName() : undefined,
        },
      })
    },

    deleteSession: async (req, res) => {
      if (!acceptAction(req, res, isTrustedRequest, 'delete-session')) return
      const body = await parseBody(req, res, MAX_REQUEST_BYTES)
      if (body === undefined) return
      if (!validSessionId(body?.sessionId)) {
        sendJson(res, 400, failure('invalid-session-id', '会话 ID 无效。'))
        return
      }
      if (typeof deleteSession !== 'function') {
        sendJson(res, 501, failure('unsupported', '当前 Host 无法删除会话记录。'))
        return
      }
      try {
        const result = await deleteSession(body.sessionId)
        // 409 carries the structured reason (still live, unsafe location, …) so
        // the dialog can explain what happened instead of showing a status code.
        sendJson(res, result.ok ? 200 : 409, result)
      } catch (error) {
        warn('session record deletion failed:', error)
        sendJson(res, 500, failure('internal', '删除会话记录时发生未预期错误，未确认删除成功。'))
      }
    },

    preview: async (req, res) => {
      if (!acceptAction(req, res, isTrustedRequest, 'preview-artifacts')) return
      const body = await parseBody(req, res, 8 * 1024)
      if (body === undefined) return
      if (!validSessionId(body?.sessionId)) {
        sendJson(res, 400, failure('invalid-session-id', '会话 ID 无效。'))
        return
      }
      try {
        const discovered = await discover(body.sessionId)
        const cwd = discovered.header?.cwd
        if (typeof cwd !== 'string' || cwd.length === 0) {
          sendJson(res, 200, {
            ok: true,
            value: { files: [], skipped: discovered.skipped, total: 0, bytes: 0, nonce: undefined, noWorkspace: true },
          })
          return
        }
        const bytes = discovered.files.reduce((sum, file) => sum + file.bytes, 0)
        const nonce = discovered.files.length === 0
          ? undefined
          : previews.put({ sessionId: body.sessionId, cwd, files: discovered.files })
        sendJson(res, 200, {
          ok: true,
          value: {
            total: discovered.files.length,
            bytes,
            nonce,
            created: discovered.created,
            updated: discovered.updated,
            delivered: discovered.delivered,
            shell: discovered.shell,
            files: discovered.files.map(file => ({
              display: file.display,
              bytes: file.bytes,
              tool: file.tool,
              delivered: file.delivered === true,
            })),
            skipped: discovered.skipped.length,
            skippedReasons: summarizeSkipReasons(discovered.skipped),
          },
        })
      } catch (error) {
        warn('session artifact discovery failed:', error)
        sendJson(res, 503, failure('discovery-failed', '暂时无法读取该会话的产物清单。'))
      }
    },

    remove: async (req, res) => {
      if (!acceptAction(req, res, isTrustedRequest, 'delete-artifacts')) return
      const body = await parseBody(req, res, MAX_REQUEST_BYTES)
      if (body === undefined) return
      if (!validNonce(body?.nonce)) {
        sendJson(res, 400, failure('invalid-nonce', '产物清单标识无效，请重新打开删除对话框。'))
        return
      }
      const entry = previews.take(body.nonce)
      if (entry === undefined) {
        sendJson(res, 409, failure('preview-expired', '产物清单已过期，请重新打开删除对话框。'))
        return
      }
      try {
        const result = await remove(entry)
        // A partial run leaves files behind. The Session log is already gone,
        // so the only way back to that list is a fresh nonce held server-side
        // for exactly the entries still worth another attempt.
        const retry = Array.isArray(result?.retry) ? result.retry : []
        const retryNonce = retry.length === 0
          ? undefined
          : previews.put({ sessionId: entry.sessionId, cwd: entry.cwd, files: retry })
        const { retry: _retry, ...value } = result
        sendJson(res, 200, { ok: true, value: { ...value, retryNonce } })
      } catch (error) {
        warn('session artifact removal failed:', error)
        sendJson(res, 500, failure('removal-failed', '删除会话产物时发生未预期错误。'))
      }
    },
  }
}

/**
 * Plugin configuration. Every field is optional; the defaults are the safe
 * ones — nothing under the DSH home or inside a built package is ever offered,
 * delivered-only files are reported rather than deleted, and a file two
 * Sessions could have created is attributed to neither.
 */
export function resolveOptions(config = {}, ctx = {}) {
  const sessionRoot = ctx.sessionPersistence?.config?.root ?? ctx.sessionPersistence?.root
  const extraExcludes = Array.isArray(config.extraExcludes)
    ? config.extraExcludes.filter(value => typeof value === 'string' && value.length > 0)
    : []
  return {
    sessionRoot,
    dshHome: resolveDshHome({ dshHome: config.dshHome, sessionRoot }),
    extraExcludes,
    protectPackages: config.protectPackages !== false,
    includeDelivered: config.includeDelivered === true,
    includeShell: config.includeShell !== false,
    shellSlackMs: Number.isFinite(config.shellSlackMs) ? config.shellSlackMs : undefined,
    // Delete the Session record as part of the flow. On by default: this plugin
    // owns that step now, so it does not depend on another plugin being loaded.
    deleteSession: config.deleteSession !== false,
    // How long to wait for a stopped Session to leave the live registries.
    lifecycleTimeoutMs: Number.isFinite(config.lifecycleTimeoutMs) && config.lifecycleTimeoutMs > 0
      ? config.lifecycleTimeoutMs
      : undefined,
  }
}

export function apply(ctx, config = {}) {
  const sessionPersistence = ctx.sessionPersistence
  const options = resolveOptions(config ?? {}, ctx)
  if (typeof options.sessionRoot !== 'string' || options.sessionRoot.length === 0) {
    throw new Error('dsh-session-artifacts requires the per-session JSONL persistence backend')
  }

  const dependencies = { sessionPersistence, sessionRoot: options.sessionRoot }
  const previews = createPreviewStore()
  ctx.effect(() => () => previews.clear(), 'dsh-session-artifacts: preview store lifecycle')

  const isTrustedRequest = req => hostRequestFence(currentConnection(ctx))(req)

  // Sibling Sessions that share a workspace. Shell attribution needs their
  // command windows to tell "this Session created it" from "some Session did",
  // so a file two Sessions could have made is claimed by neither. Read lazily
  // and per request: the list changes while the Host runs.
  const listSessions = async () => {
    if (typeof sessionPersistence?.list !== 'function') return []
    return sessionPersistence.list()
  }

  // `agents` and `sessions` are optional: a composition without them can still
  // delete a cold Session's log, it just cannot stop a running one.
  let agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  let sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined

  // Capture the host lifecycle handle of every Agent created from here on. The
  // registry exposes no `dispose`, so this is the only supported teardown for a
  // Session that is currently open — without it an open Session can never be
  // removed, which is exactly the case a user hits when deleting the row they
  // are looking at.
  let agentHandles = installAgentHandleTracker(agents, sessions)
  let handlesInstalled = agents !== undefined
  ctx.effect(() => () => agentHandles.release(), 'dsh-session-artifacts: agent handle tracking')

  /**
   * Install the tracker if it could not be at apply time.
   *
   * `agents` is declared in `inject`, so this is a safety net rather than the
   * normal path: it covers a composition that replaces the registry later. It
   * cannot rescue an Agent created before it runs — that stays the documented
   * pre-existing case.
   */
  const ensureAgentHandles = () => {
    if (handlesInstalled) return agentHandles
    const lateAgents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    if (lateAgents === undefined) return agentHandles
    agents = lateAgents
    sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
    agentHandles = installAgentHandleTracker(agents, sessions)
    handlesInstalled = true
    return agentHandles
  }

  /**
   * Remove the Session record itself. The persistence seam has no deletion API,
   * so this plugin performs the removal rather than delegating to another
   * plugin — that is what makes it usable on its own.
   */
  const deleteSession = async sessionId => {
    const handles = ensureAgentHandles()
    // Hold a reservation for the whole operation so nothing reopens the
    // Session between the checks and the removal.
    const release = handles.reserve(sessionId)
    if (release === undefined) {
      return failure('deletion-in-progress', '该会话正在删除中，请等待当前操作完成。')
    }
    try {
      const stopped = await quiesceSession({
        agents,
        sessions,
        handles,
        sessionId,
        ...(options.lifecycleTimeoutMs === undefined ? {} : { timeoutMs: options.lifecycleTimeoutMs }),
      })
      if (stopped.ok === false) return stopped
      return await deleteSessionLog({
        sessionPersistence,
        sessionRoot: options.sessionRoot,
        sessionId,
        // Re-check after validation: a Session that came back to life during
        // the checks must not have its storage removed underneath it.
        beforeRemove: () => {
          if (sessions?.get?.(sessionId) !== undefined || agents?.get?.(sessionId) !== undefined) {
            return failure('session-reopened', '该会话在删除过程中被重新打开，已取消删除。')
          }
          return undefined
        },
      })
    } finally {
      release?.()
    }
  }

  const handlers = createArtifactHandlers({
    discover: sessionId => discoverSessionArtifacts({
      ...dependencies,
      dshHome: options.dshHome,
      extraExcludes: options.extraExcludes,
      protectPackages: options.protectPackages,
      includeDelivered: options.includeDelivered,
      includeShell: options.includeShell,
      shellSlackMs: options.shellSlackMs,
      listSessions,
    }, sessionId),
    // The entry carries the cwd and the exact previewed files, so removal does
    // not depend on the Session log still existing. The fences are re-applied
    // from the same closure values discovery used.
    remove: entry => removeArtifacts(entry.files, {
      cwd: entry.cwd,
      sessionRoot: options.sessionRoot,
      dshHome: options.dshHome,
    }),
    deleteSession: options.deleteSession ? deleteSession : undefined,
    isAgentTracking: () => ensureAgentHandles().effective === true,
    backendName: () => sessionPersistence?.name,
    previews,
    isTrustedRequest,
  })

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-session-artifacts/capability',
      handler: handlers.capability,
    }),
    'dsh-session-artifacts: capability route',
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-session-artifacts/delete-session',
      handler: handlers.deleteSession,
    }),
    'dsh-session-artifacts: session record deletion route',
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-session-artifacts/preview',
      handler: handlers.preview,
    }),
    'dsh-session-artifacts: artifact preview route',
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-session-artifacts/remove',
      handler: handlers.remove,
    }),
    'dsh-session-artifacts: artifact removal route',
  )
}

export {
  collectArtifactCandidates,
  classifyCandidate,
  discoverSessionArtifacts,
  resolveDshHome,
} from './host/artifacts.mjs'
export { removeArtifacts } from './host/remove.mjs'
