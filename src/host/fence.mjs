import { lstat, readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * The path fences shared by artifact discovery and removal.
 *
 * These live in their own module so the file-tool path and the shell-command
 * path can never drift apart: both decide "may this path be treated as a
 * Session artifact?" through `classifyCandidate`, and both use the same
 * package-marker test.
 */

/** Files that mark a directory as a DSH package rather than a scratch artifact. */
const PACKAGE_MARKER_FILES = ['SKILL.md', 'cordis.patch.yml', 'cordis.yml']

export const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value)

export const missing = error => error?.code === 'ENOENT'

export const pathExists = async path => {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (missing(error)) return false
    throw error
  }
}

/** True when `target` is strictly below `root`. Handles the cross-drive case. */
export const inside = (root, target) => {
  const path = relative(root, target)
  return path !== '' && !path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)
}

/**
 * The DSH home (`~/.dsh`) that owns this Host's own state — installed plugins,
 * built skills, profiles, and credentials.
 *
 * Resolution order: the explicit config, then `DSH_HOME`, then the parent of
 * the Session store. The last step is taken only for the shipped
 * `<home>/sessions` layout: a store configured somewhere else would otherwise
 * turn its parent directory into a blanket exclusion and refuse the artifacts
 * of any workspace living there.
 */
export function resolveDshHome({ dshHome, sessionRoot } = {}) {
  if (typeof dshHome === 'string' && dshHome.length > 0) return resolve(dshHome)
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return resolve(fromEnv)
  if (typeof sessionRoot === 'string' && sessionRoot.length > 0) {
    const root = resolve(sessionRoot)
    if (basename(root).toLowerCase() === 'sessions') return dirname(root)
  }
  return undefined
}

/**
 * Refuse paths the plugin must never treat as a Session artifact.
 *
 * Two fences guard this:
 *
 * 1. The workspace fence — a Session may only ever propose files inside its own
 *    working directory.
 * 2. The DSH home fence — nothing under `~/.dsh` is ever a workspace artifact,
 *    whatever the Session's working directory happens to be. The workspace
 *    fence alone is relative to `cwd`, so a Session opened at `~` or `C:\`
 *    would otherwise be able to propose the installed plugins, the built
 *    skills, the profiles, and the credential store.
 *
 * A genuine workspace nested *inside* the DSH home (say `~/.dsh/scratch`) is
 * still allowed its own files; the home itself is not, so a Session opened at
 * `~/.dsh` cannot reach its neighbours.
 *
 * A directory that sits inside the workspace is `allowed` too — the caller
 * decides whether it is a file. That is what lets the shell scanner prune with
 * exactly the same rule it applies to files.
 */
export function classifyCandidate({ sessionRoot, cwd, path, extraExcludes = [], dshHome } = {}) {
  if (typeof path !== 'string' || path.length === 0) return { allowed: false, reason: 'empty-path' }
  if (path.includes('\0')) return { allowed: false, reason: 'invalid-path' }

  const workspace = (typeof cwd === 'string' && cwd.length > 0) ? resolve(cwd) : undefined
  const target = isAbsolute(path) ? resolve(path) : undefined

  // The DSH home fence is checked first: it must hold even when a Session has
  // no usable workspace, so it cannot depend on `cwd`.
  const home = resolveDshHome({ dshHome, sessionRoot })
  if (home !== undefined && target !== undefined) {
    const inHome = target === home || inside(home, target)
    const nestedWorkspace = workspace !== undefined
      && workspace !== home
      && inside(home, workspace)
    if (inHome && !(nestedWorkspace && inside(workspace, target))) {
      return { allowed: false, reason: 'inside-dsh-home' }
    }
  }

  if (workspace === undefined) return { allowed: false, reason: 'session-has-no-cwd' }
  const resolved = target ?? resolve(path)
  if (resolved === workspace) return { allowed: false, reason: 'is-workspace-root' }
  if (!inside(workspace, resolved)) return { allowed: false, reason: 'outside-workspace' }

  // DSH's own durable state (session logs) is never a workspace artifact.
  if (typeof sessionRoot === 'string' && sessionRoot.length > 0) {
    const root = resolve(sessionRoot)
    if (resolved === root || inside(root, resolved)) return { allowed: false, reason: 'inside-session-store' }
  }
  for (const excluded of extraExcludes) {
    if (typeof excluded !== 'string' || excluded.length === 0) continue
    const resolvedExclude = resolve(excluded)
    if (resolved === resolvedExclude || inside(resolvedExclude, resolved)) {
      return { allowed: false, reason: 'excluded' }
    }
  }
  return { allowed: true, target: resolved }
}

/**
 * A directory that is a DSH package — a built plugin or a skill — is not a
 * disposable artifact. Detecting the marker lets a plugin or skill that a
 * Session built inside its own workspace survive, without hard-coding where
 * such a project lives.
 */
export const detectPackageDir = async dir => {
  for (const marker of PACKAGE_MARKER_FILES) {
    if (await pathExists(join(dir, marker))) return marker
  }
  try {
    const parsed = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    if (isRecord(parsed) && (isRecord(parsed.dsh) || isRecord(parsed.cordis))) return 'package.json:dsh'
  } catch {
    // No readable manifest here.
  }
  return undefined
}

/**
 * Walk up from `target` to the workspace root looking for a package marker.
 * `cache` memoizes per directory so a large scan stats each directory once.
 */
export const findProtectedAncestor = async (target, workspace, cache) => {
  let current = dirname(target)
  while (current === workspace || inside(workspace, current)) {
    let verdict = cache.get(current)
    if (verdict === undefined) {
      verdict = (await detectPackageDir(current)) ?? null
      cache.set(current, verdict)
    }
    if (verdict !== null) return { dir: current, marker: verdict }
    if (current === workspace) break
    current = dirname(current)
  }
  return undefined
}
