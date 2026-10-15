# dsh-session-artifacts

**This package is built by DeepSeek-v4.1 flash!**
**Clean up what a session left in your workspace** — and, when you want it,
delete the session record too. Opt-in, previewed, and verified before anything
is removed.

A session's scripts, reports and generated files stay behind after the
conversation is gone. Nothing in DSH records which files those were, so this
plugin reconstructs that from the session log and shows you the exact list —
with the total size — before anything is deleted.

Three things it can do, chosen by two checkboxes in one dialog:

- **Delete the artifacts, keep the conversation** — tidy up a session's mess
  without losing the session.
- **Delete the session record** — with or without its artifacts.
- **Neither is assumed**: the artifact step is off by default.

It is **self-contained**: it removes the session record itself and does not call
`dsh-chat-manager`'s `/plugins/dsh-session-delete` route, so it keeps working
when that plugin is disabled or absent.

## What it does

1. Open the session's **⋯** menu and pick **Delete session and artifacts…**
2. The dialog shows the exact file list and total size **before** you commit.
3. Tick what you want removed. At least one box must be ticked.
4. Confirm. When the record is being removed it goes first, then the previewed
   files.
5. If a file could not be removed, the dialog offers **Retry the files left
   behind** — it retries exactly those paths, not the whole preview.

The artifacts-only mode needs no session deletion at all: the Host holds the
previewed list behind a nonce, so the files are removable while the session and
its log stay exactly where they are.

## Deleting the session record

The persistence seam deliberately has **no deletion API** — its own contract
states that logs accumulate under the session root until removed externally. So
this plugin performs the removal itself, against the fixed layout:

```
<sessionRoot>/<project>/<sessionId>/session[.vN].jsonl[.zstd]
```

The location is resolved through the persistence backend
(`resolveCurrentLog`), then every component is re-checked before anything is
touched:

- exactly three segments under the root, with a session-log leaf name;
- each directory is a real directory and the log a real file — no symlinks;
- nothing resolves outside the root;
- removal is a **two-step quarantine**: the directory is renamed into a sibling
  temp directory, its identity is re-verified there, and only then deleted. A
  failure part-way restores the original rather than leaving it half-deleted.

### Stopping a session that is open

An open session is **live in the host registries** even when nothing is running
in it, so its log writer is still attached and its row would reappear in the
sidebar. It has to be torn down before its storage can go — and the registry
exposes no `dispose`.

The only supported teardown is the `AgentHandle` returned to whoever *created*
the Agent, so this plugin keeps its **own handle tracker**: it observes Agent
creation on the shared `agents` service and retains each handle. Deletion then:

1. cancels a running turn (the same path the Stop button uses);
2. disposes the Agent through its handle — this is what unregisters it and
   detaches its Session;
3. waits for both registries to drain, then removes the storage.

The tracker is this plugin's own rather than another plugin's, so the capability
does not go away when that plugin does.

**One case cannot be handled:** an Agent that was already live *before* the
plugin loaded has no captured handle (the handle was only ever given to its
creator). That deletion is refused with a message telling you to restart DSH —
after a restart the plugin sees every Agent from the start. It is refused rather
than deleted underneath its writer, because reporting a deletion that did not
happen is worse than not deleting.

## How a file is attributed to a session

The durable session log is the only authoritative record of what a session
touched, so attribution is read from it:

| Evidence | Meaning | Deletable |
|---|---|---|
| `write` result with `meta.operation: "create"` | the session materialized the file | yes |
| shell command window + file creation time | the file was created while a command ran | yes, if unique |
| `present` call | the session delivered the file | **no** (reported only) |
| `write` result with `meta.operation: "update"` | the session rewrote a file that already existed | **no** |
| `edit` call | the session only rewrote an existing file | **no** |

Rewriting a file you already owned never makes it disposable, so `update` and
`edit` results are reported but never offered. A failed tool call
(`FS_SANDBOX_DENIED`, `FS_NOT_OBSERVED`, `FS_STALE_VERSION`, …) contributes
nothing, because the tool never materialized anything.

`present` is **delivery, not authorship**: a session asked to hand you a paper
you already had would otherwise make that paper deletable. Delivered-only files
are counted in the dialog and left alone. Set `includeDelivered: true` to opt
into the older, more aggressive behavior.

### Shell-created files

File-tool writes are recorded explicitly. Shell commands are not: a `pwsh` call
records only its command text, and its `tool/result` carries no `meta` at all,
so nothing durable names the files a `python foo.py` run produced. In practice
this is the *dominant* source of leftovers — a session that writes twenty
scripts through the shell produces twenty artifacts that a file-tool-only
reader never sees.

The remaining evidence is **creation time**. On NTFS `birthtime` is a real
creation timestamp, distinct from `mtime`, and it survives later edits — so it
answers "was this file created while this command was running?". Pairing each
shell `tool/call` with its `tool/result` gives a tight window per command.

Three rules keep this safe:

- **Tight windows.** Only the interval a command actually ran counts. A
  whole-session window is unusable: a session that ran two commands and then
  spent twenty minutes browsing would otherwise claim every file created during
  its lifetime. (Measured on a real log: such a session had 90 files inside its
  session-wide span and **0** inside its actual command windows.)
- **Uniqueness.** A file created inside two sessions' windows is attributed to
  neither, because a wrong attribution deletes something this session never
  made. Concurrent sessions therefore reduce the result instead of corrupting
  it.
