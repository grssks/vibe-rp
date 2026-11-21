// Character Card Studio dialog: create or edit CCv2 character cards,
// alternate greetings, default persona/directive, and lorebook entries.
// No module-scope DOM globals.

import { el } from "../dom.js";
import { openModal, closeModal } from "../modal.js";
import { confirmAction } from "../confirm.js";
import { initTabs } from "../tabs.js";
import { compressImage } from "../image.js";
import { estimateTokens } from "../../context_plan.js";

function tokenText(value) {
  return `~${estimateTokens(String(value || ""))} tokens`;
}

function buildFieldWithTokens({ id, label, value = "", rows = 3, placeholder = "" }) {
  const countEl = el("span", { class: "rp-badge rp-tnum", text: tokenText(value) });
  const textarea = el("textarea", {
    id,
    class: "rp-textarea",
    attrs: { rows: String(rows), placeholder },
  });
  textarea.value = value || "";
  textarea.addEventListener("input", () => {
    countEl.textContent = tokenText(textarea.value);
  });
  const wrap = el("div", { class: "rp-field" }, [
    el("div", { class: "rp-field__head" }, [
      el("label", { class: "rp-label", attrs: { for: id }, text: label }),
      countEl,
    ]),
    textarea,
  ]);
  return { wrap, textarea };
}

function buildGreetingRow(value = "") {
  const textarea = el("textarea", {
    class: "rp-textarea",
    attrs: { rows: "3", placeholder: "Alternate opening message..." },
  });
  textarea.value = value || "";
  const removeBtn = el("button", {
    type: "button",
    class: "rp-btn rp-btn--danger-ghost rp-btn--sm",
    text: "Remove",
  });
  const row = el("div", { class: "rp-card rp-stack rp-stack--xs", attrs: { "data-alt-greeting": "true" } }, [
    textarea,
    el("div", { class: "rp-card__actions" }, [removeBtn]),
  ]);
  removeBtn.addEventListener("click", () => row.remove());
  return row;
}

function buildLoreEntryRow(entry = {}) {
  const commentInput = el("input", {
    type: "text",
    class: "rp-input",
    attrs: { placeholder: "Entry label (optional)", "data-lore-comment": "true" },
  });
  commentInput.value = entry.comment || entry.name || "";

  const keysInput = el("input", {
    type: "text",
    class: "rp-input",
    attrs: { placeholder: "Trigger keys (comma-separated)", "data-lore-keys": "true" },
  });
  keysInput.value = Array.isArray(entry.keys) ? entry.keys.join(", ") : "";

  const priorityInput = el("input", {
    type: "number",
    class: "rp-input",
    attrs: { step: "1", "data-lore-priority": "true" },
  });
  priorityInput.value = String(entry.priority ?? entry.insertion_order ?? 10);

  const constantCheck = el("input", {
    type: "checkbox",
    attrs: { "data-lore-constant": "true" },
  });
  constantCheck.checked = Boolean(entry.constant);

  const enabledCheck = el("input", {
    type: "checkbox",
    attrs: { "data-lore-enabled": "true" },
  });
  enabledCheck.checked = entry.enabled !== false;

  const contentInput = el("textarea", {
    class: "rp-textarea",
    attrs: { rows: "3", placeholder: "Lorebook entry content...", "data-lore-content": "true" },
  });
  contentInput.value = entry.content || "";

  const removeBtn = el("button", {
    type: "button",
    class: "rp-btn rp-btn--danger-ghost rp-btn--sm",
    text: "Remove",
  });

  const row = el("div", { class: "rp-card rp-stack rp-stack--xs", attrs: { "data-lore-entry": "true" } }, [
    el("div", { class: "rp-grid rp-grid--2" }, [
      el("div", { class: "rp-field" }, [
        el("label", { class: "rp-label", text: "Label" }),
        commentInput,
      ]),
      el("div", { class: "rp-field" }, [
        el("label", { class: "rp-label", text: "Keys" }),
        keysInput,
      ]),
    ]),
    el("div", { class: "rp-field" }, [
      el("label", { class: "rp-label", text: "Content" }),
      contentInput,
    ]),
    el("div", { class: "rp-card__actions" }, [
      el("label", { class: "rp-check" }, [enabledCheck, el("span", { text: "Enabled" })]),
      el("label", { class: "rp-check" }, [constantCheck, el("span", { text: "Always active (constant)" })]),
      el("label", { class: "rp-check" }, [el("span", { text: "Priority" }), priorityInput]),
      removeBtn,
    ]),
  ]);

  removeBtn.addEventListener("click", () => row.remove());
  return row;
}

