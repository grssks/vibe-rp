import { BrowserChatEngine, getModelCapability, estimateTokens as estimateTokensModule } from "../../browser_engine.js";
import { SessionController, CHOICE_STATUS } from "../../session_controller.js";
import { formatProse } from "../../message_format.js";
import { substitutePlaceholders, stripThoughtBlocks } from "../../text.js";
import { LocalDbQuotaError, LocalDbBlockedError } from "../../local_db.js";
import { cardAvatarUrl, avatarInnerHtml } from "../character_card.js";

import { initTheme, getTheme, toggleTheme } from "../theme.js";
import { createNotifier, toastAdapter } from "../toast.js";
import { openModal, closeTopModal, topModal, bindDismissable } from "../modal.js";
import { confirmAction, runWithUndo } from "../confirm.js";
import { createMessageFeed } from "./message_feed.js";
import { createComposer } from "./composer.js";
import { createChoicePanel } from "./choice_panel.js";
import { createTurnMachine } from "./turn_machine.js";
import { createSearch } from "./search.js";
import { renderContextPanel, applyContextPanelStyles, bindContextPanelActions } from "./context_panel.js";
import { downloadTranscriptFile, downloadSessionJsonFile } from "../data_transfer.js";
import { openInlineEdit, closeActiveInlineEdit } from "./inline_editor.js";
import { createHistoryModal } from "./history_modal.js";
import { compressImage } from "../image.js";
import { openSettingsModal } from "../settings/settings_modal.js";

const $ = (id) => document.getElementById(id);
const controller = new SessionController();
const estimateTokens = estimateTokensModule;

const notifier = createNotifier({ region: $("toast-region"), status: $("turn-status") });
const showToast = toastAdapter(notifier);
window.showToast = showToast;

const urlParams = new URLSearchParams(window.location.search);
const cardId = urlParams.get("cardId");
const sessionId = urlParams.get("sessionId");

const chatFeed = $("chat-feed");
const chatInner = $("chat-inner");
const authorInput = $("author-input");
const sendBtn = $("send-btn");
const stopBtn = $("stop-btn");

function resolvePlaceholders(text) {
  return substitutePlaceholders(text, {
    user: controller.currentPersona?.name?.trim() || "You",
    char: controller.charName || "Character",
    persona: controller.currentPersona,
  });
}

/* Export helpers take plain names, not the card/persona records themselves. */
function exportNames() {
  return {
    charName: controller.charName || "Character",
    userName: controller.currentPersona?.name?.trim() || "You",
  };
}

const feed = createMessageFeed({
  mount: chatInner,
  resolve: resolvePlaceholders,
  formatProse,
  estimateTokens,
  onAction: handleMessageAction,
});

const NEAR_BOTTOM_PX = 80;
const SCROLL_THRESHOLD_PX = 160;
const isNearBottom = () =>
  chatFeed.scrollHeight - chatFeed.scrollTop - chatFeed.clientHeight <= NEAR_BOTTOM_PX;
let stickToBottom = true;

const scrollBottomBtn = $("scroll-bottom-btn");
const scrollBottomBadge = $("scroll-bottom-badge");

function updateScrollBottomAffordance() {
  if (!scrollBottomBtn) return;
  const distanceFromBottom = chatFeed.scrollHeight - chatFeed.scrollTop - chatFeed.clientHeight;
  const isScrolledUp = distanceFromBottom > SCROLL_THRESHOLD_PX;
  if (isScrolledUp) {
    scrollBottomBtn.hidden = false;
    scrollBottomBtn.classList.add("is-visible");
  } else {
    scrollBottomBtn.classList.remove("is-visible");
    scrollBottomBtn.hidden = true;
    if (scrollBottomBadge) scrollBottomBadge.hidden = true;
  }
}

chatFeed.addEventListener("scroll", () => {
  stickToBottom = isNearBottom();
  updateScrollBottomAffordance();
}, { passive: true });

