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

## 1. Identity fields

Done: `LICENSE` (MIT, `ShirohaChan`) and the `author`, `repository`, `homepage`
and `bugs` fields in `package.json` are filled in. The commit identity uses
GitHub's noreply address (`139953471+ShirohaChan@users.noreply.github.com`) so
no real email is published.

## 2. Repository

Done — `main` at `6b4bc1e`, tracked against
`https://github.com/ShirohaChan/dsh-session-artifacts.git`.

```sh
git push          # subsequent pushes
```

`.gitignore` excludes `node_modules`, `*.tgz` and local scratch.

### Network and authentication on this machine

Both were measured rather than assumed, and the first two attempts failed, so
the working configuration is recorded here.

**`github.com` is not reachable directly.** `git clone`/`push` over HTTPS stall
or reset, `raw.githubusercontent.com` resets, and **SSH is unusable** — port 22
and `ssh.github.com:443` complete the TCP handshake and then hang, which is why
the generated `~/.ssh/id_ed25519` is not registered anywhere. What does work
directly: `api.github.com`, `codeload.github.com`, and `registry.npmjs.org`.

A local proxy (v2rayN / xray) listens on `127.0.0.1:10808` as a **mixed
inbound** — it answers both SOCKS5 and HTTP. Both schemes carry git's own
traffic, but **only `http://` works for authentication**:

```sh
git config --local http.https://github.com.proxy http://127.0.0.1:10808
```

> `socks5h://` makes git's transport work but breaks the credential helper:
> GCM is .NET and its `ServicePointManager` rejects the `socks5h` scheme with
> *"不支持具有 socks5h 方案的代理"*. That failure surfaces late, as
> `could not read Username for 'https://github.com'`, which reads like a missing
> credential rather than a bad proxy scheme.

The proxy is configured **per repository**, not globally, so other repositories
are unaffected. It also requires the proxy client's *system* proxy to be on, for
the credential helper's own OAuth calls.

**No PAT is needed.** Git Credential Manager ships with this Git installation
(v2.7.3, under `AppData/Local/hermes/git/mingw64/bin`) — note it is *not* in
`C:\Program Files\Git`, which is why a search there finds nothing. GCM
authenticates through the browser once, then stores the token in Windows
Credential Manager (`git:https://github.com`), so later pushes need no prompt:

```sh
git config --local credential.helper ""        # reset the inherited helper-selector
git config --local --add credential.helper manager
git config --local credential.https://github.com.provider github
```

The browser flow shows a **"Connect to GitHub"** window; completing it once is
the whole authentication step.

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
