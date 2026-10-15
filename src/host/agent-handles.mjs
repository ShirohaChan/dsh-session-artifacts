/**
 * Capturing the host lifecycle handle of a live Agent.
 *
 * Removing a session's storage requires the session to be gone from the live
 * registries first. An open session holds its log writer, and while it stays
 * registered its row keeps coming back in the sidebar — so deleting the
 * directory underneath it is both unsafe and useless.
 *
 * `agents.get()` returns a bare Agent with no teardown method, and
 * `agents.enter`/`register` only refuse an id that is *already* registered.
 * The one supported teardown is the `AgentHandle` handed to whoever created the
 * Agent, so this tracker observes Agent creation and keeps that handle.
 *
 * It is this plugin's own tracker: borrowing another plugin's would put the
 * capability back behind that plugin's presence, which is exactly the coupling
 * being removed here.
 *
 * Limit worth knowing: a handle can only be captured for an Agent created or
 * resumed AFTER the tracker is installed. A session that was already live
 * before that cannot be torn down, and is reported as such rather than deleted
 * underneath its writer.
 */

/** Cordis exposes the undecorated service behind this well-known symbol. */
const ORIGINAL = Symbol.for('cordis.original')
/** Marks our wrappers so a reload can unwrap only its own stack. */
const WRAPPER = Symbol.for('dsh-session-artifacts.agent-tracker-origin')

/**
 * A tracker that captures nothing. Used when the composing Host has no `agents`
 * service: a cold session is still removable, a live one is refused by
 * `quiesceSession` because no handle can exist.
 *
 * `reserve` still returns a release function so the caller's "already deleting"
 * branch means what it says — a null tracker has no reservations to conflict
 * with.
 */
export const createNullAgentTracker = () => ({
  effective: false,
  reserve: () => () => {},
  dispose: async () => false,
  size: () => 0,
  release: async () => {},
})

/**
 * Observe Agent creation on the shared `agents` service and retain the handles.
 *
 * @param agents - the live Agent registry.
 * @param sessions - the live session store, when the Host provides one.
 * @returns `{ reserve, dispose, size, release }`.
 */
