import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import {
  classifyCandidate,
  findProtectedAncestor,
  inside,
  isRecord,
  missing,
  resolveDshHome,
} from './fence.mjs'
import {
  attributeByCreationWindow,
  collectShellWindows,
  listWorkspaceFiles,
  mergeWindows,
  otherWindowsOf,
} from './shell.mjs'

/**
 * Discovery of the workspace artifacts one Session produced.
 *
 * The durable Session log is the only authoritative record of what a Session
 * touched: every mutating file-tool call appends a `tool/call` naming the
 * absolute `file_path`, and the matching `tool/result` carries
 * `meta.operation` — `create` when the tool materialized the file, `update`
 * when it rewrote an existing one. Only `create` proves the Session is the
 * origin of a path, so only `create` is offered for deletion.
 *
 * `update` results are reported but never deleted, because rewriting a file the
 * user already owned must not make it disposable. `present` is likewise
 * reported but not offered: it records that a Session *delivered* a path, which
 * says nothing about who created it, so a file the user handed to the Session
 * would otherwise become deletable. A caller may opt into deleting delivered
 * files explicitly (`includeDelivered`).
 *
 * Shell-created files carry no such record, so they are attributed separately
 * by creation time; see `./shell.mjs` for that rule and its safeguards.
 */

const MUTATING_TOOLS = new Set(['write', 'edit'])
const TOOL_ARG_PATH_KEYS = ['file_path', 'path']