scrollBottomBtn?.addEventListener("click", () => {
  stickToBottom = true;
  const reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  chatFeed.scrollTo({ top: chatFeed.scrollHeight, behavior: reducedMotion ? "auto" : "smooth" });
  if (scrollBottomBadge) scrollBottomBadge.hidden = true;
  authorInput?.focus?.();
});

function scrollFeed(behavior = "auto") {
  if (stickToBottom) {
    chatFeed.scrollTo({ top: chatFeed.scrollHeight, behavior });
  } else if (scrollBottomBadge) {
    scrollBottomBadge.hidden = false;
  }
}

function renderFeed() {
  if (chatInner.querySelector(".rp-inline-editor")) return;
  stickToBottom = isNearBottom();
  const messages = controller.activeSession?.messages || [];
  feed.setContext({
    card: controller.activeCard,
    persona: controller.currentPersona,
    charName: controller.charName,
    initialLetter: controller.initialLetter,
    getForkInfo: (msg) => controller.getMessageForkInfo(msg.id),
  });
  if (!messages.length) {
    feed.renderEmpty({
      title: "Scene ready",
      body: `Silence settles over the scene. Write an opening line to ${controller.charName}.`,
    });
    updateContextStats();
    return;
  }
  feed.setMessages(messages);
  if (stickToBottom) {
    chatFeed.scrollTop = chatFeed.scrollHeight;
  } else if (scrollBottomBadge) {
    scrollBottomBadge.hidden = false;
  }
  updateContextStats();
  updateScrollBottomAffordance();
}

function findMessage(id) {
  return (controller.activeSession?.messages || []).find((m) => m.id === id) || null;
}

async function persistOrReport(sess = controller.activeSession) {
  try {
    await controller.saveSession(sess);
  } catch (err) {
    reportStorageError(err);
  }
}

function reportStorageError(err) {
  if (err instanceof LocalDbQuotaError) {
    showToast("This browser is out of storage space. Free some space, then try again.", "error");
  } else if (err instanceof LocalDbBlockedError) {
    showToast("Another tab is using an older version of this app. Close it, then reload.", "error");
  } else {
    showToast(`Could not save: ${err.message}`, "error");
  }
}

const isBusy = () => composer.busy || controller.busy;

