import { lstat, mkdtemp, readdir, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Permanent removal of one Session's durable log.
 *
 * The persistence seam deliberately has **no deletion API** — its own contract
 * says logs accumulate under `root` until removed externally. So removing a
 * Session record means removing its directory from the filesystem, which this
 * module does on its own rather than delegating to another plugin.
 *
 * The layout is fixed and is validated as such:
 *
 *     <sessionRoot>/<project>/<sessionId>/session[.vN].jsonl[.zstd]
 *
 * Nothing here trusts the caller's path. The location is resolved through the
 * persistence backend, then every component is re-checked: it must be exactly
 * three segments under the root, the leaf must match the Session log name, and
 * neither the directories nor the file may be symlinks or escape the root once
 * resolved. Removal is a two-step quarantine — rename into a sibling temp
 * directory, re-verify identity there, then delete — so a failure part-way
 * leaves the original in place instead of a half-deleted directory.
 */

const failure = (code, message) => ({ ok: false, error: { code, message } })

/** The leaf names a Session log may use, across format generations. */
const SESSION_LOG_NAME = /^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/

const missing = error => error?.code === 'ENOENT'

const inside = (root, target) => {
  const path = relative(root, target)
  return path !== '' && !path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)
}

const pathExists = async path => {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (missing(error)) return false
    throw error
  }
}

/** Same file, judged on identity rather than name. */
const sameFile = (left, right) => (
  left.dev === right.dev
  && left.ino === right.ino
  && left.size === right.size
  && left.birthtimeNs === right.birthtimeNs
)

/**
 * Turn a resolved log path into the three directories this module operates on,
 * refusing anything that does not match the documented layout.
 *
 * @returns `{ root, projectDirectory, sessionDirectory, transcript }` or
 *   `undefined` when the path is not a per-session JSONL artifact.
 */
export function sessionPathsFor(sessionRoot, logPath) {
  if (typeof sessionRoot !== 'string' || sessionRoot.length === 0) return undefined
  if (typeof logPath !== 'string' || logPath.length === 0) return undefined
  const root = resolve(sessionRoot)
  const transcript = resolve(logPath)
  if (!isAbsolute(root) || !isAbsolute(transcript) || !inside(root, transcript)) return undefined
  const parts = relative(root, transcript).split(sep).filter(Boolean)
  if (parts.length !== 3) return undefined
  if (!SESSION_LOG_NAME.test(parts[2])) return undefined
  return {
    root,
    projectDirectory: join(root, parts[0]),
    sessionDirectory: join(root, parts[0], parts[1]),
    transcript,
  }
}

/**
 * Re-validate the located layout against the filesystem: every directory is a
 * real directory, the transcript is a real file, and none of them is a symlink
 * or resolves outside the root.
 */
async function validateExistingLocation(paths) {
  let root
  let project
  let directory
  let transcript
  try {
    [root, project, directory, transcript] = await Promise.all([
      realpath(paths.root),
      lstat(paths.projectDirectory, { bigint: true }),
      lstat(paths.sessionDirectory, { bigint: true }),
      lstat(paths.transcript, { bigint: true }),
    ])
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
  if (
    !project.isDirectory() || project.isSymbolicLink()
    || !directory.isDirectory() || directory.isSymbolicLink()
    || !transcript.isFile() || transcript.isSymbolicLink()
  ) return undefined

  const [resolvedProject, resolvedDirectory, resolvedTranscript] = await Promise.all([
    realpath(paths.projectDirectory),
    realpath(paths.sessionDirectory),
    realpath(paths.transcript),
  ])
  if (
    !inside(root, resolvedProject)
    || !inside(root, resolvedDirectory)
    || dirname(resolvedTranscript) !== resolvedDirectory
  ) return undefined
  return { root, resolvedDirectory, directory, transcript }
}

/**
 * Resolve the on-disk log of one Session through the persistence backend.
 *
 * Prefers the backend's own locator, which is authoritative about the current
 * format generation. Falls back to scanning the root for the Session's
 * directory when the backend does not expose one.
 */
export async function locateSessionLog({ sessionPersistence, sessionRoot, sessionId }) {
  if (typeof sessionPersistence?.resolveCurrentLog === 'function') {
    try {
      const logPath = await sessionPersistence.resolveCurrentLog(sessionId)
      if (typeof logPath === 'string' && logPath.length > 0) return logPath
    } catch {
      // A generation the backend refuses to name falls through to the scan.
    }
  }
  const root = resolve(sessionRoot)
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const project of projects) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue
    const candidate = join(root, project.name, sessionId)
    let entries
    try {
      entries = await readdir(candidate, { withFileTypes: true })
    } catch {
      continue
    }
    const log = entries.find(entry => entry.isFile() && SESSION_LOG_NAME.test(entry.name))
    if (log !== undefined) return join(candidate, log.name)
  }
  return undefined
}

/**
 * The only persistence backend whose layout this module may remove.
 *
 * `<root>/<project>/<sessionId>/session[.vN].jsonl[.zstd]` is the JSONL
 * backend's layout, so a different backend must be refused by name rather than
 * probed with directory surgery. Without this the layout check below still
 * refuses — but it reports "unsafe location", which reads like a corrupt store
 * instead of "this plugin does not support your storage backend".
 */
