# Publishing

How to take this plugin from a local directory to `dsh plugin add` for other
people. Recorded from the actual checks run on this machine, so the commands and
the findings are reproducible rather than assumed.

## Before anything else

```sh
npm test          # 94 tests, 92 pass, 2 skipped
npm pack --dry-run
```

`npm pack --dry-run` prints the exact tarball. It must list the client bundle,
every `src/` module, `cordis.patch.yml`, `README.md`, `CHANGELOG.md`,
`LICENSE`, and `package.json` — and must **not** list `tests/` or anything
local. The current run is 13 files / ~38 kB.

**Both skips are known and deliberate:**

- the symlink test needs privileges this machine does not have, so the
  **POSIX symlink path is unverified**;
- the client bundle has no automated test — the dialog, its two checkboxes and
  the three modes are covered by manual runs only.

## 1. Fill in the identity fields

`LICENSE` and `package.json` still need the copyright holder. `repository`,
`homepage`, `bugs` and `author` are currently absent.

## 2. Repository

```sh
git init
git add -A
git commit -m "dsh-session-artifacts 0.7.0"
git remote add origin https://github.com/<owner>/dsh-session-artifacts.git
git push -u origin main
```

`.gitignore` already excludes `node_modules`, `*.tgz` and local scratch.

## 3. npm

The name `dsh-session-artifacts` was free when checked. Confirm again before
publishing — names cannot be reused after a successful publish.

```sh
npm publish --access public
```

Then verify the published artifact rather than trusting the output:

```sh
npm view dsh-session-artifacts version dist.tarball
```

## 4. Get listed in the market

The market's plugin list is generated from the curated
**`awesome-dsh-plugin`** registry. **Do not PR against the market repo** — its
README says so explicitly.

- Registry: `https://github.com/awesome-dsh-plugin/awesome-dsh-plugin`
- Add **one bullet** under the right category:

```markdown
- [<owner>/dsh-session-artifacts](https://github.com/<owner>/dsh-session-artifacts) - <one-line description>
```

Listing requirements, quoted from that README: the plugin installs with
`dsh plugin add`, declares a `dsh.bundle` manifest, does what its one-line
description says, sits in the right category, and is maintained. **Every
submission is checked against its own source before merging** — so the
description must be literally true of the code. The site and the market pick it
up automatically, usually within a day.

Suggested description, deliberately describing only what the code does:

> Delete a DSH session together with the workspace artifacts that session
> produced — reconstructs the file list from the session log, previews it with
> total size, and can also clean up the artifacts while keeping the
> conversation.

Category: session management rather than UI — the value is what gets deleted,
not a new panel. Note that session deletion alone is crowded (73 plugins in the
catalog); the artifact half is the differentiator, so lead with it.

## 5. After publishing

- Install from the registry in a **clean profile** to prove the published
  tarball is complete:

  ```sh
  dsh plugin --profile <fresh> add dsh-session-artifacts
  ```

- Re-run the manual UI checks: delete an open session, delete artifacts only,
  delete a record only, and confirm the confirm button is disabled when neither
  box is ticked.

## Known fragility worth stating in the README

This plugin reads four things DSH does not publish as public API. Two are
guarded and two degrade on their own — a DSH update can still break it, and it
deletes files, so that is a real risk rather than a theoretical one.

| Dependency | If it changes |
|---|---|
| `sessionPersistence.name` / `.resolveCurrentLog()` | Guarded: a named non-JSONL backend is refused with `unsupported-backend`. `resolveCurrentLog` has a directory-scan fallback. |
| `Symbol.for('cordis.original')` | Guarded: an ineffective patch is detected and reported through the capability probe. |
| `agents.create` / `.resume` / `.enter` | Guarded the same way. Installation is also crash-proof against a frozen service. |
| `agent.status` / `agent.cancel()` | Degrades on its own: a missing `cancel` refuses the deletion instead of assuming it worked. |