async function handleMessageAction(action, msgId, { button } = {}) {
  const msg = findMessage(msgId);
  if (!msg) return;

  if (action === "copy") {
    const text = resolvePlaceholders(stripThoughtBlocks(msg.content));
    try {
      await navigator.clipboard.writeText(text);
      if (button) {
        if (!button.dataset.origLabel) button.dataset.origLabel = button.textContent;
        clearTimeout(button._copyTimer);
        button.textContent = "Copied";
        button._copyTimer = setTimeout(() => {
          button.textContent = button.dataset.origLabel || "Copy";
        }, 1500);
      }
    } catch (_) {
      showToast("Copy failed. Your browser blocked clipboard access.", "error");
    }
    return;
  }

  if (isBusy()) {
    showToast("Wait for the current reply to finish or click Stop.", "info");
    return;
  }

  if (action === "edit") {
    const el = feed.getElement(msgId);
    if (!el) return;
    openInlineEdit({
      cardEl: el,
      msg,
      isBusy,
      onSave: async (targetMsg, val, closeEditor) => {
        const hadLedger = Boolean(controller.activeSession?.ledger);
        const revision = controller.editMessage(targetMsg.id, val);
        const cleared = hadLedger && !controller.activeSession?.ledger;
        await persistOrReport();
        closeEditor();
        if (revision) feed.updateMessage(revision);
        restoreChoicesForScene();
        showToast(
          cleared
            ? "Saved as a new draft. The earlier text is kept. The continuity summary covered this message, so it was cleared and will be rebuilt."
            : "Saved as a new draft. The earlier text is kept.",
          "success"
        );
      },
    });
    return;
  }

  if (action === "delete") {
    const ok = await confirmAction({
      title: "Delete this message?",
      body: "The turn is removed from this chat (you can undo briefly from the toast).",
      confirmLabel: "Delete message",
      tone: "danger",
      initialFocus: "cancel",
    });
    if (!ok) return;
    const targetSession = controller.activeSession;
    const index = targetSession.messages.findIndex((m) => m.id === msgId);
    if (index === -1) return;
    const derived = controller.captureLedgerSnapshot();
    const hadLedger = Boolean(targetSession.ledger);
    controller.deleteMessage(msgId);
    const cleared = hadLedger && !targetSession.ledger;
    await persistOrReport(targetSession);
    if (controller.activeSession === targetSession) {
      renderFeed();
      restoreChoicesForScene();
    }
    runWithUndo({
      notifier,
      message: cleared
        ? "Message deleted. The continuity summary covered it, so it was cleared and will be rebuilt."
        : "Message deleted.",
      undo: async () => {
        try {
          await controller.restoreDeletedMessage(targetSession, { index, message: msg, ledgerSnapshot: derived });
        } catch (err) {
          reportStorageError(err);
        }
        if (controller.activeSession === targetSession) {
          renderFeed();
          restoreChoicesForScene();
        }
      },
    });
    return;
  }

  if (action === "reroll") {
    await rerollLastTurn();
    return;
  }

  if (action === "retry") {
    await retryUnansweredTurn();
    return;
  }

  if (action === "fork-prev" || action === "fork-next") {
    if (isBusy()) {
      showToast("Wait for the current reply to finish or click Stop.", "info");
      return;
    }
    const delta = action === "fork-prev" ? -1 : 1;
    const updated = await controller.cycleMessageFork(msg.id, delta);
    if (updated) {
      renderFeed();
      updateContextStats();
    }
    return;
  }

  if (action === "continue") {
    await turns.continueLastTurn();
    return;
  }

  if (action === "rewind") {
    if (isBusy()) {
      showToast("Wait for the current reply to finish or click Stop.", "info");
      return;
    }
    const result = await controller.rewindToMessage(msg.id);
    if (!result) return;
    renderFeed();
    updateContextStats();
    await runWithUndo({
      label: `Rewound ${result.removed.length} ${result.removed.length === 1 ? "message" : "messages"}.`,
      toast: showToast,
      onUndo: async () => {
        await controller.restoreRewoundMessages(result);
        renderFeed();
        updateContextStats();
      },
    });
    return;
  }

  if (action === "fork") {
    const ok = await confirmAction({
      title: "Fork from this message?",
      body: "A new chat starts with this conversation up to this turn. The current chat is kept as it is.",
      confirmLabel: "Fork conversation",
    });
    if (!ok) return;
    const forked = await controller.forkSession(msg.id);
    if (!forked) return;
    activateSession(forked);
    showToast("Forked into a new chat. The original is unchanged.", "success");
  }
}

function draftKey(id = controller.activeSession?.id) {
  return id ? `vibe_rp_draft_${id}` : "";
}
function saveDraft(value) {
  const key = draftKey();
  if (!key) return;
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch { /* ignore storage quota errors */ }
}
function loadDraft(id = controller.activeSession?.id) {
  const key = draftKey(id);
  if (!key) return "";
  try { return localStorage.getItem(key) || ""; } catch { return ""; }
}

const composer = createComposer({
  root: $("composer"),
  input: authorInput,
  sendButton: sendBtn,
  stopButton: stopBtn,
  statsEl: $("composer-live-stats"),
  personaNameEl: $("composer-persona-name"),
  personaAvatarEl: $("composer-speaker-avatar"),
  estimateTokens,
  matchFinePointer: () => window.matchMedia("(pointer: fine)").matches,
  onSend: (text) => {
    saveDraft("");
    return submitTurn(text);
  },
  onStop: () => stopTurn(),
});

// Choice Mode changes how the reader picks the next turn, never transcript shape.
const choicePanelEl = $("choice-panel");
const modeSwitchEl = $("mode-switch");
let mode = "normal";

