import { readdir, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

import { classifyCandidate, findProtectedAncestor, inside } from './fence.mjs'

/**
 * Attribution of files a Session created through shell commands.
 *
 * File-tool writes are recorded explicitly in the Session log, so they are
 * exact. Shell commands are not: a `pwsh` call records only the command text,
 * and its `tool/result` carries no `meta` at all. Nothing durable names the
 * files a `python foo.py` run produced.
 *
 * The strongest remaining evidence is *creation time*. On NTFS `birthtime` is
 * the real creation timestamp, distinct from `mtime`, and it survives later
 * edits — so it answers "was this file created while this command was running?",
 * which is exactly the question. Pairing each shell `tool/call` with its
 * `tool/result` yields a tight `[start, end]` window per command.
 *
 * Two rules keep this safe:
 *
 * - **Tight windows.** A whole-Session window is unusable: a Session that ran
 *   two commands would claim every file created during its (possibly hours
 *   long) lifetime. Only the interval the command actually ran counts.
 * - **Uniqueness.** A file created inside *two* Sessions' windows is attributed
 *   to neither, because a wrong attribution would delete a file this Session
 *   never made. Concurrent Sessions therefore reduce the result rather than
 *   corrupt it.
 *
 * Only creation is claimed. A file that merely *changed* during the window was
 * not produced by the Session, so it is left alone.
 */

/** Shell tools whose results are inspected for a creation window. */
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'shell'])

/** Directories that are never worth descending into when scanning a workspace. */
const PRUNE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', '.next', '.nuxt', 'dist', 'build',
])

/**
 * How much slack to allow around a command window, in milliseconds. The clock
 * that stamps a Session event and the filesystem clock are not the same source,
 * and a command's `tool/result` is appended after its child processes exit.
 */
const DEFAULT_SLACK_MS = 5000

/** Merge windows closer than this so overlapping commands are not double-scanned. */
const MERGE_GAP_MS = 2000

/**
 * Extract the `[start, end]` window of every shell command in one Session's
 * decoded events. The window opens at the `tool/call` and closes at the
 * matching `tool/result`; a command with no recorded result contributes
 * nothing, because its end is unknown.
 */
export function collectShellWindows(events) {
  const pending = new Map()
  const windows = []
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const data = event.data
    if (!data || typeof data !== 'object') continue
    if (event.type === 'tool/call') {
      if (typeof data.name === 'string' && SHELL_TOOLS.has(data.name) && typeof event.time === 'number') {
        pending.set(data.callId, event.time)
      }
      continue
    }
    if (event.type !== 'tool/result') continue
    const callId = data.message?.toolCallId ?? data.toolCallId
    const started = pending.get(callId)
    if (started === undefined) continue
    pending.delete(callId)
    if (typeof event.time !== 'number') continue
    windows.push({ start: started, end: Math.max(event.time, started) })
  }
  windows.sort((left, right) => left.start - right.start)
  return windows
}

/**
 * Merge overlapping or near-adjacent windows, so a burst of commands is scanned
 * once and the union stays a faithful set of intervals.
 */
export function mergeWindows(windows, gapMs = MERGE_GAP_MS) {
  const merged = []
  for (const window of windows) {
    const last = merged[merged.length - 1]
    if (last !== undefined && window.start <= last.end + gapMs) {
      last.end = Math.max(last.end, window.end)
      continue
    }
    merged.push({ start: window.start, end: window.end })
  }
  return merged
}

/** Read `birthtime` and `mtime` for one path, or `undefined` when unreadable. */
const timesOf = async path => {
  try {
    const info = await stat(path, { bigint: true })
    return { birth: Number(info.birthtimeMs), mtime: Number(info.mtimeMs), size: Number(info.size) }
  } catch {
    return undefined
  }
}

/**
 * Enumerate the regular files under `root`, pruning the usual dependency and
 * build directories and never descending into a package the Session built.
 *
 * `cache` is shared with the caller so package detection is memoized across the
 * whole scan.
 */
export async function listWorkspaceFiles({ root, workspace, sessionRoot, dshHome, extraExcludes, cache = new Map(), cap = 200000 }) {
  const files = []
  const skippedDirs = []

  const walk = async dir => {
    if (files.length >= cap) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= cap) return
      const path = join(dir, entry.name)
      let isDirectory = entry.isDirectory()
      let isFile = entry.isFile()
      if (entry.isSymbolicLink()) {
        // A link is not evidence of creation; resolving it risks leaving the
        // workspace entirely.
        try {
          const info = await stat(path)
          isDirectory = info.isDirectory()
          isFile = info.isFile()
        } catch {
          continue
        }
        if (isDirectory) {
          skippedDirs.push({ path, reason: 'symlinked-directory' })
          continue
        }
      }
      if (isDirectory) {
        if (PRUNE_DIRS.has(entry.name)) {
          skippedDirs.push({ path, reason: `pruned:${entry.name}` })
          continue
        }
        const verdict = classifyCandidate({ sessionRoot, cwd: workspace, path, extraExcludes, dshHome })
        if (!verdict.allowed) {
          skippedDirs.push({ path, reason: verdict.reason })
          continue
        }
        const owner = await findProtectedAncestor(join(path, 'x'), workspace, cache)
        if (owner !== undefined) {
          skippedDirs.push({ path, reason: `inside-package:${owner.marker}` })
          continue
        }
        await walk(path)
        continue
      }
      if (isFile) files.push(path)
    }
  }

  await walk(resolve(root))
  return { files, skippedDirs }
}

/**
 * Attribute shell-created files to one Session.
 *
 * @param mine - this Session's merged creation windows.
 * @param others - every other Session's merged windows, for the uniqueness test.
 * @param files - candidate absolute paths (already fenced by the walker).
 * @returns `{ created, ambiguous }` absolute-path arrays.
 */
export async function attributeByCreationWindow({ mine, others, files, slackMs = DEFAULT_SLACK_MS }) {
  const created = []
  const ambiguous = []
  if (mine.length === 0) return { created, ambiguous }

  const inAny = (windows, birth) => windows.some(
    window => birth >= window.start - slackMs && birth <= window.end + slackMs,
  )

  for (const path of files) {
    const times = await timesOf(path)
    if (times === undefined) continue
    if (!inAny(mine, times.birth)) continue
    // A file two Sessions could both have created is claimed by neither: a
    // wrong attribution deletes something this Session never produced.
    if (inAny(others, times.birth)) {
      ambiguous.push(path)
      continue
    }
    created.push(path)
  }
  return { created, ambiguous }
}

/** Flatten every other Session's windows into one list for the uniqueness test. */
export const otherWindowsOf = (windowsBySession, ownSessionId) => {
  const others = []
  for (const [sessionId, windows] of windowsBySession) {
    if (sessionId === ownSessionId) continue
    others.push(...windows)
  }
  return others
}

export const DEFAULT_CREATION_SLACK_MS = DEFAULT_SLACK_MS
export { PRUNE_DIRS }
