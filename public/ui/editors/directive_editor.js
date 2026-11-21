// Directive editor: create or edit a craft contract (system prompt).
//
// Contract
//   - `openDirectiveEditor({ directive, onSave, host })` opens a `.rp-dialog`
//     with a name, a summary and the contract body. `directive` is the record
//     to edit, or null to create.
//   - `onSave(payload)` receives `{ id, name, description, content }` and may
//     be async. The dialog closes only after it resolves.
//   - Returns a Promise that resolves when the dialog closes.
//   - Dialog skeleton, close/cancel/save wiring and the async-save guard come
//     from the shared editor shell; only the fields and payload are local.
//
// Exports
//   openDirectiveEditor(options) -> Promise<void>

import { el } from "../dom.js";
import { openEditorDialog } from "./editor_dialog.js";
import { estimateTokens } from "../../context_plan.js";
import { DEFAULT_AGENTS_CONTRACT } from "../../local_db.js";

export function openDirectiveEditor({ directive = null, onSave, host } = {}) {
  const nameInput = el("input", {
    id: "rp-directive-name",
    class: "rp-input",
    type: "text",
    maxlength: 80,
    value: directive?.name || "",
    placeholder: "e.g. AGENTS.md contract",
    attrs: { required: "" },
  });

  const descInput = el("input", {
    id: "rp-directive-desc",
    class: "rp-input",
    type: "text",
    maxlength: 200,
    value: directive?.description || "",
    placeholder: "e.g. Third person limited, anti-slop rules",
  });

  const contentTokens = el("span", {
    class: "rp-badge rp-badge--muted rp-tnum",
    text: `~${estimateTokens(directive?.content || "")} tokens`,
  });

  const contentInput = el("textarea", {
    id: "rp-directive-content",
    class: "rp-textarea rp-textarea--mono",
    rows: 10,
    value: directive?.content || "",
    placeholder: "System prompt instructions, bans and formatting rules (leave empty for no system prompt).",
  });
  contentInput.addEventListener("input", () => {
    contentTokens.textContent = `~${estimateTokens(contentInput.value)} tokens`;
  });

  const resetBtn = directive?.id === "default_directive"
    ? el("button", {
        type: "button",
        class: "rp-btn rp-btn--ghost rp-btn--sm",
        text: "Reset to built-in default",
      })
    : null;
  resetBtn?.addEventListener("click", () => {
    contentInput.value = DEFAULT_AGENTS_CONTRACT;
    contentTokens.textContent = `~${estimateTokens(contentInput.value)} tokens`;
  });

  const error = el("p", { class: "rp-error", hidden: true });

  const form = el("form", { class: "rp-dialog__body", attrs: { novalidate: "" } }, [
    el("div", { class: "rp-directive-editor__row" }, [
      el("div", { class: "rp-field" }, [
        el("label", { class: "rp-label", for: "rp-directive-name", text: "Prompt name" }),
        nameInput,
      ]),
      el("div", { class: "rp-field" }, [
        el("label", { class: "rp-label", for: "rp-directive-desc", text: "Summary or purpose" }),
        descInput,
      ]),
    ]),
    el("div", { class: "rp-field" }, [
      el("div", { class: "rp-field__head" }, [
        el("label", { class: "rp-label", for: "rp-directive-content", text: "Contract content" }),
        el("div", { class: "rp-settings__inline-actions" }, [resetBtn, contentTokens].filter(Boolean)),
      ]),
      contentInput,
    ]),
    error,
  ]);

  return openEditorDialog({
    titleId: "rp-directive-editor-title",
    title: directive ? "Edit prompt" : "Create prompt",
    description: "Contract rules injected into the prompt prefix.",
    closeLabel: "Close prompt editor",
    saveLabel: directive ? "Save prompt" : "Create prompt",
    form,
    error,
    nameInput,
    requiredMessage: "A directive name is required.",
    buildPayload: (name) => ({
      id: directive?.id || `directive_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name,
      description: descInput.value.trim(),
      content: contentInput.value,
    }),
    successToast: (name) => `Directive "${name}" saved.`,
    errorPrefix: "Could not save the directive",
    onSave,
    host,
  });
}