const parseJsonObject = text => {
  if (typeof text !== 'string' || text.length === 0) return undefined
  try {
    const parsed = JSON.parse(text)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const callPathOf = (name, args) => {
  if (args === undefined) return undefined
  if (MUTATING_TOOLS.has(name)) {
    for (const key of TOOL_ARG_PATH_KEYS) {
      const value = args[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
    return undefined
  }
  return undefined
}

const presentPathsOf = args => {
  if (!Array.isArray(args?.files)) return []
  const paths = []
  for (const file of args.files) {
    if (typeof file?.path === 'string' && file.path.length > 0) paths.push(file.path)
  }
  return paths
}

const writeOutcomeOf = result => {
  const data = result?.data
  if (!isRecord(data)) return { failed: true, operation: undefined }
  // A recorded tool failure means the tool never materialized anything.
  if (data.error !== undefined) return { failed: true, operation: undefined }
  if (data.message?.isError === true) return { failed: true, operation: undefined }
  const operation = data.meta?.operation
  return { failed: false, operation: typeof operation === 'string' ? operation : undefined }
}

/**
 * Fold one decoded Session event stream into the artifact candidates.
 *
 * @param events - decoded `SessionEvent` objects in `seq` order.
 * @returns `{ created, updated, delivered }` maps of raw path to evidence.
 *   `created` is the only deletable set; `updated` and `delivered` are
 *   reported for the UI but never offered.
 */
export function collectArtifactCandidates(events) {
  const calls = new Map()
  const created = new Map()
  const updated = new Map()
  const delivered = new Map()

  const add = (target, path, evidence) => {
    const existing = target.get(path)
    if (existing === undefined) {
      target.set(path, { path, ...evidence })
      return
    }
    target.set(path, { ...existing, ...evidence })
  }

  for (const event of events) {
    if (!isRecord(event)) continue
    const data = event.data
    if (!isRecord(data)) continue

    if (event.type === 'tool/call') {
      const name = data.name
      const args = parseJsonObject(data.arguments)
      calls.set(data.callId, { name, args })
      if (name === 'present') {
        for (const path of presentPathsOf(args)) {
          add(delivered, path, { tool: 'present', delivered: true })
        }
      }
      continue
    }

    if (event.type !== 'tool/result') continue
    const callId = data.message?.toolCallId ?? data.toolCallId
    const call = calls.get(callId)
    if (call === undefined) continue
    const path = callPathOf(call.name, call.args)
    if (path === undefined) continue

    if (call.name === 'write') {
      const outcome = writeOutcomeOf(event)
      if (outcome.failed) continue
      if (outcome.operation === 'create') add(created, path, { tool: 'write' })
      else add(updated, path, { tool: 'write' })
      continue
    }
    // `edit` only ever rewrites an existing file, so it can never establish
    // authorship; a path edited but never created stays out of `created`.
    add(updated, path, { tool: 'edit' })
  }

  // A path the Session both created and later edited stays a created artifact.
  for (const path of created.keys()) {
    updated.delete(path)
    delivered.delete(path)
  }
  return { created, updated, delivered }
}

/**
 * Resolve the candidate set into the on-disk files that actually exist, with
 * sizes, and reject anything whose real path escapes the workspace through a
 * symlink. Nothing here writes or removes; this is the preview the user sees.
 *
 * Relative candidate paths are resolved against the Session's own `cwd`, never
 * the Host process working directory: a Session that wrote `report.md` meant
 * its workspace, and resolving against the Host cwd would point at an
 * unrelated file.
 */
export async function resolveArtifacts({
  candidates,
  cwd,
  sessionRoot,
  extraExcludes = [],
  dshHome,
  protectPackages = true,
}) {
  const workspace = resolve(cwd)
  let resolvedWorkspace
  try {
    resolvedWorkspace = await realpath(workspace)
  } catch {
    return { files: [], skipped: [...candidates.keys()].map(path => ({ path, reason: 'workspace-unreadable' })) }
  }

  const files = []
  const skipped = []
  const seen = new Set()
  const packageCache = new Map()

  for (const [rawPath, evidence] of candidates) {
    const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(workspace, rawPath)
    const verdict = classifyCandidate({ sessionRoot, cwd, path: candidate, extraExcludes, dshHome })
    if (!verdict.allowed) {
      skipped.push({ path: candidate, reason: verdict.reason })
      continue
    }
    const target = verdict.target
    if (seen.has(target)) continue
    seen.add(target)

    let info
    try {
      info = await lstat(target)
    } catch (error) {
      skipped.push({ path: target, reason: missing(error) ? 'already-gone' : 'unreadable' })
      continue
    }
    if (!info.isFile()) {
      skipped.push({ path: target, reason: info.isDirectory() ? 'is-directory' : 'not-a-regular-file' })
      continue
    }
    // Re-resolve through symlinks: a file that merely points into the
    // workspace from outside it is not a workspace artifact.
    let real
    try {
      real = await realpath(target)
    } catch {
      skipped.push({ path: target, reason: 'unreadable' })
      continue
    }
    if (real !== resolvedWorkspace && !inside(resolvedWorkspace, real)) {
      skipped.push({ path: target, reason: 'symlink-escapes-workspace' })
      continue
    }
    if (protectPackages) {
      const owner = await findProtectedAncestor(target, resolvedWorkspace, packageCache)
      if (owner !== undefined) {
        skipped.push({ path: target, reason: `inside-package:${owner.marker}` })
        continue
      }
    }
    files.push({
      path: target,
      display: relative(workspace, target).split(sep).join('/'),
      bytes: Number(info.size),
      tool: evidence.tool,
      delivered: evidence.delivered === true,
    })
  }

  files.sort((left, right) => left.display < right.display ? -1 : left.display > right.display ? 1 : 0)
  return { files, skipped }
}

/** Read one Session's decoded events through the persistence service. */
export async function readSessionEvents(sessionPersistence, sessionId) {
  const handle = await sessionPersistence.open(sessionId, 'read')
  try {
    const result = await handle.read()
    return { header: handle.header, events: result.events }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/**
 * Every Session's shell-command creation windows, keyed by session id, for the
 * Sessions that share `cwd`.
 *
 * Shell attribution needs the *other* Sessions' windows to decide uniqueness,
 * and that knowledge only exists in their logs. Reading the sibling logs is
 * what makes the difference between "this Session created it" and "some
 * Session created it" — without it a concurrent Session's files would be
 * attributed here.
 *
 * `complete` is false when the sibling set could not be enumerated, or when any
 * sibling log could not be read. An unread sibling is a Session whose windows
 * are invisible, so uniqueness cannot be proven and the caller must not claim
 * shell files by time alone.
 */
export async function collectSiblingWindows({ sessionPersistence, sessionIds, ownSessionId, enumerable = true }) {
  const windowsBySession = new Map()
  const unreadable = []
  let complete = enumerable === true
  for (const sessionId of sessionIds) {
    if (String(sessionId) === String(ownSessionId)) continue
    let events
    try {
      ({ events } = await readSessionEvents(sessionPersistence, sessionId))
    } catch {
      unreadable.push(String(sessionId))
      complete = false
      continue
    }
    windowsBySession.set(String(sessionId), mergeWindows(collectShellWindows(events)))
  }
  return { windowsBySession, complete, unreadable }
}

/**
 * Discover the deletable artifacts of one Session.
 *
 * @returns `{ header, files, skipped, created, updated, delivered, shell }`;
 *   `files` is the preview set, and the counts report the full evidence for
 *   the UI. `shell` summarizes the creation-window pass.
 */
export async function discoverSessionArtifacts({
  sessionPersistence,
  sessionRoot,
  extraExcludes = [],
  dshHome,
  protectPackages = true,
  includeDelivered = false,
  includeShell = true,
  shellSlackMs,
  siblingSessionIds,
  listSessions,
}, sessionId) {
  const { header, events } = await readSessionEvents(sessionPersistence, sessionId)
  const { created, updated, delivered } = collectArtifactCandidates(events)
  const cwd = header?.cwd
  const empty = {
    header, files: [], skipped: [],
    created: created.size, updated: updated.size, delivered: delivered.size,
    shell: {
      enabled: includeShell, attributed: 0, ambiguous: 0, windows: 0,
      siblings: 0, unreadableSiblings: 0, complete: false, candidates: 0, declined: undefined,
    },
  }
  if (typeof cwd !== 'string' || cwd.length === 0) return empty

  const candidates = new Map(created)
  // Delivered-only paths are opt-in: `present` records a hand-off, not
  // authorship, so a file the user supplied to the Session stays out of the
  // default deletable set.
  if (includeDelivered) for (const [path, evidence] of delivered) candidates.set(path, evidence)

  const { files, skipped } = await resolveArtifacts({
    candidates, cwd, sessionRoot, extraExcludes, dshHome, protectPackages,
  })

  const shell = {
    enabled: includeShell, attributed: 0, ambiguous: 0, windows: 0,
    siblings: 0, unreadableSiblings: 0, complete: false, candidates: 0, declined: undefined,
  }
  if (!includeShell) {
    return {
      header, files, skipped,
      created: created.size, updated: updated.size, delivered: delivered.size, shell,
    }
  }

  const mine = mergeWindows(collectShellWindows(events))
  shell.windows = mine.length
  if (mine.length === 0) {
    return {
      header, files, skipped,
      created: created.size, updated: updated.size, delivered: delivered.size, shell,
    }
  }

  // Siblings sharing this workspace, so a file two Sessions could have made is
  // attributed to neither. When the sibling set cannot be enumerated at all,
  // `enumerable` stays false and the pass below declines to claim anything:
  // without the other Sessions' windows, "only my window covers it" cannot be
  // established, and a wrong claim deletes a file this Session never made.
  //
  // `siblingSessionIds` defaults to `undefined`, never `[]`: an empty array is
  // a *provided* (and therefore trusted) empty sibling set, which would let the
  // caller skip enumeration while still looking complete.
  let siblingIds = Array.isArray(siblingSessionIds) ? siblingSessionIds : []
  let enumerable = Array.isArray(siblingSessionIds)
  if (!enumerable && typeof listSessions === 'function') {
    try {
      const snapshots = await listSessions()
      siblingIds = snapshots
        .filter(snapshot => snapshot?.header?.cwd === cwd)
        .map(snapshot => snapshot.header.id)
      enumerable = true
    } catch {
      enumerable = false
    }
  }

  const known = new Set(files.map(file => resolve(file.path)))
  const packageCache = new Map()
  const walked = await listWorkspaceFiles({
    root: cwd,
    workspace: cwd,
    sessionRoot,
    dshHome,
    extraExcludes,
    cache: packageCache,
    // Skip nothing on account of packages: the walker already refuses to
    // descend into them, so a file here is never inside one.
  })

  // Only files the file tools did not already account for, and that are not
  // already offered, are worth a creation-time check.
  const unclaimed = walked.files.filter(path => !known.has(resolve(path)))
  const siblings = await collectSiblingWindows({
    sessionPersistence,
    sessionIds: siblingIds,
    ownSessionId: sessionId,
    enumerable,
  })
  const others = otherWindowsOf(siblings.windowsBySession, sessionId)
  shell.siblings = siblings.windowsBySession.size
  shell.unreadableSiblings = siblings.unreadable.length
  shell.complete = siblings.complete
  shell.candidates = unclaimed.length

  if (!siblings.complete) {
    // Fail closed: report why, claim nothing.
    shell.declined = 'sibling-windows-unavailable'
    return {
      header, files, skipped,
      created: created.size, updated: updated.size, delivered: delivered.size, shell,
    }
  }

  const attributed = await attributeByCreationWindow({
    mine, others, files: unclaimed,
    slackMs: Number.isFinite(shellSlackMs) ? shellSlackMs : undefined,
  })

  shell.attributed = attributed.created.length
  shell.ambiguous = attributed.ambiguous.length
  const shellSkipped = attributed.ambiguous.map(path => ({ path, reason: 'ambiguous-creation-window' }))

  // Run the newly attributed paths through the same validation the file-tool
  // path uses, so sizes, symlinks, and packages are handled identically.
  const shellCandidates = new Map(attributed.created.map(path => [path, { path, tool: 'shell' }]))
  const resolved = await resolveArtifacts({
    candidates: shellCandidates, cwd, sessionRoot, extraExcludes, dshHome, protectPackages,
  })

  const merged = [...files, ...resolved.files]
  merged.sort((left, right) => left.display < right.display ? -1 : left.display > right.display ? 1 : 0)

  return {
    header,
    files: merged,
    skipped: [...skipped, ...shellSkipped, ...resolved.skipped],
    created: created.size,
    updated: updated.size,
    delivered: delivered.size,
    shell,
  }
}

export { classifyCandidate, resolveDshHome } from './fence.mjs'
export {
  attributeByCreationWindow,
  collectShellWindows,
  listWorkspaceFiles,
  mergeWindows,
} from './shell.mjs'