const SUPPORTED_BACKEND = 'session-persistence-jsonl'

/**
 * Permanently remove one Session's log directory.
 *
 * @param sessionId - the stored Session to delete.
 * @param beforeRemove - awaited after validation and before the directory is
 *   detached, so a caller can re-check that nothing reopened the Session.
 * @returns `{ ok: true, value: { deleted, alreadyAbsent? } }` or a failure.
 */
export async function deleteSessionLog({
  sessionPersistence,
  sessionRoot,
  sessionId,
  beforeRemove,
  moveDirectory = rename,
  removeDirectory = directory => rm(directory, { recursive: true, force: false }),
} = {}) {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.includes('\0')) {
    return failure('invalid-session-id', '会话 ID 无效。')
  }
  if (typeof sessionRoot !== 'string' || sessionRoot.length === 0) {
    return failure('unsupported-backend', '无法确定会话存储位置，未删除任何内容。')
  }
  // A backend that names itself and is not the JSONL one is refused up front.
  // (A double without a `name` skips this, which is what the tests rely on.)
  const backendName = sessionPersistence?.name
  if (typeof backendName === 'string' && backendName.length > 0 && backendName !== SUPPORTED_BACKEND) {
    return failure(
      'unsupported-backend',
      `当前会话存储后端是 ${backendName}，本插件只支持可按会话目录删除的 JSONL 后端，未删除任何内容。`,
    )
  }

  const logPath = await locateSessionLog({ sessionPersistence, sessionRoot, sessionId })
  if (logPath === undefined) {
    // Nothing names this Session's log. That is either a Session that never
    // materialized (nothing to delete) or an unreadable store — distinguish
    // them so a broken store is never reported as a successful deletion.
    if (await pathExists(resolve(sessionRoot))) {
      return { ok: true, value: { deleted: false, alreadyAbsent: true } }
    }
    return failure('storage-unreadable', '无法读取会话存储目录，未删除任何内容。')
  }

  // A log exists but does not match the per-session layout this module is
  // willing to remove. Refuse rather than fall back to a broader deletion.
  const paths = sessionPathsFor(sessionRoot, logPath)
  if (paths === undefined) {
    return failure('unsafe-location', '会话存储位置不符合可安全删除的布局，未删除任何内容。')
  }

  let validated
  try {
    validated = await validateExistingLocation(paths)
  } catch {
    return failure('storage-error', '读取会话存储失败，未删除任何内容。')
  }
  if (validated === undefined) {
    return failure('unsafe-location', '会话存储位置未通过安全校验，未删除任何内容。')
  }

  if (typeof beforeRemove === 'function') {
    const verdict = await beforeRemove()
    if (verdict !== undefined && verdict.ok === false) return verdict
  }

  let quarantineRoot
  let quarantinedDirectory
  let detached = false
  try {
    quarantineRoot = await mkdtemp(join(dirname(validated.root), '.dsh-session-artifacts-delete-'))
    quarantinedDirectory = join(quarantineRoot, basename(validated.resolvedDirectory))
    await moveDirectory(validated.resolvedDirectory, quarantinedDirectory)
    detached = true

    // Re-verify identity inside the quarantine: a path swapped between the
    // check above and the rename is restored rather than deleted.
    const quarantinedTranscript = join(quarantinedDirectory, basename(paths.transcript))
    const [directoryAfter, transcriptAfter] = await Promise.all([
      lstat(quarantinedDirectory, { bigint: true }),
      lstat(quarantinedTranscript, { bigint: true }),
    ])
    if (
      directoryAfter.isSymbolicLink()
      || transcriptAfter.isSymbolicLink()
      || !sameFile(validated.directory, directoryAfter)
      || !sameFile(validated.transcript, transcriptAfter)
    ) {
      await moveDirectory(quarantinedDirectory, validated.resolvedDirectory)
      detached = false
      await rm(quarantineRoot, { recursive: true, force: true }).catch(() => undefined)
      return failure('unsafe-location', '会话目录在删除期间发生了身份变化，未删除任何内容。')
    }

    await removeDirectory(quarantinedDirectory)
    if (await pathExists(quarantinedDirectory)) {
      return failure('storage-partial', '会话已摘除，但存储清理未完成，不能确认永久删除成功。')
    }
    await rm(quarantineRoot, { recursive: true, force: true }).catch(() => undefined)
    return { ok: true, value: { deleted: true } }
  } catch (error) {
    if (detached && quarantinedDirectory !== undefined) {
      let remains = true
      try {
        remains = await pathExists(quarantinedDirectory)
      } catch {
        // Unreadable is not proof of cleanup; keep the quarantine rather than
        // reporting a deletion that may not have happened.
      }
      if (remains) {
        return failure('storage-partial', '会话已摘除，但存储清理未完成，不能确认永久删除成功。')
      }
      if (quarantineRoot !== undefined) await rm(quarantineRoot, { recursive: true, force: true }).catch(() => undefined)
      return { ok: true, value: { deleted: true } }
    }
    if (quarantineRoot !== undefined) await rm(quarantineRoot, { recursive: true, force: true }).catch(() => undefined)
    if (missing(error)) return { ok: true, value: { deleted: false, alreadyAbsent: true } }
    return failure('storage-error', '删除会话存储失败，未删除任何内容。')
  }
}
