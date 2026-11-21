// Saved sessions & scene presets modal wiring for the chat page. No module-scope DOM globals.

import { el } from "../dom.js";

/**
 * Coordinates the History / Scene Presets dialog: thread switching, inline
 * rename, delete, new chat creation, and per-card persona/directive overrides.
 */
export function createHistoryModal({
  listEl,
  personaSelectEl,
  directiveSelectEl,
  newSceneBtn,
  closeBtns = [],
  managePersonasBtn,
  manageDirectivesBtn,
  controller,
  isBusy = () => false,
  onActivateSession,
  onSessionCreated,
  onSessionRenamed,
  onSessionsEmpty,
  onExportSession,
  onPresetsChanged,
  onManagePersonas,
  onManageDirectives,
  onOpenDialog,
  onCloseDialog,
  onToast,
  onConfirm,
} = {}) {
  function enterThreadRename(sess, row) {
    const titleEl = row.querySelector(".rp-card__title");
    if (!titleEl) return;
    const oldTitle = sess.title || "";
    const input = el("input", {
      type: "text",
      class: "rp-input",
      dataset: { escapeLocal: "true" },
      value: oldTitle,
      maxLength: 80,
      attrs: { "aria-label": "Rename chat" },
    });
    titleEl.parentNode?.insertBefore(input, titleEl);
    titleEl.remove();
    input.focus();
    input.select?.();

    let settled = false;
    const finish = async (save) => {
      if (settled) return;
      settled = true;
      const next = (save ? input.value.trim() : oldTitle) || "Untitled chat";
      const updated = await controller.renameSession(sess.id, next);
      if (updated && updated.id === controller.activeSession?.id) {
        onSessionRenamed?.(updated);
      }
      await renderThreads();
    };
    input.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
  }

  async function renderThreads() {
    if (!listEl) return;
    await controller.refreshSessions();
    listEl.replaceChildren();
    if (!controller.sessions.length) {
      listEl.appendChild(el("p", {
        class: "rp-help",
        attrs: { role: "listitem" },
        text: "No saved chats for this character yet. Start one with New chat.",
      }));
      return;
    }
    for (const sess of controller.sessions) {
      const active = sess.id === controller.activeSession?.id;
      const count = sess.messages?.length || 0;
      const date = sess.updatedAt ? new Date(sess.updatedAt).toLocaleDateString([], { month: "short", day: "numeric" }) : "";
      const renameBtn = el("button", {
        type: "button",
        class: "rp-btn rp-btn--ghost rp-btn--sm",
        attrs: { "data-rename": true },
        text: "Rename",
      });
      const exportMdBtn = onExportSession
        ? el("button", {
            type: "button",
            class: "rp-btn rp-btn--ghost rp-btn--sm",
            attrs: { "data-export-md": sess.id },
            text: ".md",
          })
        : null;
      const exportJsonBtn = onExportSession
        ? el("button", {
            type: "button",
            class: "rp-btn rp-btn--ghost rp-btn--sm",
            attrs: { "data-export-json": sess.id },
            text: ".json",
          })
        : null;
      const deleteBtn = controller.sessions.length > 1
        ? el("button", {
            type: "button",
            class: "rp-btn rp-btn--danger-ghost rp-btn--sm",
            attrs: { "data-delete": true },
            text: "Delete",
          })
        : null;
      const switchBtn = active
        ? null
        : el("button", {
            type: "button",
            class: "rp-btn rp-btn--secondary rp-btn--sm",
            attrs: { "data-switch": true },
            text: "Switch",
          });
      const activeBadge = active
        ? el("span", { class: "rp-badge rp-badge--annotation", text: "Active" })
        : null;
      const row = el(
        "div",
        { class: "rp-card rp-thread-card", attrs: { role: "listitem" } },
        [
          el("div", { class: "rp-card__head" }, [
            el("div", { class: "rp-card__heading" }, [
              el("span", {
                class: "rp-card__title rp-thread-card__title",
                text: sess.title || "Untitled chat",
              }),
              el("span", {
                class: "rp-card__byline",
                text: `${count} ${count === 1 ? "message" : "messages"}${date ? ` on ${date}` : ""}`,
              }),
            ]),
            el("div", { class: "rp-card__actions" }, [
              renameBtn,
              exportMdBtn,
              exportJsonBtn,
              deleteBtn,
              activeBadge,
              switchBtn,
            ]),
          ]),
        ],
      );

      exportMdBtn?.addEventListener("click", () => onExportSession?.(sess, "md"));
      exportJsonBtn?.addEventListener("click", () => onExportSession?.(sess, "json"));

      switchBtn?.addEventListener("click", () => {
        if (isBusy()) {
          onToast?.("Wait for the current reply to finish or click Stop.", "info");
          return;
        }
        onActivateSession?.(sess);
        onCloseDialog?.();
        onToast?.(`Switched to ${sess.title}.`, "info");
      });
      renameBtn.addEventListener("click", () => enterThreadRename(sess, row));
      deleteBtn?.addEventListener("click", async () => {
        if (isBusy()) {
          onToast?.("Wait for the current reply to finish or click Stop.", "info");
          return;
        }
        const ok = await onConfirm?.({
          title: "Delete this chat?",
          body: `"${sess.title}" and its messages are removed.`,
          confirmLabel: "Delete chat",
          tone: "danger",
          initialFocus: "cancel",
        });
        if (!ok) return;
        const { activeChanged, nextSession } = await controller.deleteSession(sess.id);
        if (activeChanged) {
          if (!nextSession) {
            onSessionsEmpty?.();
            return;
          }
          onActivateSession?.(nextSession);
        }
        await renderThreads();
        onToast?.("Chat deleted.", "info");
      });
      listEl.appendChild(row);
    }
  }

  async function refreshPresets() {
    await controller.refreshPresets();
    const card = controller.activeCard;
    if (personaSelectEl && card) {
      const allPersonas = await controller.db.getAllPersonas();
      const defPersona = await controller.db.getDefaultPersona();
      personaSelectEl.replaceChildren(
        el("option", { value: "", text: `Global default (${defPersona.name})` }),
        ...allPersonas.map((p) => el("option", { value: p.id, text: `${p.name}${p.isDefault ? " (global)" : ""}` })),
      );
      personaSelectEl.value = card.userPersonaId || card.data?.userPersonaId || "";
    }
    if (directiveSelectEl && card) {
      const allDirectives = await controller.db.getAllDirectives();
      const defDirective = await controller.db.getDefaultDirective();
      directiveSelectEl.replaceChildren(
        el("option", { value: "", text: `Global default (${defDirective.name})` }),
        ...allDirectives.map((d) => el("option", { value: d.id, text: `${d.name}${d.isDefault ? " (global)" : ""}` })),
      );
      directiveSelectEl.value = card.directivePresetId || card.data?.directivePresetId || "";
    }
    onPresetsChanged?.({ kind: "refresh" });
  }

  function open() {
    onOpenDialog?.();
    renderThreads();
  }

  for (const btn of closeBtns) {
    btn?.addEventListener("click", () => onCloseDialog?.());
  }
  managePersonasBtn?.addEventListener("click", () => onManagePersonas?.());
  manageDirectivesBtn?.addEventListener("click", () => onManageDirectives?.());

  personaSelectEl?.addEventListener("change", async (e) => {
    if (isBusy()) {
      e.target.value = controller.activeCard.userPersonaId || controller.activeCard.data?.userPersonaId || "";
      onToast?.("Wait for the current reply to finish or click Stop.", "info");
      return;
    }
    await controller.setCardPersona(e.target.value);
    await refreshPresets();
    onPresetsChanged?.({ kind: "persona" });
  });

  directiveSelectEl?.addEventListener("change", async (e) => {
    if (isBusy()) {
      e.target.value = controller.activeCard.directivePresetId || controller.activeCard.data?.directivePresetId || "";
      onToast?.("Wait for the current reply to finish or click Stop.", "info");
      return;
    }
    await controller.setCardDirective(e.target.value);
    await refreshPresets();
    onPresetsChanged?.({ kind: "directive" });
  });

  newSceneBtn?.addEventListener("click", async () => {
    if (isBusy()) {
      onToast?.("Wait for the current reply to finish or click Stop.", "info");
      return;
    }
    await onSessionCreated?.();
  });

  return { open, renderThreads, refreshPresets };
}