const choicePanel = createChoicePanel({
  mount: choicePanelEl,
  onSelect: (id) => selectChoice(id),
  onEdit: (choice) => {
    if (!choice?.text) return;
    composer.setValue(choice.text);
    saveDraft(choice.text);
    updateContextStats();
    authorInput.focus();
  },
  onRegenerate: (intent = "") => requestChoices({ isRegenerate: true, intent }),
  onRetry: () => requestChoices(),
  autoFocus: () => false,
});

function setMode(next, { persist = true } = {}) {
  mode = next === "choice" ? "choice" : "normal";
  $("composer").dataset.mode = mode;
  for (const btn of modeSwitchEl.querySelectorAll("[data-mode]")) {
    btn.setAttribute("aria-pressed", btn.dataset.mode === mode ? "true" : "false");
  }
  if (persist) {
    try {
      const settings = controller.db.getSettings();
      controller.db.saveSettings({ ...settings, choiceMode: mode });
      controller.settings = controller.db.getSettings();
    } catch (err) {
      console.warn("Could not persist the mode", err);
    }
  }
  if (mode === "choice") restoreChoicesForScene();
  else renderChoices();
}

modeSwitchEl.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-mode]");
  if (btn) setMode(btn.dataset.mode);
});

function renderChoices() {
  const st = controller.choiceState;
  const hasChoices = mode === "choice" && st.status !== "idle";
  $("composer").dataset.hasChoices = hasChoices ? "true" : "false";
  const isContinuation = Array.isArray(st.choices) && st.choices.length > 0 &&
    st.choices.every((c) => c.type === "continuation" || c.type === "story" || c.type === "narrative");
  const { focusTarget } = choicePanel.render({
    mode,
    status: st.status,
    choices: st.choices,
    error: st.error,
    selectedId: st.selectedId || null,
    isContinuation,
    canGenerate: Boolean(controller.choiceScene?.()) && !composer.busy,
  });
  if (focusTarget && document.activeElement !== authorInput && !composer.busy) {
    focusTarget.focus?.();
  }
}

function restoreChoicesForScene() {
  if (mode !== "choice") {
    renderChoices();
    return;
  }
  if (controller.choiceState.status === CHOICE_STATUS.READY && controller.choicesAreFresh()) {
    renderChoices();
    return;
  }
  const restored = controller.restoreChoices();
  renderChoices();
  if (restored.status === CHOICE_STATUS.IDLE && controller.choiceScene()) {
    requestChoices();
  }
}

async function requestChoices({ isRegenerate = false, intent = "" } = {}) {
  if (mode !== "choice") return;
  renderChoices();
  await controller.requestChoices({
    isRegenerate,
    intent,
    onState: () => renderChoices(),
    onNotice: (msg) => showToast(msg, "info"),
  });
  renderChoices();
}

async function selectChoice(id) {
  if (composer.busy) return;
  const choice = controller.selectChoice(id);
  if (!choice) return;
  renderChoices();
  await submitTurn(choice.text);
}

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!composer.busy) composer.send();
});

const turns = createTurnMachine({
  controller,
  composer,
  feed,
  notifier,
  showToast,
  isNearBottom,
  scrollFeed: () => scrollFeed(),
  scrollToStream: (id, { autoFollow = false } = {}) => {
    if (autoFollow) {
      stickToBottom = true;
      scrollFeed();
      return;
    }
    stickToBottom = false;
    feed.scrollToMessage?.(id, { behavior: "smooth" });
  },
  requestAnimationFrame: (fn) => requestAnimationFrame(fn),
  matchFinePointer: () => window.matchMedia("(pointer: fine)").matches,
  clearComposerInput: (promptHint) => composer.clearIfMatched(promptHint),
  onSettled: () => {
    renderFeed();
    if (mode === "choice") renderChoices();
  },
  onChoiceTurnFailed: () => { if (mode === "choice") renderChoices(); },
  onChoiceTurnSettled: async () => { renderChoices(); await requestChoices(); },
  isChoiceMode: () => mode === "choice",
  onFinally: () => updateContextStats(),
});
const { submitTurn, rerollLastTurn, retryUnansweredTurn, stopTurn } = turns;