- **Fail closed.** If the sibling sessions cannot be enumerated, the pass
  claims nothing and says so in the dialog. "Only my window covers it" cannot
  be established without knowing the others.

Only creation is claimed. A file that merely *changed* during a window was not
produced by the session and is left alone. Inferred files are labelled
`命令行` / `shell` in the list, since they rest on weaker evidence than a
recorded write.

## Safety

- **Workspace fence.** A session may only ever propose files inside its own
  recorded working directory.
- **DSH home fence.** Nothing under `~/.dsh` is ever an artifact, *whatever the
  session's working directory is*. The workspace fence alone is relative to
  `cwd`, so a session opened at `~` or `C:\` could otherwise reach the
  installed plugins, the built skills, the profiles, and the credential store.
  A genuine workspace nested inside the home (e.g. `~/.dsh/scratch`) still owns
  its own files, but cannot reach its neighbours.
- **Package fence.** A file inside a directory that is a DSH package — it holds
  `SKILL.md`, `cordis.patch.yml`, `cordis.yml`, or a `package.json` with a
  `dsh`/`cordis` block — is not offered, so a plugin or skill the session built
  inside its own workspace survives. Set `protectPackages: false` to disable.
- **Symlinks.** A candidate whose real path escapes the workspace through a
  symlink is skipped, both at preview and at removal time.
- **No stale deletions.** Every file is re-checked immediately before it is
  unlinked; a file whose size or identity changed since the preview is skipped
  rather than removed.
- **Relative paths resolve against the session's cwd**, never the Host process
  working directory, so `report.md` means the file the session actually wrote.
- **The client never names paths.** The Host holds the previewed set behind a
  single-use, 10-minute nonce. A path the user was never shown cannot be
  deleted, and a nonce cannot be replayed.
- **Retry is pinned.** A retry entry re-baselines the file's size (the preview
  size is stale by definition) but pins its device + file index, so a path
  swapped for a different file between the two passes is refused.
- **Directories are never deleted as artifacts.** Only regular files are
  offered; directories the deletion empties are pruned, stopping at the
  workspace root.
- **No secure erasure.** Removal is an ordinary unlink. Backups, cloud copies,
  snapshots, and filesystem-level recovery are outside its scope.

## Configuration

All fields are optional; the defaults are the safe ones.

| Field | Default | Meaning |
|---|---|---|
| `dshHome` | derived | Overrides the DSH home used by the home fence. Otherwise `DSH_HOME`, otherwise the parent of a `<home>/sessions` store. |
| `extraExcludes` | `[]` | Extra absolute paths that must never be offered. |
| `protectPackages` | `true` | Refuse files inside a DSH plugin/skill package. |
| `includeDelivered` | `false` | Also offer files the session merely delivered. |
| `includeShell` | `true` | Run the shell creation-window pass. |
| `shellSlackMs` | `5000` | Slack around a command window, absorbing the gap between the event clock and the filesystem clock. |
| `deleteSession` | `true` | Whether the Host offers session-record deletion. `false` makes the plugin artifacts-only: the record checkbox is hidden and the flow never touches the log. |
| `lifecycleTimeoutMs` | `20000` | How long to wait for a stopped session to leave the live registries. |

## Requirements

- The per-session JSONL session-persistence backend (`sessionPersistence`),
  which every shipped composition mounts.
- The live Agent registry (`agents`), provided by `@deepseek-ai/dsh-agent`. It
  is a **declared dependency**, because the handle tracker must be installed
  before any Agent is created — a tracker installed later captures nothing.
- DSH core `0.2.x` for the session-menu and overlay slots it extends.

No other plugin is required — in particular nothing from `dsh-chat-manager`.
`sessions` is used when present, to stop a running turn before teardown.

## Limitations

- Shell attribution relies on `birthtime`. On a filesystem that does not record
  a true creation time, the shell pass finds nothing rather than guessing.
- Only the *creating* session is detected. A file one session created and
  another later edited stays attributed to the creator.
- A session that creates a file through a long-running background job started
  near the end of its window may fall outside the window. Prefer the file tools
  for anything you expect to delete later.
- Directories are never offered, so a session that only created directories
  (and nothing inside them) leaves them behind.
- The preview is a snapshot. Files created after it are not included.
- Subagent sessions record their own writes; deleting a parent does not
  automatically delete a child's artifacts.
- A session that was **already open before this plugin loaded** cannot be torn
  down (no handle was captured), so its record cannot be deleted until DSH is
  restarted. Deleting its artifacts still works.
- The handle tracker observes the shared `agents` service, so it only sees
  Agents created through it. A composition that creates Agents some other way
  behaves like the pre-existing case above.

## Install

```sh
dsh plugin --profile <profile> add <path-to-this-directory>
```

Then restart DSH for the Host and client halves to compose.

## Uninstall

```sh
dsh plugin --profile <profile> remove dsh-session-artifacts
```

Uninstalling removes only this plugin. It never deletes sessions or artifacts
on its own.

## Tests

```sh
npm test
```

The suites cover attribution rules, the shell creation-window pass (including
the fail-closed path and the two-session ambiguity rule), the workspace / DSH
home / package fences, cross-drive paths, symlink escapes, identity
re-verification, relative-path resolution, empty-directory pruning, nonce
single-use, the retry nonce, the request fence, and the real `apply()` wiring
end to end.

## License

MIT
