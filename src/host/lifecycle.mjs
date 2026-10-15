/**
 * Stopping a live Session before its log is removed.
 *
 * Deleting the log of a Session whose Agent is still registered would leave
 * that Agent writing to a directory that no longer exists, and its row would
 * reappear in the sidebar. The registry offers no `dispose`, so the hosted
 * teardown is the `AgentHandle` captured by `./agent-handles.mjs`.
 *
 * Order matters:
 *
 * 1. **Cancel a running turn.** `agent.cancel({ kind: 'user' })` is the same
 *    path the Stop button uses. `dispose()` alone can race a turn that is
 *    mid-write, so the turn is stopped first.
 * 2. **Dispose through the host handle.** This is what actually unregisters the
 *    Agent and detaches its Session.
 * 3. **Wait for both registries to clear.** A disposing Agent unwinds
 *    asynchronously; removing the directory underneath it races its final
 *    flush.
 *
 * An Agent that was already live before this plugin's tracker installed has no
 * captured handle. That case is refused with an explicit reason rather than
 * deleted underneath its writer, because reporting a deletion that did not
 * happen is worse than not deleting.
 */

/** How long to wait for a disposed Agent to leave the registries. */
const DEFAULT_QUIESCE_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 150

const failure = (code, message) => ({ ok: false, error: { code, message } })

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Ask one live Agent to stop its turn. `cancel` is optional on the public Agent
 * surface, so a missing implementation is reported rather than assumed to have
 * worked.
 */
const cancelAgent = agent => {
  if (agent === undefined) return false
  if (typeof agent.cancel !== 'function') return false
  try {
    agent.cancel({ kind: 'user' })
    return true
  } catch {
    return false
  }
}

/**
 * Stop a Session's running work and wait for it to leave the live registries.
 *
 * @param handles - the Agent-handle tracker; `dispose` performs the teardown.
 * @returns `{ ok: true, stopped }` when the Session is no longer live, or a
 *   failure describing why it could not be stopped.
 */
export async function quiesceSession({
  agents,
  sessions,
  handles,
  sessionId,
  timeoutMs = DEFAULT_QUIESCE_TIMEOUT_MS,
  now = Date.now,
  wait = sleep,
} = {}) {
  const liveAgent = () => agents?.get?.(sessionId)
  const liveSession = () => sessions?.get?.(sessionId)

  const agent = liveAgent()
  const session = liveSession()
  if (agent === undefined && session === undefined) return { ok: true, stopped: false }

  // 1. A running turn must stop before its writer is torn down.
  if (agent?.status === 'running' && !cancelAgent(agent)) {
    return failure('lifecycle-unavailable', '该会话正在运行，且当前 Host 未提供停止它的方式，未删除任何内容。')
  }

  // 2. Hand the Agent back to the host through the handle that owns its
  //    lifecycle. Without a handle there is no supported way to unregister it.
  let disposed = false
  const dispose = handles?.dispose
  if (agent !== undefined && typeof dispose === 'function') {
    try {
      disposed = (await dispose(sessionId)) === true
    } catch {
      return failure('lifecycle-error', 'DSH 未能安全停止并摘除该会话，未删除任何内容。')
    }
  }

  // 3. Wait for the registries to drain. A Session with no Agent at all (the
  //    common cleanup case) is already gone by here.
  const deadline = now() + timeoutMs
  for (;;) {
    if (liveAgent() === undefined && liveSession() === undefined) {
      return { ok: true, stopped: true }
    }
    if (now() >= deadline) {
      // Distinguish "we never had a handle" from "it is still unwinding": the
      // first needs a DSH restart, the second just needs a retry.
      if (liveAgent() !== undefined && !disposed) {
        return failure(
          'lifecycle-unavailable',
          '无法取得该会话的宿主生命周期句柄，未能摘除它，未删除任何内容。它在此插件加载前就已打开；请重启 DeepSeek Harness 后重试。',
        )
      }
      return failure('session-still-live', '该会话仍在运行或未从宿主摘除，未删除任何内容。请先停止它再重试。')
    }
    await wait(POLL_INTERVAL_MS)
  }
}

export { DEFAULT_QUIESCE_TIMEOUT_MS, POLL_INTERVAL_MS }