// Context sheet wiring.
const contextLedger = $("ledger-context");
const ledgerSheet = $("ledger-sheet");
const ledgerBtn = $("toggle-ledger-btn");

function scopeLabelOf() {
  const parts = [controller.currentPersona?.name, controller.currentDirective?.name, controller.settings?.model]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function updateContextStats() {
  if (ledgerSheet && (ledgerSheet.hidden || ledgerSheet.dataset.open !== "true")) return;
  const sess = controller.activeSession;
  const draft = composer.getValue();
  const request = BrowserChatEngine.describeRequest({
    card: controller.activeCard,
    session: sess || { messages: [], ledger: "", consumed: 1 },
    settings: controller.settings,
    persona: controller.currentPersona,
    agentsContract: controller.activeAgentsContract,
    draft,
  });
  const configuredWindow = BrowserChatEngine.resolveBudgets(controller.settings).contextWindow;
  const cap = getModelCapability(controller.settings?.apiEndpoint, controller.settings?.model);
  contextLedger.innerHTML = renderContextPanel({
    request,
    usage: sess ? sess.lastUsageReport : null,
    windowLearned: request.contextWindow < configuredWindow,
    samples: sess ? sess.usageHistory : null,
    scope: controller.usageScope(),
    scopeLabel: scopeLabelOf(),
    pruned: sess ? sess.usagePruned : null,
    ledgerTruncated: Boolean(sess?.ledgerTruncated),
    ignoresMaxTokens: Boolean(cap.ignoresMaxTokens),
    interactive: true,
    ledgerText: sess?.ledger || "",
    authorsNote: sess?.authorsNote || "",
    canFold: (sess?.messages?.length || 0) >= 6,
  });
  applyContextPanelStyles(contextLedger);
  bindContextPanelActions(contextLedger, {
    onSaveAuthorsNote: async (note) => {
      await controller.setAuthorsNote(note);
      updateContextStats();
      showToast("Author's Note saved.", "success");
    },
    onSaveLedger: async (ledger) => {
      await controller.setSessionLedger(ledger);
      updateContextStats();
      showToast("Continuity recap saved.", "success");
    },
    onFold: async () => {
      try {
        const res = await controller.foldSessionLedger({ rebuild: false });
        updateContextStats();
        showToast(res.folded ? "Continuity recap updated." : "Nothing older to fold yet.", "info");
      } catch (err) {
        showToast(err?.message || "Could not fold recap.", "error");
      }
    },
    onRebuildLedger: async () => {
      try {
        const res = await controller.foldSessionLedger({ rebuild: true });
        updateContextStats();
        showToast(res.folded ? "Continuity recap rebuilt." : "Not enough history to rebuild recap.", "info");
      } catch (err) {
        showToast(err?.message || "Could not rebuild recap.", "error");
      }
    },
    onExport: (format) => {
      if (!sess) return;
      if (format === "json") downloadSessionJsonFile(sess, { cardName: controller.charName || "" });
      else downloadTranscriptFile(sess, exportNames());
    },
  });
}

function setLedgerOpen(open) {
  ledgerSheet.hidden = !open;
  ledgerSheet.dataset.open = open ? "true" : "false";
  ledgerBtn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) { updateContextStats(); $("close-ledger-btn").focus(); }
  else ledgerBtn.focus();
}
function isLedgerDirty() {
  const noteInput = ledgerSheet.querySelector("[data-context-authors-note]");
  const ledgerInput = ledgerSheet.querySelector("[data-context-ledger]");
  const savedNote = controller.activeSession?.authorsNote || "";
  const savedLedger = controller.activeSession?.contextLedger || "";
  if (noteInput && noteInput.value !== savedNote) return true;
  if (ledgerInput && ledgerInput.value !== savedLedger) return true;
  return false;
}

