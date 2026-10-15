import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createNullAgentTracker, installAgentHandleTracker } from '../src/host/agent-handles.mjs'

/**
 * A stand-in for the shared `agents` service: the tracker patches the object it
 * is handed, so the double must expose the same shape (`get`, `create`,
 * `resume`, `enter`) and a live registry keyed by id.
 */
const makeAgents = () => {
  const live = new Map()
  const service = {
    live,
    async create(options) {
      const handle = {
        agent: { id: options.sessionId },
        dispose: async () => { live.delete(options.sessionId) },
      }
      live.set(options.sessionId, handle.agent)
      return handle
    },
    async resume(options) {
      const handle = {
        agent: { id: options.resumeSessionId },
        dispose: async () => { live.delete(options.resumeSessionId) },
      }
      live.set(options.resumeSessionId, handle.agent)
      return handle
    },
    enter(agent) { live.set(agent.id, agent); return () => live.delete(agent.id) },
    get(id) { return live.get(id) },
  }
  return service
}

test('the tracker captures the handle of every created agent', async () => {
  const agents = makeAgents()
  const tracker = installAgentHandleTracker(agents, undefined)
  await agents.create({ sessionId: 'a' })
  await agents.resume({ resumeSessionId: 'b' })
  assert.equal(tracker.size(), 2)

  assert.equal(await tracker.dispose('a'), true)
  assert.equal(agents.get('a'), undefined, 'dispose unregisters the agent')
  assert.equal(tracker.size(), 1)
  tracker.release()
})

test('dispose returns false for an agent that was live before the tracker', async () => {
  // Pre-existing live agent: installed the tracker, but never saw it created.
  const agents = makeAgents()
  agents.live.set('old', { id: 'old' })
  const tracker = installAgentHandleTracker(agents, undefined)
  assert.equal(await tracker.dispose('old'), false)
  assert.equal(agents.get('old') !== undefined, true, 'an untracked agent is left alone')
  tracker.release()
})

test('dispose refuses a stale handle whose agent was replaced', async () => {
  const agents = makeAgents()
  const tracker = installAgentHandleTracker(agents, undefined)
  await agents.create({ sessionId: 'a' })
  // The id is reused by a different live agent (the tracked one was replaced).
  let disposedReplacement = false
  agents.live.set('a', { id: 'a', dispose: async () => { disposedReplacement = true } })
  assert.equal(await tracker.dispose('a'), false)
  assert.equal(disposedReplacement, false, 'the replacement agent must not be disposed')
  tracker.release()
})

test('a reservation blocks reopening the session, then releases it', async () => {
  const agents = makeAgents()
  const tracker = installAgentHandleTracker(agents, undefined)
  const release = tracker.reserve('a')
  assert.equal(typeof release, 'function')
  // A second reservation for the same id is refused while the first is held.
  assert.equal(tracker.reserve('a'), undefined)
  await assert.rejects(() => agents.create({ sessionId: 'a' }), /being permanently deleted/)
  release()
  // After release the id is usable again.
  await agents.create({ sessionId: 'a' })
  assert.equal(agents.get('a') !== undefined, true)
  tracker.release()
})

test('release restores the original service methods', async () => {
  const agents = makeAgents()
  const originalCreate = agents.create
  const originalResume = agents.resume
  const originalEnter = agents.enter
  const tracker = installAgentHandleTracker(agents, undefined)
  assert.notEqual(agents.create, originalCreate, 'create is wrapped while installed')
  await tracker.release()
  assert.equal(agents.create, originalCreate, 'create is restored on release')
  assert.equal(agents.resume, originalResume)
  assert.equal(agents.enter, originalEnter)
})

test('release waits for an in-flight reservation', async () => {
  const agents = makeAgents()
  const tracker = installAgentHandleTracker(agents, undefined)
  const release = tracker.reserve('a')
  let settled = false
  const task = tracker.release().then(() => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(settled, false, 'release must not finish while a deletion is in flight')
  release()
  await task
  assert.equal(settled, true)
})

test('a reloaded tracker unwraps cleanly and still tracks', async () => {
  const agents = makeAgents()
  const first = installAgentHandleTracker(agents, undefined)
  await first.release()
  // A second install after the first released must not leave a stale wrapper.
  const second = installAgentHandleTracker(agents, undefined)
  await agents.create({ sessionId: 'a' })
  assert.equal(second.size(), 1)
  assert.equal(await second.dispose('a'), true)
  await second.release()
})

test('a host without an agents service yields a working null tracker', async () => {
  const tracker = createNullAgentTracker()
  // Reserve must hand back a release function, so the caller's
  // "already deleting" branch never fires spuriously.
  const release = tracker.reserve('a')
  assert.equal(typeof release, 'function')
  release()
  assert.equal(await tracker.dispose('a'), false)
  assert.equal(tracker.size(), 0)
  await tracker.release()
})

test('a service that refuses the patch reports itself ineffective', async () => {
  // The silent failure this guard exists for: the writes are swallowed, so the
  // wrappers never run and no handle is ever captured, yet nothing throws.
  const live = new Map()
  const real = {
    async create(options) {
      const handle = { agent: { id: options.sessionId }, dispose: async () => live.delete(options.sessionId) }
      live.set(options.sessionId, handle.agent)
      return handle
    },
    async resume(options) {
      const handle = { agent: { id: options.resumeSessionId }, dispose: async () => live.delete(options.resumeSessionId) }
      live.set(options.resumeSessionId, handle.agent)
      return handle
    },
    get(id) { return live.get(id) },
  }
  const sealed = new Proxy(real, {
    set: () => true,                 // accepted, but never stored
    get: (target, key) => target[key],
  })

  const tracker = installAgentHandleTracker(sealed, undefined)
  assert.equal(tracker.effective, false, 'a swallowed patch must be reported')
  await sealed.create({ sessionId: 'a' })
  assert.equal(tracker.size(), 0, 'nothing can be tracked through an ineffective patch')
  await tracker.release()
})

test('a frozen service does not take the plugin down', async () => {
  // Strict-mode assignment to a frozen object throws; installing must survive.
  const frozen = Object.freeze({
    async create() { throw new Error('unused') },
    async resume() { throw new Error('unused') },
    get() { return undefined },
  })
  const tracker = installAgentHandleTracker(frozen, undefined)
  assert.equal(tracker.effective, false)
  await tracker.release()
})

test('an effective tracker reports itself effective', async () => {
  const agents = makeAgents()
  const tracker = installAgentHandleTracker(agents, undefined)
  assert.equal(tracker.effective, true)
  await tracker.release()
})

test('installAgentHandleTracker degrades instead of throwing on a partial service', () => {
  // No service at all.
  assert.equal(typeof installAgentHandleTracker(undefined, undefined).reserve, 'function')
  // A service missing the creation entry points cannot track anything.
  const partial = installAgentHandleTracker({ get: () => undefined }, undefined)
  assert.equal(typeof partial.reserve, 'function')
  assert.equal(partial.size(), 0)
})
