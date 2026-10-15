# dsh-session-artifacts

**This package is built by DeepSeek-v4.1 flash!**\

[![npm](https://img.shields.io/npm/v/dsh-session-artifacts.svg)](https://www.npmjs.com/package/dsh-session-artifacts)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**English** · [中文](#中文)

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
dsh plugin --profile <profile> add dsh-session-artifacts
```

Or from a checkout:

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

---

# 中文

[English](#dsh-session-artifacts) · **中文**

**本包由 DeepSeek-v4.1 flash 构建！**\

**清理会话留在你工作区里的东西** —— 需要时，连会话记录一起删掉。全部由你勾选、删除前预览、逐项复核。

对话没了，会话写下的脚本、报告和生成的文件却还留在原地。DSH 不记录那些文件是哪些，所以本插件从会话日志里把它们还原出来，在删除任何东西**之前**把完整清单和总大小摆给你看。

两种勾选框组合出三种模式：

- **只删产物、保留对话** —— 清理会话留下的烂摊子，但不丢会话。
- **删除会话记录** —— 可带产物，也可不带。
- **默认什么都不假设**：删产物那一项默认不勾。

它是**自包含**的：自己删除会话记录，不调用 `dsh-chat-manager` 的 `/plugins/dsh-session-delete` 路由，所以那个插件被禁用或不存在时，这个插件照常工作。

## 功能

1. 打开会话的 **⋯** 菜单，选择 **删除会话与产物…**
2. 对话框在你确认**之前**就列出确切文件清单和总大小。
3. 勾选你要删的内容。至少勾一项。
4. 确认。要删记录时它先走，然后再删预览过的那些文件。
5. 如果有文件删不掉，对话框会提供 **重试未删除的文件** —— 只重试那些路径，不是整个预览。

只删产物模式完全不涉及删会话：Host 把预览过的清单放在一个 nonce 后面，所以会话和它的日志原地不动，文件照样能删。

## 删除会话记录

持久化接缝是**刻意不提供删除 API** 的 —— 它自己的契约里写着日志会在 session root 下不断累积，直到被外部移除。所以本插件自己动手，按固定布局删除：

```
<sessionRoot>/<project>/<sessionId>/session[.vN].jsonl[.zstd]
```

位置通过持久化后端（`resolveCurrentLog`）解析，然后每个组成部分在动手前都会被重新校验：

- root 下恰好三段，末段是会话日志的文件名；
- 每层都是真实目录、日志是真实文件 —— 不认符号链接；
- 没有任何东西解析到 root 之外；
- 删除是**两步隔离**：先把目录改名到一个同级临时目录，在那里重新校验身份，确认无误才真删。中途失败会还原，而不是留下删了一半的残局。

### 停止已打开的会话

打开的会话**即使在空转也是活在宿主注册表里的**，它的日志写入器仍然挂着，直接删存储的话它那一行会重新出现在侧栏。必须在删存储之前把它拆掉 —— 而注册表**不提供 `dispose`**。

唯一受支持的拆除方式是 `AgentHandle`，而它只交给 Agent 的**创建者**。所以本插件维护**自己的句柄追踪器**：它观察共享 `agents` 服务上的 Agent 创建并保留每个句柄。删除时依次：

1. 取消正在运行的轮次（和「停止」按钮同一条路径）；
2. 通过句柄 dispose 该 Agent —— 这才是真正把它注销、并摘除其会话的动作；
3. 等两个注册表都排空，然后删除存储。

追踪器是本插件自己的，不是别的插件的 —— 所以那个插件被禁用时，这个能力不会跟着消失。

**有一种情况处理不了：** 在插件加载**之前**就已经活着的 Agent 没有捕获到句柄（句柄只给过它的创建者）。这种情况会拒绝删除，并提示你重启 DSH —— 重启后插件从一开始就能看到每个 Agent。之所以拒绝而不是直接在写入器底下删掉，是因为**谎报删除成功比删不掉更糟**。

## 文件如何被归因到会话

持久化的会话日志是「会话碰过什么」唯一的权威记录，所以归因就是从它里面读：

| 证据 | 含义 | 可删 |
|---|---|---|
| `write` 结果带 `meta.operation: "create"` | 会话创建了这个文件 | 是 |
| shell 命令时间窗 + 文件创建时间 | 文件在某条命令运行期间被创建 | 是，但须唯一 |
| `present` 调用 | 会话把文件交付给你 | **否**（仅报告） |
| `write` 结果带 `meta.operation: "update"` | 会话重写了一个已存在的文件 | **否** |
| `edit` 调用 | 会话只是改写了已存在的文件 | **否** |

重写一个你本来就拥有的文件，永远不会让它变成可删的，所以 `update` 和 `edit` 只报告、不提供删除。失败的工具调用（`FS_SANDBOX_DENIED`、`FS_NOT_OBSERVED`、`FS_STALE_VERSION` 等）不贡献任何东西，因为工具根本没创建出文件。

`present` 是**交付，不是创作**：否则一个会话只要把你本来就有的文件递给你一次，那个文件就变成可删的了。只有交付记录的文件会在对话框里计数，然后原封不动。设 `includeDelivered: true` 可切回旧的、更激进的行为。

### shell 创建的文件

文件工具的写入有明确记录，shell 命令没有：一次 `pwsh` 调用只记录命令文本，它的 `tool/result` **完全不携带 `meta`**，所以没有任何持久记录能指出 `python foo.py` 产出了哪些文件。而这在实践中是**最主要的**遗留来源 —— 一个通过 shell 写了二十个脚本的会话，产出的二十个产物，只读文件工具的实现一个都看不到。

剩下的证据是**创建时间**。在 NTFS 上 `birthtime` 是真实的创建时间戳，与 `mtime` 不同，而且后续编辑不会改变它 —— 所以它能回答「这个文件是不是在这条命令运行期间创建的？」。把每次 shell 的 `tool/call` 与它的 `tool/result` 配成对，就得到每条命令一个紧凑的时间窗。

三条规则保证安全：

- **窗口要紧。** 只算命令真正运行的那段时间。整会话窗口不可用：一个跑了两条命令、然后浏览了二十分钟的会话，否则会认领它一生中创建的所有文件。（在真实日志上实测：这样的会话在整会话跨度内有 90 个文件，在它真正的命令窗口内是 **0** 个。）
- **唯一性。** 同时落在两个会话窗口内的文件，两个都不认领 —— 因为错误归因会删掉这个会话从没创建过的东西。并发会话因此只会让结果变少，而不会让它变错。
- **失败即关闭（fail closed）。** 如果无法枚举兄弟会话，这一趟什么都不认领，并在对话框里说明。「只有我的窗口覆盖了它」这个结论，在不知道其他会话的情况下无法成立。

只认领「创建」。仅仅在窗口内**发生变化**的文件不是会话产出的，不动它。推断出来的文件在列表里标记为 `命令行` / `shell`，因为它们的证据比一条明确的写入记录要弱。

## 安全性

- **工作区围栏。** 一个会话只能提议它自己记录的工作目录之内的文件。
- **DSH home 围栏。** `~/.dsh` 之下的任何东西永远不算产物，**无论会话的工作目录是什么**。只靠工作区围栏是相对 `cwd` 的，所以一个在 `~` 或 `C:\` 打开的会话，否则就能碰到已安装的插件、构建好的技能、profile 和凭据存储。嵌套在 home 里的真实工作区（例如 `~/.dsh/scratch`）仍然拥有它自己的文件，但够不到邻居。
- **包围栏。** 位于「DSH 包」目录内的文件不予提供 —— 该目录含有 `SKILL.md`、`cordis.patch.yml`、`cordis.yml`，或一个带 `dsh`/`cordis` 字段的 `package.json` —— 所以会话在自己的工作区里构建出来的插件或技能能活下来。设 `protectPackages: false` 可关闭。
- **符号链接。** 真实路径通过符号链接逃出工作区的候选项会被跳过，预览和删除时都跳过。
- **不会删到过期目标。** 每个文件在 unlink 之前都会立刻重新校验；自预览之后大小或身份变过的文件会被跳过，而不是删掉。
- **相对路径相对会话的 cwd 解析**，绝不是 Host 进程的工作目录，所以 `report.md` 指的就是会话真正写的那个文件。
- **客户端永远不报路径。** Host 把预览过的集合放在一个一次性、10 分钟有效的 nonce 后面。用户从没见过的路径删不掉，nonce 也不能重放。
- **重试被钉住。** 重试条目会重新基准化文件大小（预览时的大小按定义已经过期），但会钉住它的 device + 文件索引，所以两次之间把路径换成另一个文件会被拒绝。
- **目录永不作为产物被删除。** 只提供普通文件；删除后变空的目录会被清理，并在工作区根处停止。
- **不做安全擦除。** 删除就是普通的 unlink。备份、云端副本、快照和文件系统级恢复都不在它的能力范围内。

## 配置

所有字段都是可选的；默认值就是安全的那些。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dshHome` | 自动推导 | 覆盖 home 围栏所用的 DSH home。否则取 `DSH_HOME`，否则取 `<home>/sessions` 存储的父目录。 |
| `extraExcludes` | `[]` | 额外的绝对路径，永不被提供。 |
| `protectPackages` | `true` | 拒绝 DSH 插件/技能包内的文件。 |
| `includeDelivered` | `false` | 也提供会话仅仅交付过的文件。 |
| `includeShell` | `true` | 运行 shell 创建时间窗这一趟。 |
| `shellSlackMs` | `5000` | 命令窗口两侧的余量，用来吸收事件时钟与文件系统时钟之间的偏差。 |
| `deleteSession` | `true` | Host 是否提供删除会话记录。设为 `false` 即变成只删产物：记录复选框隐藏，流程完全不碰日志。 |
| `lifecycleTimeoutMs` | `20000` | 等待一个已停止的会话离开活动注册表多久。 |

## 依赖要求

- 按会话存储的 JSONL 持久化后端（`sessionPersistence`），每个随附的组合都会挂载它。
- 活动 Agent 注册表（`agents`），由 `@deepseek-ai/dsh-agent` 提供。它是**声明式依赖**，因为句柄追踪器必须在任何 Agent 被创建**之前**装好 —— 装晚了什么都捕获不到。
- DSH 核心 `0.2.x`，用于它扩展的会话菜单与浮层插槽。

不需要任何其他插件 —— 尤其不需要 `dsh-chat-manager`。`sessions` 存在时会被使用，用于在拆除前停止正在运行的轮次。

## 已知限制

- shell 归因依赖 `birthtime`。在不记录真实创建时间的文件系统上，这一趟会什么都找不到，而不是去猜。
- 只识别**创建者**会话。一个会话创建、另一个会话后来编辑过的文件，仍然归给创建者。
- 通过一个接近窗口末尾才启动的长时间后台任务创建的文件，可能落在窗口之外。你预期以后要删的东西，优先用文件工具产生。
- 永不提供目录，所以一个只创建了目录（里面什么都没有）的会话会把它们留下。
- 预览是快照。预览之后创建的文件不在其中。
- 子代理会话记录自己的写入；删除父会话不会自动删除子会话的产物。
- **在本插件加载之前就已经打开的**会话无法拆除（没捕获到句柄），所以它的记录要等 DSH 重启后才能删除。删除它的产物仍然可用。
- 句柄追踪器观察的是共享的 `agents` 服务，所以它只看得见通过该服务创建的 Agent。用其他方式创建 Agent 的组合，行为等同于上面的「已存在」情况。

## 安装

```sh
dsh plugin --profile <profile> add dsh-session-artifacts
```

或从本地检出安装：

```sh
dsh plugin --profile <profile> add <path-to-this-directory>
```

然后重启 DSH，让 Host 半与客户端半完成组合。

## 卸载

```sh
dsh plugin --profile <profile> remove dsh-session-artifacts
```

卸载只移除这个插件本身，它绝不会自行删除任何会话或产物。

## 测试

```sh
npm test
```

测试套件覆盖：归因规则、shell 创建时间窗这一趟（含 fail-closed 路径与双会话歧义规则）、工作区 / DSH home / 包三道围栏、跨盘符路径、符号链接逃逸、身份复核、相对路径解析、空目录清理、nonce 一次性、重试 nonce、请求围栏，以及真实 `apply()` 的端到端接线。

## 许可

MIT
