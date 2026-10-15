// DSH Session Artifacts — delete a session together with the workspace
// artifacts that session produced.
//
// The artifact step is opt-in and OFF by default: the checkbox below is the
// only thing that turns it on, and until it is checked the flow is exactly the
// existing session deletion. The file list the user is about to lose is shown
// before anything is removed, and the Host holds that list behind a nonce so
// the client never names paths itself.
window.__ModuleLoader__.load({
  id: "dsh-session-artifacts",
  factory: require => {
    const React = require("react");
    const ui = require("@deepseek-ai/dsh-client-ui-primitives");

    const h = React.createElement;
    const PREVIEW_ROUTE = "/plugins/dsh-session-artifacts/preview";
    const REMOVE_ROUTE = "/plugins/dsh-session-artifacts/remove";
    const CAPABILITY_ROUTE = "/plugins/dsh-session-artifacts/capability";
    // This plugin removes the session record itself. It deliberately does NOT
    // call dsh-session-delete: that route belongs to dsh-chat-manager, and
    // depending on it would make this plugin unusable whenever that one is
    // disabled.
    const DELETE_ROUTE = "/plugins/dsh-session-artifacts/delete-session";

    function register(ctx) {
      const listeners = new Set();
      let disposed = false;
      const controller = new AbortController();
      let state = {
        target: null,          // { id, title }
        deleteRecord: true,    // remove the session record (off ⇒ artifacts only)
        includeArtifacts: false,
        preview: null,         // { total, bytes, files, nonce }
        previewLoading: false,
        previewError: "",
        busy: false,
        deleted: false,        // the operation finished
        recordKept: false,     // the record was deliberately left in place
        error: "",
        summary: null,         // removal outcome shown after the fact
        retryNonce: undefined, // a fresh nonce covering only the files left behind
        capability: null,      // what this Host can do, asked before committing
        alreadyAbsent: false,  // the record was already gone when we looked
      };

      const publish = value => {
        if (disposed) return;
        state = { ...state, ...value };
        for (const listener of listeners) listener();
      };
      const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
      const snapshot = () => state;
      const reset = () => publish({
        target: null, deleteRecord: true, includeArtifacts: false, preview: null, previewLoading: false,
        previewError: "", busy: false, deleted: false, recordKept: false, error: "", summary: null,
        retryNonce: undefined, alreadyAbsent: false,
      });

      const text = (zh, en) => ctx.locale.getSnapshot().active === "zh" ? zh : en;
      const danger = { color: "var(--dsw-alias-state-error-primary)" };

      async function postJson(url, body, headers) {
        const response = await fetch(url, {
          method: "POST", signal: controller.signal,
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        });
        let payload;
        try { payload = await response.json(); } catch { payload = undefined; }
        return { response, payload };
      }

      // Ask the Host what it can do before offering the action. Without this,
      // a Host that cannot delete a session record would only reveal that after
      // the user had already confirmed a destructive step.
      async function loadCapability() {
        try {
          const response = await fetch(CAPABILITY_ROUTE, { method: "GET", signal: controller.signal });
          if (!response.ok) return;
          const payload = await response.json().catch(() => undefined);
          if (disposed || payload?.ok !== true) return;
          // A Host that cannot remove the record still removes artifacts, so the
          // record step is turned off rather than offered and then failed.
          publish({
            capability: payload.value,
            ...(payload.value?.deleteSession === false ? { deleteRecord: false } : {}),
          });
        } catch {
          // A missing capability probe is not fatal; the delete call itself
          // reports the real reason.
        }
      }

      async function loadPreview(sessionId) {
        publish({ previewLoading: true, previewError: "", preview: null });
        try {
          const { response, payload } = await postJson(
            PREVIEW_ROUTE, { sessionId }, { "x-dsh-session-artifacts-action": "preview-artifacts" });
          if (!response.ok || payload?.ok !== true) {
            throw Error(payload?.error?.message || `HTTP ${response.status}`);
          }
          if (disposed || state.target?.id !== sessionId) return;
          publish({ preview: payload.value, previewLoading: false });
        } catch (error) {
          if (disposed) return;
          publish({ previewError: error.message || String(error), previewLoading: false });
        }
      }

      async function refreshViews() {
        const sessions = ctx.get("sessions");
        const workspaces = ctx.get("workspaces");
        const workspace = ctx.get("uiWorkspace");
        // The Host event may already have removed the row; read the view's
        // selection rather than row retention so a different newly opened view
        // is never cleared.
        if (workspace?.selection?.getSnapshot?.().sessionId === state.target?.id) workspace.clearMain();
        const settled = await Promise.allSettled([
          typeof sessions?.refresh === "function" ? sessions.refresh() : Promise.resolve(),
          typeof workspaces?.refresh === "function" ? workspaces.refresh() : Promise.resolve(),
        ]);
        for (const item of settled) {
          if (item.status === "rejected") console.warn("Session deleted; list refresh failed:", item.reason);
        }
      }

      // One artifact removal pass. Called after the session record is gone, and
      // again for a retry pass using the fresh nonce the Host issues for the
      // files a partial run left behind.
      async function runRemoval(nonce) {
        let summary = null;
        let removalError = "";
        try {
          const { response, payload } = await postJson(
            REMOVE_ROUTE, { nonce }, { "x-dsh-session-artifacts-action": "delete-artifacts" });
          if (!response.ok || payload?.ok !== true) {
            throw Error(payload?.error?.message || `HTTP ${response.status}`);
          }
          summary = payload.value;
        } catch (error) {
          removalError = error.message || String(error);
        }
        return { summary, removalError };
      }

      async function confirm() {
        if (disposed || state.busy || !state.target) return;
        const target = state.target;
        const wantsRecord = state.deleteRecord;
        const wanted = state.includeArtifacts ? state.preview : null;
        publish({ busy: true, error: "" });

        // The session log goes first when the record is being removed: it is the
        // only record of what the session produced, and the Host already holds
        // the previewed list, so the artifacts stay removable after it is gone.
        // When the record is being kept, this step is skipped entirely.
        if (wantsRecord) {
          try {
            const { response, payload } = await postJson(
              DELETE_ROUTE, { sessionId: target.id }, { "x-dsh-session-artifacts-action": "delete-session" });
            if (!response.ok || payload?.ok !== true) {
              // A 409 carries a structured reason (still running, unsafe
              // location, …). Surface that text rather than a status code.
              throw Error(payload?.error?.message || `HTTP ${response.status}`);
            }
            // `alreadyAbsent` means the record was already gone; the artifact
            // step is still worth running, so this is not an error.
            if (payload.value?.alreadyAbsent === true) {
              publish({ deleted: true, alreadyAbsent: true });
            }
          } catch (error) {
            if (disposed) return;
            publish({ busy: false, error: error.message || String(error) });
            return;
          }
        }

        if (disposed) return;
        publish({ deleted: true, recordKept: !wantsRecord });

        let summary = null;
        let removalError = "";
        if (wanted?.nonce) {
          const outcome = await runRemoval(wanted.nonce);
          summary = outcome.summary;
          removalError = outcome.removalError;
        }

        if (disposed) return;
        // The session list only needs refreshing when a record actually left.
        if (wantsRecord) {
          await refreshViews().catch(reason => console.warn("Session deleted; list refresh failed:", reason));
          if (disposed) return;
        }

        // Keep the dialog open only when the artifact step needs reporting.
        if (removalError !== "" || (summary?.failed?.length ?? 0) > 0) {
          publish({ busy: false, summary, error: removalError, retryNonce: summary?.retryNonce });
          return;
        }
        // An artifacts-only run has a summary worth showing, so it stays open
        // until dismissed rather than closing silently.
        if (!wantsRecord && (wanted?.nonce !== undefined || (wanted?.total ?? 0) > 0)) {
          publish({ busy: false, summary, error: "" });
          return;
        }
        reset();
      }

      // Retry only the files the previous pass could not remove. The Host holds
      // that exact list behind `retryNonce`, so this cannot widen the set.
      async function retry() {
        if (disposed || state.busy || !state.retryNonce) return;
        const nonce = state.retryNonce;
        publish({ busy: true, error: "" });
        const { summary, removalError } = await runRemoval(nonce);
        if (disposed) return;
        if (removalError !== "" || (summary?.failed?.length ?? 0) > 0) {
          publish({ busy: false, summary, error: removalError, retryNonce: summary?.retryNonce });
          return;
        }
        reset();
      }

      function ArtifactDeleteMenuItem({ sessionId, displayTitle, useMenuOpenState }) {
        const [, closeMenu] = useMenuOpenState();
        return h(ui.MenuItemButton, {
          danger: true,
          icon: h(ui.IconTrashOutlineRegular, {}),
          onSelect: () => {
            closeMenu(false);
            if (disposed || state.busy) return;
            reset();
            publish({ target: { id: sessionId, title: displayTitle || sessionId } });
            // Ask what this Host supports while the user reads the dialog.
            loadCapability();
          },
        }, text("删除会话与产物…", "Delete session and artifacts…"));
      }

      function FileRow(file) {
        return h("li", {
          key: file.display,
          style: {
            display: "flex", gap: 8, alignItems: "baseline",
            padding: "2px 0", minWidth: 0,
          },
        },
          h("span", {
            style: { flex: 1, minWidth: 0, overflowWrap: "anywhere",
              fontFamily: "var(--dsw-font-mono, monospace)", fontSize: 12 },
          }, file.display),
          // A file inferred from a command's time window is weaker evidence
          // than one the file tools recorded, so it is labelled.
          file.tool === "shell" && h("span", {
            style: { flexShrink: 0, opacity: 0.6, fontSize: 11 },
            title: text("由命令行创建，按创建时间归属", "Created by a shell command, attributed by creation time"),
          }, text("命令行", "shell")),
          h("span", {
            style: { flexShrink: 0, opacity: 0.65, fontSize: 12 },
          }, ui.fileSizeText(file.bytes)));
      }

      // Explain the shell-command pass, because its scope is the difference
      // between "the files this session wrote" and "every file it touched".
      // When the pass declines to claim anything, say so rather than letting an
      // empty list read as "this session produced nothing".
      function ShellNotice() {
        const preview = state.preview;
        const shell = preview?.shell;
        if (!shell || shell.enabled !== true) return null;
        const style = { margin: 0, opacity: 0.65, fontSize: 12 };
        if (shell.declined === "sibling-windows-unavailable") {
          return h("p", { style }, text(
            "该会话还运行过命令行，但无法枚举同一工作区的其他会话，因此未按时间推断命令行产物。",
            "This session also ran shell commands, but the other sessions in this workspace could not be enumerated, so shell-produced files were not inferred by time."));
        }
        if ((shell.windows ?? 0) === 0) return null;
        const parts = [];
        if ((shell.attributed ?? 0) > 0) {
          parts.push(text(
            `其中 ${shell.attributed} 个由命令行创建（按创建时间归属）。`,
            `${shell.attributed} of these were created by shell commands (attributed by creation time).`));
        }
        if ((shell.ambiguous ?? 0) > 0) {
          parts.push(text(
            `另有 ${shell.ambiguous} 个文件落在多个会话的命令时间窗内，无法确定归属，已跳过。`,
            `A further ${shell.ambiguous} files fell inside more than one session's command window and were skipped as unattributable.`));
        }
        if (parts.length === 0) {
          return h("p", { style }, text(
            `该会话运行过 ${shell.windows} 段命令行，但没有发现由它们创建的残留文件。`,
            `This session ran ${shell.windows} shell command window(s), but no leftover files from them were found.`));
        }
        return h("p", { style }, parts.join(" "));
      }

      function ArtifactPreview() {
        if (state.previewLoading) {
          return h("p", { style: { opacity: 0.7 } }, text("正在查找该会话留下的产物…", "Looking for artifacts this session produced…"));
        }
        if (state.previewError) {
          return h("p", { role: "alert", style: danger }, state.previewError);
        }
        const preview = state.preview;
        if (preview === null) return null;
        if (preview.noWorkspace) {
          return h("p", { style: { opacity: 0.7 } }, text("该会话没有工作目录，无法确定产物位置。", "This session has no working directory, so its artifacts cannot be located."));
        }
        if (preview.total === 0) {
          return h("div", { style: { display: "grid", gap: 6 } },
            h("p", { style: { margin: 0, opacity: 0.7 } }, text("没有找到可删除的产物。", "No removable artifacts were found.")),
            h(ShellNotice, null));
        }
        return h("div", { style: { display: "grid", gap: 6 } },
          h("p", { style: { margin: 0 } }, text(
            `将删除 ${preview.total} 个文件，共 ${ui.fileSizeText(preview.bytes)}：`,
            `Will delete ${preview.total} files, ${ui.fileSizeText(preview.bytes)} total:`)),
          h("ul", {
            style: {
              margin: 0, padding: "6px 10px", listStyle: "none", maxHeight: 200, overflowY: "auto",
              background: "var(--dsw-alias-bg-layer-2)", borderRadius: 8,
              border: "1px solid var(--dsw-alias-border-l1)",
            },
          }, preview.files.map(FileRow)),
          h(ShellNotice, null),
          preview.skipped > 0 && h("p", { style: { margin: 0, opacity: 0.65, fontSize: 12 } }, text(
            `另有 ${preview.skipped} 个候选被跳过（已在工作区外、位于 DSH 自身目录或插件/技能包内、已不存在或不是普通文件）。`,
            `${preview.skipped} further candidates were skipped (outside the workspace, inside DSH's own directories or a plugin/skill package, already gone, or not a regular file).`)),
          (preview.delivered ?? 0) > 0 && h("p", { style: { margin: 0, opacity: 0.65, fontSize: 12 } }, text(
            `另有 ${preview.delivered} 个文件只是被该会话交付过（并非由它创建），不会删除。`,
            `${preview.delivered} further files were only delivered by this session (not created by it) and will not be deleted.`)),
          (preview.updated ?? 0) > 0 && h("p", { style: { margin: 0, opacity: 0.65, fontSize: 12 } }, text(
            `另有 ${preview.updated} 个文件是被改写而非创建的，不会删除。`,
            `${preview.updated} further files were rewritten rather than created, and will not be deleted.`)));
      }

      function RemovalSummary() {
        const summary = state.summary;
        if (summary === null) return null;
        const removed = summary.removed?.length ?? 0;
        const failed = summary.failed?.length ?? 0;
        return h("div", { style: { display: "grid", gap: 6 } },
          h("p", { style: { margin: 0 } }, text(
            `已删除 ${removed} 个产物，共 ${ui.fileSizeText(summary.bytes ?? 0)}。`,
            `Removed ${removed} artifacts, ${ui.fileSizeText(summary.bytes ?? 0)} total.`)),
          failed > 0 && h("div", null,
            h("p", { style: { margin: 0, ...danger } }, text(
              `${failed} 个文件未能删除：`, `${failed} files could not be removed:`)),
            h("ul", { style: { margin: "4px 0 0", padding: "6px 10px", listStyle: "none", maxHeight: 160, overflowY: "auto", background: "var(--dsw-alias-bg-layer-2)", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l1)" } },
              summary.failed.map(item => h("li", { key: item.path, style: { padding: "2px 0", overflowWrap: "anywhere", fontSize: 12 } },
                `${item.path} — ${item.reason}`)))));
      }

      function ArtifactDeleteDialog() {
        const current = React.useSyncExternalStore(subscribe, snapshot, snapshot);
        if (!current.target) return null;
        const close = () => { if (!current.busy) reset(); };
        const canDeleteRecord = current.capability === null || current.capability.deleteSession !== false;
        const wantsArtifacts = current.includeArtifacts;
        // A preview that is still loading, or has not arrived, is not yet
        // actionable; a preview of zero files is settled and means "nothing".
        const previewSettled = !wantsArtifacts
          || (!current.previewLoading && current.preview !== null);
        const anyAction = (current.deleteRecord && canDeleteRecord)
          || (wantsArtifacts && (current.preview?.total ?? 0) > 0);
        const canConfirm = !current.busy && previewSettled && anyAction;
        const artifactsOnly = !current.deleteRecord && wantsArtifacts;

        const body = current.deleted
          ? h("div", { style: { display: "grid", gap: 12 } },
              h("p", { style: { margin: 0 } }, current.recordKept
                ? text("产物已删除，会话记录已保留。", "Artifacts deleted; the session record was kept.")
                : current.alreadyAbsent
                  ? text("该会话记录此前已不存在。", "The session record was already gone.")
                  : text("会话记录已删除。", "The session record was deleted.")),
              current.error !== "" && h("p", { role: "alert", style: danger }, current.error),
              h(RemovalSummary, null))
          : h("div", { style: { display: "grid", gap: 12 } },
              h("p", { style: { margin: 0, overflowWrap: "anywhere" } }, current.target.title),
              canDeleteRecord && h(ui.Checkbox, {
                checked: current.deleteRecord,
                disabled: current.busy,
                label: text("删除会话记录（不可恢复）", "Delete the session record (permanent)"),
                onChange: checked => publish({ deleteRecord: checked }),
              }),
              h(ui.Checkbox, {
                checked: current.includeArtifacts,
                disabled: current.busy,
                label: text("删除该会话在工作区留下的产物", "Delete the artifacts this session left in the workspace"),
                onChange: checked => {
                  publish({ includeArtifacts: checked, preview: null, previewError: "" });
                  if (checked) loadPreview(current.target.id);
                },
              }),
              current.includeArtifacts && h(ArtifactPreview, null),
              // Tell the user up front when this Host cannot remove the record,
              // instead of failing after they confirm.
              current.capability !== null && current.capability.deleteSession === false
                && h("p", { style: { margin: 0, opacity: 0.7, fontSize: 12 } }, text(
                  "当前 Host 无法删除会话记录，只能删除产物。",
                  "This Host cannot delete the session record; only its artifacts can be removed.")),
              !canConfirm && !current.busy && previewSettled
                && h("p", { style: { margin: 0, opacity: 0.7, fontSize: 12 } }, text(
                  "请至少选择一项要删除的内容。",
                  "Select at least one thing to delete.")),
              current.error !== "" && h("p", { role: "alert", style: danger }, current.error));

        const footer = current.deleted
          ? h("div", { style: { display: "flex", gap: 8 } },
              current.retryNonce && h(ui.Button, {
                variant: "outline", disabled: current.busy, onClick: retry,
              }, current.busy ? text("正在重试…", "Retrying…") : text("重试未删除的文件", "Retry the files left behind")),
              h(ui.Button, { variant: "outline", onClick: close }, text("关闭", "Close")))
          : h("div", { style: { display: "flex", gap: 8 } },
              h(ui.Button, { variant: "outline", disabled: current.busy, onClick: close }, text("取消", "Cancel")),
              h(ui.Button, {
                variant: "outline", style: danger, disabled: !canConfirm, onClick: confirm,
              }, current.busy
                ? text("正在删除…", "Deleting…")
                : artifactsOnly
                  ? text("确认删除产物", "Confirm artifact deletion")
                  : text("确认永久删除", "Confirm permanent deletion")));

        return h(ui.Modal, {
          open: true, onClose: close, closeLabel: text("取消", "Cancel"),
          title: artifactsOnly
            ? text("删除会话产物？", "Delete session artifacts?")
            : text("删除会话？", "Delete session?"),
          description: artifactsOnly
            ? text(
                "只删除该会话在工作区留下的文件，会话记录保留。",
                "Only the files this session left in the workspace are removed; the session record is kept.")
            : text(
                "会话记录将永久删除，无法恢复。运行中的任务会先停止。",
                "The session record will be permanently deleted. Running work will be stopped first."),
          footer,
        }, body);
      }

      ctx.effect(() => () => {
        disposed = true;
        controller.abort();
        listeners.clear();
      }, "session-artifacts: lifecycle");

      ctx.slots.inject("sidebar.workspaces.session.menu.item", () => ctx.slots.register({
        name: "sidebar.workspaces.session.menu.item",
        id: "dsh-session-artifacts.delete",
        order: 501,
      }, ArtifactDeleteMenuItem));

      ctx.slots.inject("shell.overlay", () => ctx.slots.register({
        name: "shell.overlay",
        id: "dsh-session-artifacts.delete-dialog",
      }, ArtifactDeleteDialog));
    }

    return { inject: ["slots", "locale"], apply: register };
  },
});
