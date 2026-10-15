# Changelog

All notable changes to this plugin. Versions follow [Semantic Versioning](https://semver.org/).

Entries below `1.0.0` are pre-release: behaviour may change between minor versions.

## 0.7.2

Documentation packaging fix — no code changes.

- **Rename `README.zh.md` to `README-zh.md`.** npm chooses a package's readme
  with a `{README,README.*}` glob and takes the **first** match. `README.zh.md`
  matches that glob, so the published 0.7.1 rendered the **Chinese** text on
  npmjs.com while GitHub showed the English one — and because the glob order
  comes from the directory listing, the choice is not even stable across
  filesystems. Renaming moves the file outside both that glob and npm's
  always-included `readme.*` patterns, so npm now selects `README.md`
  deterministically. `README-zh.md` is listed in `files`, so the Chinese text
  still ships in the tarball.

  Two fixes that do **not** work, for the record: listing the file in `files`
  cannot exclude it (`readme.*` is always packed regardless), and neither can
  `.npmignore`.

## 0.7.1

Documentation only — no code changes.

- **Bilingual README.** `README.md` (English) and `README.zh.md` (Chinese), each
  linking to the other. `README.zh.md` is listed in `package.json` `files`;
  npm ships `README.md` unconditionally but would otherwise omit the Chinese one.
- **npm and license badges**, and an install line for the published package,
  since `dsh plugin add` resolves a bare package name through the registry.
- Records the model attribution line in both language files.

Note for anyone reading the registry entry: npm captures the README **at publish
time**, so the copy shown on the package page is a snapshot. This release exists
to refresh it.

## 0.7.0

Compatibility guards. This plugin reads a few things DSH does not publish as
public API, and a break in them would otherwise be silent — which matters more
than usual for software that deletes files.

- **Refuse a non-JSONL persistence backend by name.** The removal layout is the
  JSONL backend's, so a backend that names itself and is not
  `session-persistence-jsonl` is now refused with `unsupported-backend` instead
  of falling through to a layout check that reports `unsafe-location` (which
  reads like a corrupt store, not an unsupported one).
- **Detect an ineffective Agent-handle tracker.** Patching the registry can be
  silently swallowed when Cordis hands out a context-local proxy: the tracker
  looks installed and never records a handle. Effectiveness is now checked and
  reported through the capability probe rather than assumed.
- **Survive a service that refuses patching.** Assignment is attempted
  defensively, so a frozen or sealed registry degrades to "no handles" instead
  of throwing out of `apply()` and taking the plugin down.

## 0.6.0

- **Artifacts-only mode.** The dialog now has two independent checkboxes, so
  "delete the artifacts this session left behind, keep the conversation" is a
  supported action. Previously the session record was always deleted first and
  a failure there aborted the whole flow, so artifacts could not be cleaned up
  on their own.
- `deleteSession: false` now means *artifacts-only* rather than breaking the
  flow: the record checkbox is hidden and the log is never touched.

## 0.5.0

- **Delete a session that is currently open.** An open session is live even when
  idle, so its log writer is attached and its row returns after deletion. The
  registry exposes no `dispose`, so the plugin now keeps its own Agent-handle
  tracker, installed at apply time, and tears the Agent down through the handle
  the host gave its creator.
- Distinguish "no handle available" (needs a DSH restart) from "still
  unwinding" (retry) in the failure message. The previous message told the user
  to stop a session that was not running.
- `agents` is now a declared dependency: the tracker must exist before any Agent
  is created, and a tracker installed later captures nothing.

## 0.4.0

- **Self-contained.** The plugin removes the session record itself and no longer
  calls `dsh-chat-manager`'s `/plugins/dsh-session-delete` route, which made the
  whole flow fail with a bare `HTTP 405` whenever that plugin was disabled.
- Session-log removal against the validated JSONL layout, with a two-step
  quarantine: rename into a sibling directory, re-verify identity there, then
  delete. A failure part-way restores the original.
- Stop a running turn before teardown, and wait for the registries to drain.

## 0.3.0

- **Shell-created files are now attributed.** A `pwsh`/`bash` result carries no
  `meta`, so nothing durable names the files a command produced — yet that is
  where most leftovers come from.
- Attribution uses `birthtime` against per-command `[call, result]` windows. A
  whole-session window was measured to attribute 90 files a session never
  created.
- A file two sessions could have created is claimed by neither.
- The pass **fails closed**: if the sibling sessions cannot be enumerated it
  claims nothing and says so, rather than attributing files it cannot prove.

## 0.2.0

Safety fixes found by checking the plugin against 112 real session logs.

- **DSH home fence.** Nothing under `~/.dsh` is ever an artifact, whatever the
  session's working directory is. The workspace fence alone is `cwd`-relative,
  so a session opened at `~` or `C:\` could otherwise propose the installed
  plugins, the built skills, the profiles, and the credential store.
- **Package fence.** A file inside a directory that is a DSH package
  (`SKILL.md`, `cordis.patch.yml`, `cordis.yml`, or a `package.json` with a
  `dsh`/`cordis` block) is not offered, so a plugin or skill a session built in
  its own workspace survives.
- **`present` no longer makes a file deletable.** It records a hand-off, not
  authorship; 9 real files entered the deletable set on `present` alone.
- **Cross-drive fence.** On Windows `path.relative()` returns an absolute path
  across drives, which a fence checking only for `..` reads as "inside".
- **Relative paths resolve against the session's `cwd`**, not the Host process
  working directory.
- **Retryable partial failures.** A failed removal left the session log already
  gone and no way back to the list; a fresh nonce now covers the leftovers.
  Retry re-baselines the size but pins device + file index.

## 0.1.0

Initial release: delete a session together with the workspace artifacts it
produced, opt-in, previewed, and verified before removal.