let confirmingLedgerDiscard = false;
async function requestCloseLedger() {
  if (!isLedgerDirty()) {
    setLedgerOpen(false);
    return;
  }
  if (confirmingLedgerDiscard) return;
  confirmingLedgerDiscard = true;
  try {
    const ok = await confirmAction({
      title: "Discard unsaved changes?",
      body: "Your edits haven't been saved yet.",
      confirmLabel: "Discard",
      cancelLabel: "Keep editing",
      tone: "danger",
      initialFocus: "cancel",
    });
    if (ok) setLedgerOpen(false);
  } finally {
    confirmingLedgerDiscard = false;
  }
}

ledgerBtn.addEventListener("click", () => {
  if (ledgerSheet.dataset.open === "true") requestCloseLedger();
  else setLedgerOpen(true);
});
$("close-ledger-btn").addEventListener("click", () => requestCloseLedger());

bindDismissable({
  element: ledgerSheet,
  isOpen: () => ledgerSheet.dataset.open === "true" && !ledgerSheet.hidden,
  onDismiss: () => requestCloseLedger(),
  trigger: ledgerBtn,
});

// In-chat search panel wiring.
const searchPanel = $("chat-search");
const searchInput = $("chat-search-input");

function countTranscriptMatches(messages, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return 0;
  let count = 0;
  for (const msg of messages) {
    const text = stripThoughtBlocks(resolvePlaceholders(String(msg?.content || ""))).toLowerCase();
    if (!text) continue;
    let at = text.indexOf(needle);
    while (at !== -1) {
      count += 1;
      at = text.indexOf(needle, at + needle.length);
    }
  }
  return count;
}

const search = createSearch({
  input: searchInput,
  container: chatInner,
  countEl: $("chat-search-count"),
  onChange: (msg) => notifier.setStatus(msg),
  onClose: () => setSearchOpen(false),
  matchTotal: (query) => countTranscriptMatches(controller.activeSession?.messages || [], query),
  onExpand: () => feed.showMore(),
});

function setSearchOpen(open) {
  searchPanel.dataset.open = open ? "true" : "false";
  $("toggle-search-btn").setAttribute("aria-expanded", open ? "true" : "false");
  if (open) searchInput.focus();
  else { search.clear(); $("toggle-search-btn").focus(); }
}
$("toggle-search-btn").addEventListener("click", () => setSearchOpen(searchPanel.dataset.open !== "true"));
$("chat-search-next").addEventListener("click", () => search.next());
$("chat-search-prev").addEventListener("click", () => search.prev());
$("chat-search-close").addEventListener("click", () => setSearchOpen(false));

function resetSearchQuiet() {
  search.clear();
  searchPanel.dataset.open = "false";
  $("toggle-search-btn").setAttribute("aria-expanded", "false");
}

function syncSessionUrl(id) {
  if (!id || typeof window.history?.replaceState !== "function") return;
  const url = new URL(window.location.href);
  url.searchParams.set("sessionId", id);
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}

function activateSession(sess) {
  closeActiveInlineEdit(chatInner);
  resetSearchQuiet();
  controller.switchSession(sess);
  syncSessionUrl(sess.id);
  composer.setValue(loadDraft(sess.id));
  renderFeed();
  renderHudCharacter();
  restoreChoicesForScene();
}

const dialogs = {
  history: $("history-modal"),
};
const nameOf = (el) => Object.keys(dialogs).find((key) => dialogs[key] === el) || null;
const payloads = new Map();

function syncModalName() {
  const top = topModal();
  const name = top ? nameOf(top) : null;
  if (name) controller.openModal(name, payloads.get(name) ?? null);
  else controller.closeModal();
  $("toggle-context-drawer-btn")?.setAttribute("aria-expanded", name === "history" ? "true" : "false");
}

function openDialog(name, payload = null) {
  const el = dialogs[name];
  if (!el) return;
  payloads.set(name, payload);
  controller.openModal(name, payload);
  if (name === "history") $("toggle-context-drawer-btn")?.setAttribute("aria-expanded", "true");
  openModal({
    element: el,
    trigger: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    onClose: () => syncModalName(),
  });
}

function closeDialog() {
  closeTopModal();
}