export function installAgentHandleTracker(agents, sessions) {
  if (agents === undefined || typeof agents.get !== 'function') return createNullAgentTracker()
  // Cordis supplies a context-local proxy. Assigning through it would only
  // shadow the method for this plugin, while the real factory keeps calling the
  // shared service — so patch the underlying service and keep the caller's
  // receiver via Reflect.apply.
  const agentService = agents[ORIGINAL] ?? agents
  const sessionService = sessions?.[ORIGINAL] ?? sessions
  if (typeof agentService.create !== 'function' || typeof agentService.resume !== 'function') {
    return createNullAgentTracker()
  }

  const handles = new Map()
  const reservations = new Set()
  let released = false

  const originalCreate = agentService.create
  const originalResume = agentService.resume
  const originalAgentEnter = agentService.enter
  const originalSessionEnter = sessionService?.enter

  const assertAvailable = sessionId => {
    if (released) return
    if (typeof sessionId === 'string' && reservations.has(sessionId)) {
      throw new Error(`session "${sessionId}" is being permanently deleted`)
    }
  }

  const track = handle => {
    if (!released && handle?.agent?.id !== undefined && typeof handle.dispose === 'function') {
      handles.set(handle.agent.id, handle)
    }
    return handle
  }

  const wrappedCreate = async function (...args) {
    assertAvailable(args[0]?.sessionId)
    return track(await Reflect.apply(originalCreate, this, args))
  }
  const wrappedResume = async function (...args) {
    assertAvailable(args[0]?.resumeSessionId)
    return track(await Reflect.apply(originalResume, this, args))
  }
  const wrappedAgentEnter = typeof originalAgentEnter === 'function'
    ? function (...args) {
        assertAvailable(args[0]?.id)
        return Reflect.apply(originalAgentEnter, this, args)
      }
    : undefined
  const wrappedSessionEnter = typeof originalSessionEnter === 'function'
    ? function (...args) {
        assertAvailable(args[0]?.id)
        return Reflect.apply(originalSessionEnter, this, args)
      }
    : undefined

  // A plugin reload can install a new tracker while an older deletion still
  // drains; unwrap every already-released layer rather than just the top one.
  const unwrapReleased = method => {
    while (method?.[WRAPPER]?.released()) method = method[WRAPPER].original
    return method
  }
  for (const [wrapped, original] of [
    [wrappedCreate, originalCreate],
    [wrappedResume, originalResume],
    [wrappedAgentEnter, originalAgentEnter],
    [wrappedSessionEnter, originalSessionEnter],
  ]) {
    if (wrapped) Object.defineProperty(wrapped, WRAPPER, { value: { original, released: () => released } })
  }

  // Patching is attempted defensively: a frozen or otherwise sealed service
  // throws on assignment under strict mode, and a tracker that cannot install
  // must degrade to "no handles" rather than take the whole plugin down.
  try {
    agentService.create = wrappedCreate
    agentService.resume = wrappedResume
    if (wrappedAgentEnter !== undefined) agentService.enter = wrappedAgentEnter
    if (wrappedSessionEnter !== undefined && sessionService !== undefined) sessionService.enter = wrappedSessionEnter
  } catch {
    // Fall through to the effectiveness check below, which reports it.
  }

  /**
   * Did the assignment actually stick?
   *
   * Cordis hands out a context-local proxy. Writing through one of those only
   * shadows the method for this plugin while the real factory keeps calling the
   * shared service, so the wrappers would never run and no handle would ever be
   * captured. That failure is entirely silent — the tracker looks installed and
   * simply never records anything — so it is checked rather than assumed.
   */
  const effective = agentService.create === wrappedCreate && agentService.resume === wrappedResume

  let releaseStarted = false
  let resolveRelease
  let releaseTask
  const finishRelease = () => {
    // Wait for in-flight deletions: their reservation must not outlive the
    // tracker that is protecting them.
    if (!releaseStarted || released || reservations.size !== 0) return
    released = true
    handles.clear()
    // Restoring is best-effort for the same reason patching is: a service that
    // refused the assignment must not throw here either.
    try {
      if (agentService.create === wrappedCreate) agentService.create = unwrapReleased(originalCreate)
      if (agentService.resume === wrappedResume) agentService.resume = unwrapReleased(originalResume)
      if (wrappedAgentEnter !== undefined && agentService.enter === wrappedAgentEnter) {
        agentService.enter = unwrapReleased(originalAgentEnter)
      }
      if (wrappedSessionEnter !== undefined && sessionService?.enter === wrappedSessionEnter) {
        sessionService.enter = unwrapReleased(originalSessionEnter)
      }
    } catch {
      // Leaving a wrapper installed is survivable; the tracker is released.
    }
    resolveRelease?.()
  }

  return {
    /** False when the service could not actually be patched (see above). */
    effective,
    /**
     * Block a new Agent for `sessionId` for the duration of a deletion, so the
     * session cannot be reopened between the checks and the removal.
     *
     * @returns a release function, or `undefined` when a deletion is already in
     *   progress (or the tracker is unloading).
     */
    reserve(sessionId) {
      if (releaseStarted || reservations.has(sessionId)) return undefined
      reservations.add(sessionId)
      let active = true
      return () => {
        if (!active) return
        active = false
        reservations.delete(sessionId)
        finishRelease()
      }
    },

    /**
     * Tear down one live Agent through its own host handle.
     *
     * @returns `true` when a handle existed and was disposed; `false` when no
     *   handle was captured (the Agent was live before this tracker installed).
     */
    async dispose(sessionId) {
      const handle = handles.get(sessionId)
      // A stale entry whose agent was replaced must not be disposed: it belongs
      // to a different live Agent.
      if (handle === undefined || agents.get(sessionId) !== handle.agent) {
        handles.delete(sessionId)
        return false
      }
      await handle.dispose()
      handles.delete(sessionId)
      return true
    },

    size: () => handles.size,

    release() {
      if (released) return releaseTask
      if (!releaseStarted) {
        releaseStarted = true
        releaseTask = new Promise(resolve => { resolveRelease = resolve })
        finishRelease()
      }
      return releaseTask
    },
  }
}
