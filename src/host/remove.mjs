import { lstat, readdir, realpath, rm, rmdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { classifyCandidate, inside } from './fence.mjs'

/**
 * Removal of already-previewed artifacts.
 *
 * Every file is re-verified immediately before it is unlinked: the preview
 * produced a snapshot, and anything that changed identity, changed size, or
 * turned into a symlink since then is skipped rather than removed. A path is
 * never removed twice, and a failure on one file never aborts the rest, so a
 * partial run reports exactly what it did.
 *
 * The caller receives `retry` — the preview entries that were *not* removed and
 * are still worth another attempt. A failed removal is not necessarily
 * permanent (a locked file, a transient sharing violation), and the Session log
 * is gone by the time this runs, so without `retry` the only way back to the
 * file list would be a fresh discovery that no longer exists.
 */

const missing = error => error?.code === 'ENOENT'

const sameFile = (left, right) => (
  left.dev === right.dev
  && left.ino === right.ino
  && left.size === right.size
)

/**
 * Remove one set of previewed files.
 *
 * @param files - preview entries carrying `path` and `bytes`.
 * @param cwd - the Session workspace every path must still live under.
 * @param sessionRoot - the Session store, excluded so a log is never an artifact.
 * @param dshHome - the DSH home; nothing under it is ever removable.
 * @returns `{ removed, failed, bytes, retry }` with per-path detail. `retry`
 *   holds the entries still worth another attempt.
 */
export async function removeArtifacts(files, {
  cwd,
  sessionRoot,
  dshHome,
  pruneEmptyDirs = true,
} = {}) {
  const workspace = resolve(cwd)
  let resolvedWorkspace
  try {
    resolvedWorkspace = await realpath(workspace)
  } catch {
    return {
      removed: [],
      failed: files.map(file => ({ path: file.path, reason: 'workspace-unreadable' })),
      bytes: 0,
      retry: [],
    }
  }

  const removed = []
  const failed = []
  const retry = []
  let bytes = 0
  const parents = new Set()

  for (const file of files) {
    const target = resolve(file.path)
    // Re-run the same fence discovery used, so removal cannot be talked into a
    // path that preview would have refused. classifyCandidate also rejects the
    // DSH home and the Session store, and its `inside` handles the cross-drive
    // case where `relative()` returns an absolute path.
    const verdict = classifyCandidate({ sessionRoot, cwd: workspace, path: target, dshHome })
    if (!verdict.allowed) {
      failed.push({ path: target, reason: verdict.reason })
      // A refused path is not a retry candidate: nothing about it will change.
      continue
    }

    // `bigint: true` is required for a trustworthy identity comparison on
    // Windows, where the number-valued `ino` is not the real file index.
    let info
    try {
      info = await lstat(target, { bigint: true })
    } catch (error) {
      if (missing(error)) {
        removed.push({ path: target, bytes: 0, alreadyGone: true })
        continue
      }
      failed.push({ path: target, reason: 'unreadable' })
      retry.push(file)
      continue
    }
    if (info.isSymbolicLink()) {
      failed.push({ path: target, reason: 'became-symlink' })
      continue
    }
    if (!info.isFile()) {
      failed.push({ path: target, reason: 'no-longer-a-regular-file' })
      continue
    }
    // A retry entry pins the device + file index observed when the retry nonce
    // was issued, so a path swapped for a different file between the two passes
    // is refused rather than deleted.
    if (file.ino !== undefined && (String(info.dev) !== file.dev || String(info.ino) !== file.ino)) {
      failed.push({ path: target, reason: 'identity-changed-since-preview' })
      continue
    }
    if (Number.isFinite(file.bytes) && info.size !== BigInt(file.bytes)) {
      failed.push({ path: target, reason: 'size-changed-since-preview' })
      // The preview size is stale by definition here, so reusing it would make
      // every retry fail the same check. The retry entry re-baselines the size
      // but pins the file *identity* (device + file index), which is the guard
      // that actually matters: a file that was edited in place is still the
      // path the user confirmed, while a file swapped for a different one is
      // refused on retry.
      retry.push({ ...file, bytes: Number(info.size), dev: String(info.dev), ino: String(info.ino) })
      continue
    }
    let real
    try {
      real = await realpath(target)
    } catch {
      failed.push({ path: target, reason: 'unreadable' })
      retry.push(file)
      continue
    }
    if (real !== resolvedWorkspace && !inside(resolvedWorkspace, real)) {
      failed.push({ path: target, reason: 'symlink-escapes-workspace' })
      continue
    }

    try {
      // Re-stat and compare identity right before the unlink, so a file
      // swapped between the check above and the removal is not destroyed.
      const current = await lstat(target, { bigint: true })
      if (!sameFile(info, current)) {
        failed.push({ path: target, reason: 'identity-changed-since-preview' })
        retry.push(file)
        continue
      }
      await rm(target, { force: false })
      removed.push({ path: target, bytes: Number(info.size) })
      bytes += Number(info.size)
      parents.add(dirname(target))
    } catch (error) {
      failed.push({ path: target, reason: missing(error) ? 'already-gone' : 'remove-failed' })
      // A transient failure (a lock, a sharing violation) is worth retrying;
      // a path that vanished is already in the desired state.
      if (!missing(error)) retry.push(file)
    }
  }

  if (pruneEmptyDirs) await pruneEmptyParents(parents, workspace)
  return { removed, failed, bytes, retry }
}

/**
 * Remove directories the deletion emptied, deepest first, stopping at the
 * workspace root and never touching a directory that still holds anything.
 */
async function pruneEmptyParents(parents, workspace) {
  const candidates = new Set()
  for (const parent of parents) {
    let current = parent
    while (current !== workspace && inside(workspace, current)) {
      candidates.add(current)
      current = dirname(current)
    }
  }
  const ordered = [...candidates].sort((left, right) => right.length - left.length)
  for (const directory of ordered) {
    try {
      const entries = await readdir(directory)
      if (entries.length !== 0) continue
      await rmdir(directory)
    } catch {
      // A non-empty or already-removed directory is not a failure worth
      // reporting: the artifacts themselves are what the user asked to remove.
    }
  }
}