const historyModal = createHistoryModal({
  listEl: $("history-threads-list"),
  personaSelectEl: $("history-persona-select"),
  directiveSelectEl: $("history-directive-select"),
  newSceneBtn: $("history-new-scene-btn"),
  closeBtns: [$("close-history-modal-btn"), $("close-history-modal-btn-2")],
  managePersonasBtn: $("history-manage-personas-btn"),
  manageDirectivesBtn: $("history-manage-directives-btn"),
  controller,
  isBusy,
  onActivateSession: activateSession,
  onSessionRenamed: () => renderHudCharacter(),
  onSessionsEmpty: () => { window.location.href = "./"; },
  onExportSession: (sess, format) => {
    if (!sess) return;
    if (format === "json") downloadSessionJsonFile(sess, { cardName: controller.charName || "" });
    else downloadTranscriptFile(sess, exportNames());
  },
  onSessionCreated: async () => {
    closeActiveInlineEdit(chatInner);
    resetSearchQuiet();
    await controller.createSession({ title: `Chat ${controller.sessions.length + 1}` });
    syncSessionUrl(controller.activeSession?.id);
    renderFeed();
    renderHudCharacter();
    closeDialog();
    restoreChoicesForScene();
    showToast("New chat started.", "success");
  },
  onPresetsChanged: ({ kind }) => {
    composer.setPersona({ name: controller.currentPersona?.name || "You", avatar: controller.currentPersona?.avatar || null });
    updateContextStats();
    if (kind === "persona") renderFeed();
  },
  onManagePersonas: () => {
    closeDialog();
    openSettingsPopup("settings-personas-tab");
  },
  onManageDirectives: () => {
    closeDialog();
    openSettingsPopup("settings-system-prompts-tab");
  },
  onOpenDialog: () => openDialog("history"),
  onCloseDialog: closeDialog,
  onToast: showToast,
  onConfirm: confirmAction,
});

$("toggle-context-drawer-btn").addEventListener("click", () => historyModal.open());

const toastHost = { toast: (msg, opts) => showToast(msg, opts?.tone) };
const confirmPreset = async (kind, label) => {
  const noun = kind === "persona" ? "persona" : "prompt";
  return confirmAction({
    title: `Delete this ${noun}?`,
    body: `"${label}" is removed.`,
    confirmLabel: `Delete ${noun}`,
    tone: "danger",
  });
};

let settingsModal = null;
function openSettingsPopup(tabId = null) {
  if (settingsModal) return settingsModal;
  controller.openModal("settings");
  $("toggle-settings-btn")?.setAttribute("aria-expanded", "true");
  settingsModal = openSettingsModal({
    host: toastHost,
    tab: tabId,
    confirm: confirmPreset,
    compressImage,
    getSettings: () => controller.db.getSettings(),
    saveSettings: (patch) => {
      const next = controller.updateSettings(patch);
      window.dispatchEvent(new CustomEvent("settings-saved", { detail: next }));
    },
    fetchModels: ({ endpoint, key }) => BrowserChatEngine.fetchAvailableModels(endpoint, key),
    listPersonas: () => controller.db.getAllPersonas(),
    savePersona: (p) => controller.db.savePersona(p),
    deletePersona: (id) => controller.db.deletePersona(id),
    setDefaultPersona: (id) => controller.db.setDefaultPersona(id),
    listDirectives: () => controller.db.getAllDirectives(),
    saveDirective: (d) => controller.db.saveDirective(d),
    deleteDirective: (id) => controller.db.deleteDirective(id),
    setDefaultDirective: (id) => controller.db.setDefaultDirective(id),
    onDataChanged: async () => {
      const targetCardId = cardId || controller.activeCard?.id;
      if (targetCardId) {
        try {
          await controller.loadCard(targetCardId);
        } catch (e) {
          console.warn("Could not reload card after data change", e);
        }
      }
      await historyModal.refreshPresets();
      renderFeed();
      restoreChoicesForScene();
    },
    onClose: async () => {
      settingsModal = null;
      controller.closeModal();
      $("toggle-settings-btn")?.setAttribute("aria-expanded", "false");
      await historyModal.refreshPresets();
      renderFeed();
      restoreChoicesForScene();
    },
  });
  return settingsModal;
}

