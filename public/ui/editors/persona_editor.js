// Persona editor: create or edit the author's identity.
//
// Contract
//   - `openPersonaEditor({ persona, onSave, compressImage, host })` opens a
//     `.rp-dialog` with name, description, gender/pronoun selector, definition and an avatar control.
//     `persona` is the record to edit, or null to create.
//   - `onSave(payload)` receives `{ id, name, description, gender, template, avatar }`
//     and may be async. The dialog closes only after it resolves, so a failed
//     save keeps the user's input on screen.
//   - `compressImage(file, maxSize)` is injected (the page passes its canvas
//     helper) so this module stays free of canvas code.
//   - The avatar control is a real button, reachable by keyboard, that opens
//     the file picker. "Remove photo" appears only when a photo is set.
//   - Returns a Promise that resolves when the dialog closes.
//   - Dialog skeleton, close/cancel/save wiring and the async-save guard come
//     from the shared editor shell; only the fields and payload are local.
//
// Exports
//   openPersonaEditor(options) -> Promise<void>

import { el } from "../dom.js";
import { isSafeAvatarUrl } from "../character_card.js";
import { openEditorDialog } from "./editor_dialog.js";

function avatarUrl(value) {
  const text = String(value || "");
  return isSafeAvatarUrl(text) ? text : "";
}

export function openPersonaEditor({ persona = null, onSave, compressImage, host } = {}) {
  let avatar = persona?.avatar || "";

  const fileInput = el("input", {
    type: "file",
    accept: "image/*",
    class: "visually-hidden",
    attrs: { "aria-hidden": "true", tabindex: "-1" },
  });

  const avatarBox = el("div", { class: "rp-avatar rp-avatar--xl" });
  const removeBtn = el("button", {
    type: "button",
    class: "rp-btn rp-btn--ghost rp-btn--sm",
    text: "Remove photo",
  });

  const nameInput = el("input", {
    id: "rp-persona-name",
    class: "rp-input",
    type: "text",
    maxlength: 80,
    value: persona?.name || "",
    placeholder: "e.g. Bal, king of Florin",
    attrs: { required: "" },
  });

  const descInput = el("input", {
    id: "rp-persona-desc",
    class: "rp-input",
    type: "text",
    maxlength: 200,
    value: persona?.description || "",
    placeholder: "e.g. Ruler defending the realm",
  });
  const genderSelect = el("select", {
    id: "rp-persona-gender",
    class: "rp-select",
  }, [
    el("option", { value: "", text: "Auto-detect from description" }),
    el("option", { value: "male", text: "Male (he / him / his)" }),
    el("option", { value: "female", text: "Female (she / her / hers)" }),
    el("option", { value: "neutral", text: "Neutral (they / them / theirs)" }),
    el("option", { value: "it", text: "Neuter (it / its)" }),
  ]);
  genderSelect.value = persona?.gender || "";

  const templateInput = el("textarea", {
    id: "rp-persona-template",
    class: "rp-textarea",
    rows: 5,
    value: persona?.template || "",
    placeholder:
      "e.g. Bal is the reigning monarch of Florin. Speaks with measured, quiet authority.",
    attrs: { "aria-describedby": "rp-persona-template-help" },
  });

  const error = el("p", { class: "rp-error", hidden: true });

  const changeBtn = el("button", {
    type: "button",
    class: "rp-btn rp-btn--secondary rp-btn--sm",
    text: avatarUrl(avatar) ? "Change photo" : "Upload photo",
  });
  function paintAvatar() {
    avatarBox.replaceChildren();
    const url = avatarUrl(avatar);
    if (url) {
      avatarBox.appendChild(el("img", { alt: "", src: url }));
      changeBtn.textContent = "Change photo";
    } else {
      const letter = (nameInput.value.trim().charAt(0) || "U").toUpperCase();
      avatarBox.appendChild(el("span", { class: "rp-avatar__initials", text: letter }));
      changeBtn.textContent = "Upload photo";
    }
    removeBtn.hidden = !url;
  }

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    try {
      avatar = (await compressImage?.(file, 256)) || "";
      paintAvatar();
    } catch (err) {
      error.hidden = false;
      error.textContent = `Could not load that image: ${err.message}`;
    }
  });

  changeBtn.addEventListener("click", () => fileInput.click());
  removeBtn.addEventListener("click", () => {
    avatar = "";
    paintAvatar();
  });
  nameInput.addEventListener("input", () => {
    if (!avatarUrl(avatar)) paintAvatar();
  });

  const form = el("form", { class: "rp-dialog__body", attrs: { novalidate: "" } }, [
    el("div", { class: "rp-persona-editor__hero" }, [
      el("div", { class: "rp-persona-editor__portrait" }, [avatarBox, changeBtn, removeBtn, fileInput]),
      el("div", { class: "rp-persona-editor__fields" }, [
        el("div", { class: "rp-field" }, [
          el("label", { class: "rp-label", for: "rp-persona-name", text: "Persona name" }),
          nameInput,
        ]),
        el("div", { class: "rp-field" }, [
          el("label", { class: "rp-label", for: "rp-persona-desc", text: "Role or brief description" }),
          descInput,
        ]),
        el("div", { class: "rp-field" }, [
          el("label", { class: "rp-label", for: "rp-persona-gender", text: "Gender & pronouns" }),
          genderSelect,
        ]),
      ]),
    ]),
    el("div", { class: "rp-field" }, [
      el("label", { class: "rp-label", for: "rp-persona-template", text: "Persona definition and instructions" }),
      el("p", {
        id: "rp-persona-template-help",
        class: "rp-help",
        text: "Context and dialogue traits injected into the prompt prefix so the character knows who you are.",
      }),
      templateInput,
    ]),
    error,
  ]);

  return openEditorDialog({
    titleId: "rp-persona-editor-title",
    title: persona ? "Edit persona" : "Create persona",
    description: "Configure your author identity and speaking traits.",
    closeLabel: "Close dialog",
    saveLabel: persona ? "Save persona" : "Create persona",
    form,
    error,
    nameInput,
    requiredMessage: "A persona name is required.",
    buildPayload: (name) => ({
      id: persona?.id || `persona_${Date.now()}`,
      name,
      description: descInput.value.trim(),
      gender: genderSelect.value || undefined,
      template: templateInput.value,
      avatar: avatar || undefined,
    }),
    successToast: (name) => `Persona "${name}" saved.`,
    errorPrefix: "Could not save the persona",
    onSave,
    host,
    onDialog: paintAvatar,
  });
}