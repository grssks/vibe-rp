// Inline message draft editor for the chat feed. No module-scope DOM globals.

import { el } from "../dom.js";

const activeClosers = new WeakMap();

/** Cancels and removes any open inline editor inside `container`. */
export function closeActiveInlineEdit(container) {
  const editor = container?.querySelector?.(".rp-inline-editor");
  if (!editor) return;
  const closer = activeClosers.get(editor);
  if (closer) closer();
  else editor.remove();
}

/**
 * Mounts an inline message editor inside `cardEl` for `msg`.
 * Saving forks the message text asynchronously via `onSave(msg, val)`.
 */
export function openInlineEdit({ cardEl, msg, isBusy = () => false, onSave, onClose } = {}) {
  const contentCol = cardEl?.querySelector?.(".rp-message__content");
  if (!contentCol || cardEl.classList.contains("is-editing")) return null;
  cardEl.classList.add("is-editing");

  const proseEl = contentCol.querySelector(".rp-message__prose");
  const trayEl = contentCol.querySelector(".rp-message__tray");
  if (proseEl) proseEl.hidden = true;
  if (trayEl) trayEl.hidden = true;

  const inputId = `inline-edit-${msg.id}`;
  const label = el("label", {
    class: "visually-hidden",
    attrs: { for: inputId },
    text: "Edit message",
  });
  const textarea = el("textarea", {
    id: inputId,
    class: "rp-textarea",
    rows: 4,
    dataset: { escapeLocal: "true" },
  });
  const help = el("div", {
    class: "rp-help",
    text: "Saving keeps the current text as an earlier draft, so nothing is lost.",
  });
  const cancelBtn = el("button", {
    type: "button",
    class: "rp-btn rp-btn--ghost rp-btn--md",
    attrs: { "data-cancel": true },
    text: "Cancel",
  });
  const saveBtn = el("button", {
    type: "button",
    class: "rp-btn rp-btn--primary rp-btn--md",
    attrs: { "data-save": true },
    text: "Save as new draft",
  });
  const editor = el(
    "div",
    { class: "rp-inline-editor", dataset: { escapeLocal: "true" } },
    [label, textarea, help, el("div", { class: "rp-inline-editor__actions" }, [cancelBtn, saveBtn])],
  );
  contentCol.appendChild(editor);

  textarea.value = msg.content || "";
  textarea.focus();
  textarea.setSelectionRange?.(textarea.value.length, textarea.value.length);

  const close = () => {
    activeClosers.delete(editor);
    editor.remove();
    cardEl.classList.remove("is-editing");
    if (proseEl) proseEl.hidden = false;
    if (trayEl) trayEl.hidden = false;
    onClose?.();
  };

  const save = async () => {
    if (isBusy()) return;
    const val = textarea.value.trim();
    if (!val) { close(); return; }
    await onSave?.(msg, val, close);
  };

  activeClosers.set(editor, close);
  cancelBtn.addEventListener("click", close);
  saveBtn.addEventListener("click", save);
  textarea.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });

  return { close, save, editor, textarea };
}