$("toggle-settings-btn").addEventListener("click", () => openSettingsPopup());

function renderHudCharacter() {
  document.title = `${controller.charName} - Chat`;
  const nameEl = $("chat-header-name");
  const sessionEl = $("chat-header-session");
  const avatarEl = $("chat-header-avatar");
  if (nameEl) nameEl.textContent = controller.charName || "Character";
  if (sessionEl) sessionEl.textContent = controller.activeSession?.title || "Chat";
  if (avatarEl) {
    avatarEl.innerHTML = avatarInnerHtml(
      cardAvatarUrl(controller.activeCard),
      controller.charName || controller.initialLetter || "C"
    );
  }
}

const headerIdentity = $("chat-header-identity");
if (headerIdentity) {
  headerIdentity.addEventListener("click", () => historyModal.open());
  headerIdentity.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      historyModal.open();
    }
  });
}

window.addEventListener("settings-saved", (e) => {
  controller.settings = e.detail;
  updateContextStats();
});

initTheme();

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && !e.shiftKey) {
    if (controller.openModalName) return;
    e.preventDefault();
    setSearchOpen(true);
  }
});

let booted = false;
try {
  await controller.init(cardId, sessionId);
  booted = true;
} catch (err) {
  booted = false;
  renderBootFailure(err);
}

function renderBootFailure(err) {
  const blocked = err instanceof LocalDbBlockedError;
  feed.renderEmpty({
    title: blocked ? "This app is open in another tab" : "No character to chat with",
    body: blocked
      ? "Close the other tab or window using this app, then reload this page."
      : "Import a character card in the library first, then open a chat from there.",
    actionLabel: "Go to the library",
    onAction: () => { window.location.href = "./"; },
  });
  authorInput.disabled = true;
  sendBtn.disabled = true;
  stopBtn.hidden = true;
  if (!blocked) console.warn("Chat boot failed:", err);
}

if (booted) {
  syncSessionUrl(controller.activeSession?.id);
  composer.setValue(loadDraft(controller.activeSession?.id));
  authorInput.addEventListener("input", () => {
    saveDraft(composer.getValue());
    updateContextStats();
  });
  renderHudCharacter();
  await historyModal.refreshPresets();
  renderFeed();

  const storedMode = controller.settings?.choiceMode === "choice" ? "choice" : "normal";
  setMode(storedMode, { persist: false });

  if (!controller.settings?.apiEndpoint || !controller.settings?.model) {
    showToast("No model configured yet. Open Settings to add an endpoint and choose a model.", "info");
  }

  if (window.visualViewport) {
    let scheduled = false;
    const syncHeight = () => {
      scheduled = false;
      const vv = window.visualViewport;
      const isPinchZoom = vv.scale > 1.01;
      const editing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (isPinchZoom || !editing) {
        document.documentElement.style.removeProperty("--app-height");
      } else {
        document.documentElement.style.setProperty("--app-height", `${vv.height}px`);
      }
    };
    const onChange = () => {
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(syncHeight);
      }
    };
    window.visualViewport.addEventListener("resize", onChange);
    window.visualViewport.addEventListener("scroll", onChange);
    syncHeight();
  }

  if ("serviceWorker" in navigator && window.isSecureContext) {
    try { navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(() => {}); } catch (_) {}
  }

  window.__chat = {
    get messages() { return controller.activeSession?.messages || []; },
    get session() { return controller.activeSession; },
    get busy() { return composer.busy; },
    get theme() { return getTheme(); },
    get mode() { return mode; },
    get choices() { return controller.choiceState.choices.map((c) => ({ ...c })); },
    get choiceStatus() { return controller.choiceState.status; },
    selectChoice: (id) => selectChoice(id),
    regenerateChoices: () => requestChoices({ isRegenerate: true }),
    setMode: (m) => setMode(m),
    toggleTheme,
    stop: () => stopTurn(),
  };
}