const CARD_TABS = [
  { id: "rp-card-tab-character", label: "Character" },
  { id: "rp-card-tab-greetings", label: "Greetings & dialogue" },
  { id: "rp-card-tab-lore", label: "Prompts & lorebook" },
];

/**
 * Opens the Character Card Studio dialog to create or edit a CCv2 card.
 */
export function openCardEditor({ card = null, personas = [], directives = [], onSave, host } = {}) {
  const safePersonas = Array.isArray(personas) ? personas : [];
  const safeDirectives = Array.isArray(directives) ? directives : [];
  const existingData = card?.data && typeof card.data === "object" ? card.data : (card || {});
  const isNew = !card;
  let avatar = card?.avatar || existingData.avatar || null;

  const titleEl = el("h2", {
    class: "rp-dialog__title",
    attrs: { id: "rp-card-editor-title" },
    text: isNew ? "New character" : `Edit ${card.name || existingData.name || "character"}`,
  });
  const closeBtn = el("button", {
    type: "button",
    class: "rp-btn rp-btn--ghost rp-btn--icon rp-dialog__close",
    attrs: { "aria-label": "Close" },
    text: "\u00d7",
  });

  const avatarInner = el("div", { class: "rp-detail__portrait-inner" });
  const avatarHintText = el("span", {
    class: "rp-detail__portrait-hint-text",
    text: avatar ? "Change photo" : "Upload photo",
  });
  const avatarBtn = el("button", {
    type: "button",
    class: "rp-detail__portrait rp-detail__portrait--editor",
    attrs: { "aria-label": avatar ? "Change character portrait" : "Upload character portrait" },
  }, [
    avatarInner,
    el("span", { class: "rp-detail__portrait-hint", attrs: { "aria-hidden": "true" } }, [
      el("span", {
        class: "rp-detail__portrait-hint-icon",
        attrs: { "aria-hidden": "true" },
        html: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M14 7l3 3"/></svg>',
      }),
      avatarHintText,
    ]),
  ]);
  const clearAvatarBtn = el("button", {
    type: "button",
    class: "rp-btn rp-btn--ghost rp-btn--sm",
    text: "Remove photo",
  });
  const renderAvatarPreview = () => {
    avatarInner.textContent = "";
    if (avatar) {
      avatarInner.appendChild(el("img", { attrs: { src: avatar, alt: "" } }));
      avatarHintText.textContent = "Change photo";
      avatarBtn.setAttribute("aria-label", "Change character portrait");
    } else {
      const initial = String(nameInput?.value || card?.name || "C").trim().charAt(0).toUpperCase() || "C";
      avatarInner.appendChild(el("span", { class: "rp-avatar__initials", text: initial }));
      avatarHintText.textContent = "Upload photo";
      avatarBtn.setAttribute("aria-label", "Upload character portrait");
    }
    clearAvatarBtn.hidden = !avatar;
  };

  const avatarFileInput = el("input", {
    type: "file",
    class: "visually-hidden",
    attrs: { id: "rp-card-avatar-file", accept: "image/*", "aria-hidden": "true", tabindex: "-1" },
  });

  avatarBtn.addEventListener("click", () => avatarFileInput.click());
  clearAvatarBtn.addEventListener("click", () => {
    avatar = null;
    renderAvatarPreview();
  });
  avatarFileInput.addEventListener("change", async () => {
    const file = avatarFileInput.files?.[0];
    avatarFileInput.value = "";
    if (!file) return;
    try {
      avatar = await compressImage(file, 256, 0.85);
      renderAvatarPreview();
    } catch (err) {
      host?.toast?.(err?.message || "Could not process portrait image.", { tone: "error" });
    }
  });

  const nameInput = el("input", {
    type: "text",
    id: "rp-card-name",
    class: "rp-input",
    attrs: { required: "true", placeholder: "Character name" },
  });
  nameInput.value = card?.name || existingData.name || "";
  nameInput.addEventListener("input", () => {
    if (!avatar) renderAvatarPreview();
  });

  const creatorInput = el("input", {
    type: "text",
    id: "rp-card-creator",
    class: "rp-input",
    attrs: { placeholder: "Author / creator" },
  });
  creatorInput.value = card?.creator || existingData.creator || "";

  const tagsInput = el("input", {
    type: "text",
    id: "rp-card-tags",
    class: "rp-input",
    attrs: { placeholder: "fantasy, noir, slow-burn" },
  });
  const initialTags = Array.isArray(card?.tags) ? card.tags : existingData.tags;
  tagsInput.value = Array.isArray(initialTags) ? initialTags.join(", ") : "";

  const descField = buildFieldWithTokens({
    id: "rp-card-description",
    label: "Description",
    value: card?.description ?? existingData.description ?? "",
    rows: 4,
    placeholder: "Appearance, background, and core character details...",
  });
  const persField = buildFieldWithTokens({
    id: "rp-card-personality",
    label: "Personality",
    value: card?.personality ?? existingData.personality ?? "",
    rows: 3,
    placeholder: "Traits, temperament, speech habits...",
  });
  const scenField = buildFieldWithTokens({
    id: "rp-card-scenario",
    label: "Scenario",
    value: card?.scenario ?? existingData.scenario ?? "",
    rows: 3,
    placeholder: "Current setting and initial situation...",
  });
  const firstMesField = buildFieldWithTokens({
    id: "rp-card-first-mes",
    label: "First message (opening greeting)",
    value: card?.first_mes ?? existingData.first_mes ?? "",
    rows: 5,
    placeholder: "Character's opening message...",
  });
  const mesExampleField = buildFieldWithTokens({
    id: "rp-card-mes-example",
    label: "Example dialogue",
    value: card?.mes_example ?? existingData.mes_example ?? "",
    rows: 4,
    placeholder: "<START>\n{{user}}: ...\n{{char}}: ...",
  });
  const sysPromptField = buildFieldWithTokens({
    id: "rp-card-system-prompt",
    label: "System prompt override",
    value: card?.system_prompt ?? existingData.system_prompt ?? "",
    rows: 3,
    placeholder: "Optional character-specific instructions...",
  });
  const postHistField = buildFieldWithTokens({
    id: "rp-card-post-history",
    label: "Post-history instructions",
    value: card?.post_history_instructions ?? existingData.post_history_instructions ?? "",
    rows: 2,
    placeholder: "Optional depth/jailbreak note...",
  });
  const notesField = buildFieldWithTokens({
    id: "rp-card-creator-notes",
    label: "Creator notes",
    value: card?.creator_notes ?? existingData.creator_notes ?? "",
    rows: 2,
    placeholder: "Notes for readers (not sent to model)...",
  });

  // Alternate greetings
  const altContainer = el("div", { class: "rp-stack rp-stack--sm", attrs: { id: "rp-card-alt-greetings" } });
  const initialAlts = Array.isArray(card?.alternate_greetings)
    ? card.alternate_greetings
    : Array.isArray(existingData.alternate_greetings)
      ? existingData.alternate_greetings
      : [];
  for (const g of initialAlts) altContainer.appendChild(buildGreetingRow(g));
  const addAltBtn = el("button", {
    type: "button",
    class: "rp-btn rp-btn--secondary rp-btn--sm",
    text: "+ Add greeting",
  });
  addAltBtn.addEventListener("click", () => {
    altContainer.appendChild(buildGreetingRow(""));
  });

  // Persona & Directive defaults
  const personaSelect = el("select", { id: "rp-card-persona", class: "rp-select" }, [
    el("option", { attrs: { value: "" }, text: "Inherit app default" }),
    ...safePersonas.map((p) => el("option", { attrs: { value: p.id }, text: p.name || "You" })),
  ]);
  personaSelect.value = card?.userPersonaId || existingData.userPersonaId || "";

  const directiveSelect = el("select", { id: "rp-card-directive", class: "rp-select" }, [
    el("option", { attrs: { value: "" }, text: "Inherit app default" }),
    ...safeDirectives.map((d) => el("option", { attrs: { value: d.id }, text: d.name || "Untitled" })),
  ]);
  directiveSelect.value = card?.directivePresetId || existingData.directivePresetId || "";

  // Lorebook entries
  const loreContainer = el("div", { class: "rp-stack rp-stack--sm", attrs: { id: "rp-card-lore-entries" } });
  const book = card?.character_book || existingData.character_book;
  const initialEntries = Array.isArray(book?.entries) ? book.entries : [];
  for (const entry of initialEntries) loreContainer.appendChild(buildLoreEntryRow(entry));
  const addLoreBtn = el("button", {
    type: "button",
    class: "rp-btn rp-btn--secondary rp-btn--sm",
    text: "+ Add lore entry",
  });
  addLoreBtn.addEventListener("click", () => {
    loreContainer.appendChild(buildLoreEntryRow({ enabled: true, priority: 10 }));
  });

  const errorEl = el("p", { class: "rp-error", attrs: { role: "alert" } });
  errorEl.hidden = true;

  const cancelBtn = el("button", {
    type: "button",
    class: "rp-btn rp-btn--ghost",
    text: "Cancel",
  });
  const saveBtn = el("button", {
    type: "button",
    class: "rp-btn rp-btn--primary",
    text: "Save character",
  });

  renderAvatarPreview();

  const tablist = el(
    "div",
    { class: "rp-tabs rp-settings__tabs" },
    CARD_TABS.map((entry) =>
      el("button", { type: "button", class: "rp-tab", id: `${entry.id}-btn`, text: entry.label }),
    ),
  );
  CARD_TABS.forEach((entry, index) => {
    tablist.children[index].setAttribute("aria-controls", entry.id);
  });

  const characterPanel = el("div", { class: "rp-tabpanel rp-settings__panel", id: "rp-card-tab-character" }, [
    el("div", { class: "rp-persona-editor__hero rp-card-editor__hero" }, [
      el("div", { class: "rp-persona-editor__portrait" }, [
        avatarBtn,
        clearAvatarBtn,
        avatarFileInput,
      ]),
      el("div", { class: "rp-persona-editor__fields" }, [
        el("div", { class: "rp-field" }, [
          el("label", { class: "rp-label", attrs: { for: "rp-card-name" }, text: "Name *" }),
          nameInput,
        ]),
        el("div", { class: "rp-field" }, [
          el("label", { class: "rp-label", attrs: { for: "rp-card-creator" }, text: "Creator" }),
          creatorInput,
        ]),
        el("div", { class: "rp-field" }, [
          el("label", { class: "rp-label", attrs: { for: "rp-card-tags" }, text: "Tags (comma-separated)" }),
          tagsInput,
        ]),
      ]),
    ]),
    descField.wrap,
    persField.wrap,
    scenField.wrap,
  ]);

  const greetingsPanel = el(
    "div",
    { class: "rp-tabpanel rp-settings__panel", id: "rp-card-tab-greetings", hidden: true },
    [
      firstMesField.wrap,
      el("div", { class: "rp-stack rp-stack--sm" }, [
        el("div", { class: "rp-field__head" }, [
          el("span", { class: "rp-label", text: "Alternate greetings" }),
          addAltBtn,
        ]),
        altContainer,
      ]),
      mesExampleField.wrap,
    ],
  );

  const lorePanel = el(
    "div",
    { class: "rp-tabpanel rp-settings__panel", id: "rp-card-tab-lore", hidden: true },
    [
      el("div", { class: "rp-directive-editor__row" }, [
        el("div", { class: "rp-field" }, [
          el("label", { class: "rp-label", attrs: { for: "rp-card-persona" }, text: "Default persona" }),
          personaSelect,
        ]),
        el("div", { class: "rp-field" }, [
          el("label", { class: "rp-label", attrs: { for: "rp-card-directive" }, text: "Default craft directive" }),
          directiveSelect,
        ]),
      ]),
      sysPromptField.wrap,
      postHistField.wrap,
      notesField.wrap,
      el("div", { class: "rp-stack rp-stack--sm" }, [
        el("div", { class: "rp-field__head" }, [
          el("span", { class: "rp-label", text: "Lorebook entries" }),
          addLoreBtn,
        ]),
        loreContainer,
      ]),
    ],
  );

  const form = el("form", { class: "rp-dialog__body", attrs: { novalidate: "" } }, [
    tablist,
    characterPanel,
    greetingsPanel,
    lorePanel,
    errorEl,
  ]);

  const dialog = el(
    "dialog",
    {
      class: "rp-dialog rp-dialog--wide",
      id: "rp-card-editor-dialog",
      attrs: { "aria-labelledby": "rp-card-editor-title" },
    },
    [
      el("div", { class: "rp-dialog__panel" }, [
        el("div", { class: "rp-sheet__handle", attrs: { "aria-hidden": "true" } }),
        el("header", { class: "rp-dialog__header" }, [
          el("div", {}, [
            titleEl,
            el("p", {
              class: "rp-dialog__desc",
              text: "Configure Character Card v2 fields, alternate greetings, and lorebook entries.",
            }),
          ]),
          closeBtn,
        ]),
        form,
        el("footer", { class: "rp-dialog__footer" }, [cancelBtn, saveBtn]),
      ]),
    ],
  );

  document.body.appendChild(dialog);
  const tabs = initTabs(tablist, { activation: "manual" });

  let settled = false;
  const cleanup = () => {
    if (settled) return;
    settled = true;
    tabs.destroy();
    dialog.remove();
  };
  const close = () => {
    if (!closeModal(dialog)) cleanup();
  };

  const snapshotState = () =>
    JSON.stringify({
      name: nameInput.value,
      creator: creatorInput.value,
      tags: tagsInput.value,
      description: descField.textarea.value,
      personality: persField.textarea.value,
      scenario: scenField.textarea.value,
      first_mes: firstMesField.textarea.value,
      mes_example: mesExampleField.textarea.value,
      system_prompt: sysPromptField.textarea.value,
      post_history_instructions: postHistField.textarea.value,
      creator_notes: notesField.textarea.value,
      userPersonaId: personaSelect.value,
      directivePresetId: directiveSelect.value,
      avatar: avatar || "",
      altGreetings: [...altContainer.querySelectorAll("textarea")].map((t) => t.value),
      loreEntries: [...loreContainer.querySelectorAll("[data-lore-entry]")].map((row) => ({
        comment: row.querySelector("[data-lore-comment]")?.value || "",
        keys: row.querySelector("[data-lore-keys]")?.value || "",
        content: row.querySelector("[data-lore-content]")?.value || "",
        constant: Boolean(row.querySelector("[data-lore-constant]")?.checked),
        enabled: row.querySelector("[data-lore-enabled]")?.checked !== false,
        priority: row.querySelector("[data-lore-priority]")?.value || "",
      })),
    });

  const initialSnapshot = snapshotState();
  let confirmingDiscard = false;
  const confirmDiscard = async () => {
    if (snapshotState() === initialSnapshot) return true;
    if (confirmingDiscard) return false;
    confirmingDiscard = true;
    try {
      return await confirmAction({
        title: "Discard unsaved changes?",
        body: "Your edits haven't been saved yet.",
        confirmLabel: "Discard",
        cancelLabel: "Keep editing",
        tone: "danger",
        initialFocus: "cancel",
      });
    } finally {
      confirmingDiscard = false;
    }
  };
  const requestClose = async () => {
    if (await confirmDiscard()) close();
  };

  closeBtn.addEventListener("click", requestClose);
  cancelBtn.addEventListener("click", requestClose);

  async function submitCard() {
    const nameVal = nameInput.value.trim();
    if (!nameVal) {
      tabs.select("rp-card-tab-character");
      errorEl.textContent = "Character name is required.";
      errorEl.hidden = false;
      nameInput.focus();
      return;
    }
    errorEl.hidden = true;
    saveBtn.disabled = true;
    try {
      const id = card?.id || `card_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const now = new Date().toISOString();
      const tags = tagsInput.value.split(",").map((s) => s.trim()).filter(Boolean);
      const altGreetings = [...altContainer.querySelectorAll("textarea")]
        .map((t) => t.value)
        .filter((v) => v.trim().length > 0);
      const entries = [...loreContainer.querySelectorAll("[data-lore-entry]")]
        .map((row, idx) => ({
          id: idx + 1,
          comment: row.querySelector("[data-lore-comment]")?.value.trim() || "",
          keys: (row.querySelector("[data-lore-keys]")?.value || "")
            .split(",")
            .map((k) => k.trim())
            .filter(Boolean),
          content: row.querySelector("[data-lore-content]")?.value || "",
          constant: Boolean(row.querySelector("[data-lore-constant]")?.checked),
          enabled: row.querySelector("[data-lore-enabled]")?.checked !== false,
          insertion_order: Number(row.querySelector("[data-lore-priority]")?.value) || 10,
          priority: Number(row.querySelector("[data-lore-priority]")?.value) || 10,
        }))
        .filter((entry) => entry.content.trim() || entry.keys.length > 0);

      const characterBook = entries.length
        ? { ...(book && typeof book === "object" ? book : {}), name: book?.name || `${nameVal} Lorebook`, entries }
        : undefined;

      const data = {
        ...existingData,
        name: nameVal,
        creator: creatorInput.value.trim(),
        tags,
        description: descField.textarea.value,
        personality: persField.textarea.value,
        scenario: scenField.textarea.value,
        first_mes: firstMesField.textarea.value,
        mes_example: mesExampleField.textarea.value,
        system_prompt: sysPromptField.textarea.value,
        post_history_instructions: postHistField.textarea.value,
        creator_notes: notesField.textarea.value,
        alternate_greetings: altGreetings,
        userPersonaId: personaSelect.value || "",
        directivePresetId: directiveSelect.value || "",
      };
      if (avatar) data.avatar = avatar;
      else delete data.avatar;
      if (characterBook) data.character_book = characterBook;
      else delete data.character_book;

      const payload = {
        ...(card && typeof card === "object" ? card : {}),
        id,
        name: nameVal,
        creator: data.creator,
        tags,
        description: data.description,
        personality: data.personality,
        scenario: data.scenario,
        first_mes: data.first_mes,
        mes_example: data.mes_example,
        system_prompt: data.system_prompt,
        post_history_instructions: data.post_history_instructions,
        creator_notes: data.creator_notes,
        alternate_greetings: altGreetings,
        userPersonaId: data.userPersonaId,
        directivePresetId: data.directivePresetId,
        favorite: Boolean(card?.favorite),
        createdAt: card?.createdAt || now,
        updatedAt: now,
        spec: "chara_card_v2",
        spec_version: "2.0",
        data,
      };
      if (avatar) payload.avatar = avatar;
      else delete payload.avatar;
      if (characterBook) payload.character_book = characterBook;
      else delete payload.character_book;

      await onSave?.(payload);
      close();
      host?.toast?.("Character saved.", { tone: "success" });
    } catch (err) {
      errorEl.textContent = err?.message || "Could not save character.";
      errorEl.hidden = false;
      saveBtn.disabled = false;
    }
  }

  saveBtn.addEventListener("click", submitCard);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submitCard();
  });

  openModal({
    element: dialog,
    onClose: cleanup,
    onRequestClose: confirmDiscard,
    initialFocus: nameInput,
  });

  return { close, element: dialog };
}
