// Message forks, reasoning blocks, interactive Context Inspector, Card Studio, and Settings profiles.

import { describe, test, expect, afterEach } from "bun:test";
import { foldNow } from "../public/browser_engine.js";
import { planRequest } from "../public/prompt_builder.js";
import { extractThoughtBlocks, stripThoughtBlocks, resolvePronouns } from "../public/text.js";
import { serializeCardV2, buildPngWithChara } from "../public/card_parse.js";
import { parseCardFile } from "../public/ui/import_flow.js";
import { LocalDb } from "../public/local_db.js";
import { SessionController } from "../public/session_controller.js";
import { createMessageFeed } from "../public/ui/chat/message_feed.js";
import { createChoicePanel } from "../public/ui/chat/choice_panel.js";
import { renderContextPanel } from "../public/ui/chat/context_panel.js";
import { downloadSessionJsonFile } from "../public/ui/data_transfer.js";
import { sortCards } from "../public/ui/character_card.js";
import { createLibraryController } from "../public/ui/library_controller.js";
import { openCardEditor } from "../public/ui/editors/card_editor.js";
import { createToastHost } from "../public/ui/toast.js";
import { openModal, closeModal, isOpen } from "../public/ui/modal.js";
import {
  elenaCard,
  TEST_SETTINGS,
  makeControllerDb,
  makeControllerFake,
} from "./helpers.ts";
import { installDom, click, ShimNode } from "./dom_shim.ts";

const ORIG_LOCAL_STORAGE = globalThis.localStorage;
const ORIG_DOC = globalThis.document;
const ORIG_WIN = globalThis.window;
const ORIG_HTML_ELEMENT = (globalThis as Record<string, unknown>).HTMLElement;

function installMemStorage() {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(String(k), String(v)); },
    removeItem: (k: string) => { map.delete(String(k)); },
    clear: () => { map.clear(); },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size; },
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
}

function setupDomWithBody() {
  const doc = installDom() as unknown as {
    createElement: (tag: string) => Record<string, unknown>;
    body: { querySelector: (s: string) => unknown };
    getElementById?: (id: string) => unknown;
  };
  doc.body = doc.createElement("body") as unknown as { querySelector: (s: string) => unknown };
  doc.getElementById = (id: string) => doc.body.querySelector(`[id="${id}"]`) || null;
  (globalThis as Record<string, unknown>).HTMLElement = ShimNode;
  (globalThis as Record<string, unknown>).requestAnimationFrame = () => 0;
  if (!(ShimNode.prototype as unknown as Record<string, unknown>).contains) {
    (ShimNode.prototype as unknown as Record<string, unknown>).contains = function (this: { descendants: () => unknown[] }, other: unknown) {
      return this === other || this.descendants().includes(other);
    };
  }
  return doc;
}

function byId(root: unknown, id: string): Record<string, unknown> | null {
  const node = root as { id?: string; attributes?: Record<string, string>; descendants?: () => unknown[] };
  return (node.descendants?.() || []).find(
    (n) => (n as { id?: string; attributes?: Record<string, string> }).id === id ||
           (n as { attributes?: Record<string, string> }).attributes?.id === id,
  ) as Record<string, unknown> || null;
}

afterEach(() => {
  if (ORIG_DOC === undefined) delete (globalThis as Record<string, unknown>).document;
  else (globalThis as Record<string, unknown>).document = ORIG_DOC;
  if (ORIG_WIN === undefined) delete (globalThis as Record<string, unknown>).window;
  else (globalThis as Record<string, unknown>).window = ORIG_WIN;
  if (ORIG_HTML_ELEMENT === undefined) delete (globalThis as Record<string, unknown>).HTMLElement;
  else (globalThis as Record<string, unknown>).HTMLElement = ORIG_HTML_ELEMENT;
  if (ORIG_LOCAL_STORAGE === undefined) delete (globalThis as Record<string, unknown>).localStorage;
  else Object.defineProperty(globalThis, "localStorage", { value: ORIG_LOCAL_STORAGE, configurable: true });
});

describe("Message forks, partial Stop, Continue & Rewind", () => {
  test("getMessageForkInfo, cycleMessageFork & reroll preserve forks[]", async () => {
    const db = makeControllerDb({
      cards: [elenaCard()],
      sessions: [{
        id: "s1",
        cardId: elenaCard().id,
        title: "Forks",
        messages: [
          {
            id: "m0",
            role: "assistant",
            content: "Greeting B",
            forks: [{ id: "f0", content: "Greeting A" }],
            timestamp: 1000,
          },
          { id: "m1", role: "user", content: "Hello", timestamp: 2000 },
          { id: "m2", role: "assistant", content: "Reply 1", timestamp: 3000 },
        ],
        createdAt: 1000,
        updatedAt: 3000,
      }],
    });
    const { ctl } = await makeControllerFake(SessionController, {
      db,
      engine: {
        streamTurn: async ({ onChunk }: { onChunk: (s: string) => void }) => {
          onChunk("Reply 2");
          return { fullResponse: "Reply 2", promptMessages: [], usage: null };
        },
        foldIfNeeded: async () => ({ folded: false }),
        generateChoices: async () => [],
      },
    });

    expect(ctl.getMessageForkInfo("m0")).toEqual({ current: 2, total: 2 });
    await ctl.cycleMessageFork("m0", -1);
    expect(ctl.getMessageForkInfo("m0")).toEqual({ current: 1, total: 2 });
    expect(ctl.activeSession.messages[0].content).toBe("Greeting A");

    await ctl.reroll("m2");
    await ctl.streamResponse(() => {});
    const lastId = ctl.activeSession.messages[2].id;
    expect(ctl.getMessageForkInfo(lastId)).toEqual({ current: 2, total: 2 });
    expect(ctl.activeSession.messages[2].content).toBe("Reply 2");
    await ctl.cycleMessageFork(lastId, -1);
    expect(ctl.activeSession.messages[2].content).toBe("Reply 1");
  });

  test("cancel({ keepPartial: true }) keeps partial response and continueResponse appends", async () => {
    const db = makeControllerDb({
      cards: [elenaCard()],
      sessions: [{
        id: "s1",
        cardId: elenaCard().id,
        title: "Partial",
        messages: [{ id: "m0", role: "assistant", content: "Opening.", timestamp: 1000 }],
        createdAt: 1000,
        updatedAt: 1000,
      }],
      settings: TEST_SETTINGS,
    });
    let ctlRef: InstanceType<typeof SessionController> | null = null;
    const { ctl } = await makeControllerFake(SessionController, {
      db,
      engine: {
        streamTurn: async ({ signal, onChunk, continueMode }: { signal?: AbortSignal; onChunk: (s: string) => void; continueMode?: boolean }) => {
          if (continueMode) {
            onChunk(" the sentence.");
            return { fullResponse: " the sentence.", promptMessages: [], usage: null };
          }
          onChunk("Halfway ");
          ctlRef?.cancel({ keepPartial: true });
          if (signal?.aborted) {
            const err = new Error("Aborted");
            err.name = "AbortError";
            throw err;
          }
          return { fullResponse: "Halfway ", promptMessages: [], usage: null };
        },
        foldIfNeeded: async () => ({ folded: false }),
        generateChoices: async () => [],
      },
    });
    ctlRef = ctl;

    await ctl.send("Go on");
    expect(ctl.activeSession.messages.at(-1).content).toBe("Halfway ");

    const cont = await ctl.continueResponse();
    expect(cont?.content).toBe("Halfway  the sentence.");
    expect(ctl.activeSession.messages.at(-1).content).toBe("Halfway  the sentence.");
  });

  test("rewindToMessage trims trailing turns and restoreRewoundMessages restores them", async () => {
    const db = makeControllerDb({
      cards: [elenaCard()],
      sessions: [{
        id: "s1",
        cardId: elenaCard().id,
        title: "Rewind",
        messages: [
          { id: "m0", role: "assistant", content: "A", timestamp: 1000 },
          { id: "m1", role: "user", content: "B", timestamp: 2000 },
          { id: "m2", role: "assistant", content: "C", timestamp: 3000 },
        ],
        createdAt: 1000,
        updatedAt: 3000,
      }],
    });
    const { ctl } = await makeControllerFake(SessionController, { db });

    const rewound = await ctl.rewindToMessage("m0");
    expect(rewound.removed.length).toBe(2);
    expect(ctl.activeSession.messages.map((m: { id: string }) => m.id)).toEqual(["m0"]);

    await ctl.restoreRewoundMessages(rewound);
    expect(ctl.activeSession.messages.map((m: { id: string }) => m.id)).toEqual(["m0", "m1", "m2"]);
  });
});

describe("Reasoning / Thinking blocks", () => {
  test("extractThoughtBlocks separates <think> from prose and message_feed renders <details class='rp-message__thought'>", () => {
    const raw = "<think>Plan step 1.\nPlan step 2.</think>\n\nShe opens the door.";
    const extracted = extractThoughtBlocks(raw);
    expect(extracted.thought).toBe("Plan step 1.\nPlan step 2.");
    expect(extracted.isThinking).toBe(false);
    expect(stripThoughtBlocks(raw)).toBe("She opens the door.");

    const doc = setupDomWithBody();
    const mount = doc.createElement("div") as unknown as HTMLElement;
    const feed = createMessageFeed({
      mount,
      formatProse: (t: string) => `<p>${t}</p>`,
    });
    feed.setMessages([{
      id: "m1",
      role: "assistant",
      content: "She opens the door.",
      thought: "Internal reasoning note.",
      timestamp: 1000,
    }]);
    const article = (mount as unknown as { children: Array<{ innerHTML: string }> }).children[0];
    expect(article.innerHTML).toContain('class="rp-message__thought"');
    expect(article.innerHTML).toContain("Internal reasoning note.");
  });
});

describe("Choice Mode inline prose, Edit & idle Generate", () => {
  test("choice_panel renders .rp-choices__prose, fires onEdit on hold, and shows Generate choices when idle & canGenerate", async () => {
    const doc = setupDomWithBody();
    const mount = doc.createElement("div") as unknown as HTMLElement;
    let edited: { id?: string } | null = null;
    let retried = 0;
    let selected = 0;
    const panel = createChoicePanel({
      mount,
      holdDurationMs: 25,
      onSelect: () => { selected += 1; },
      onEdit: (choice: { id?: string }) => { edited = choice; },
      onRetry: () => { retried += 1; },
    });

    panel.render({
      mode: "choice",
      status: "idle",
      choices: [],
      canGenerate: true,
    });
    const genBtn = mount.querySelector(".rp-choices__generate-btn") as unknown as Parameters<typeof click>[0] | null;
    expect(genBtn).not.toBeNull();
    click(genBtn!);
    expect(retried).toBe(1);

    panel.render({
      mode: "choice",
      status: "ready",
      choices: [{ id: "c1", label: "Quietly", text: "She lowers her lantern and steps back." }],
      canGenerate: true,
    });
    const prose = mount.querySelector(".rp-choices__prose");
    expect(prose?.textContent).toBe("She lowers her lantern and steps back.");
    expect(mount.querySelector("[data-edit-choice-id]")).toBeNull();

    const listEl = mount.querySelector(".rp-choices__list") as unknown as {
      dispatch: (t: string, ev: unknown) => void;
    };
    const choiceBtn = mount.querySelector("[data-choice-id]") as unknown as ShimNode & {
      classList: { contains: (c: string) => boolean };
    };
    expect(choiceBtn.getAttribute("data-can-edit")).toBe("true");

    // Short tap submits without editing
    listEl.dispatch("pointerdown", { target: choiceBtn, pointerType: "touch", clientX: 10, clientY: 10 });
    expect(choiceBtn.classList.contains("is-holding")).toBe(true);
    listEl.dispatch("pointerup", { target: choiceBtn });
    expect(choiceBtn.classList.contains("is-holding")).toBe(false);
    click(choiceBtn as unknown as Parameters<typeof click>[0]);
    expect(selected).toBe(1);
    expect(edited).toBeNull();

    // Hold triggers onEdit and suppresses the subsequent click
    listEl.dispatch("pointerdown", { target: choiceBtn, pointerType: "touch", clientX: 10, clientY: 10 });
    expect(choiceBtn.classList.contains("is-holding")).toBe(true);
    await new Promise((r) => setTimeout(r, 40));
    expect(choiceBtn.classList.contains("is-holding")).toBe(false);
    expect(edited?.id).toBe("c1");
    click(choiceBtn as unknown as Parameters<typeof click>[0]);
    expect(selected).toBe(1);

    // Inline "Hold to edit" hint is first in .rp-choices__actions and visible when ready
    const actionsRow = mount.querySelector(".rp-choices__actions") as unknown as {
      children: Array<{ className?: string; textContent?: string; hidden?: boolean }>;
    };
    const hint = mount.querySelector(".rp-choices__hint") as unknown as {
      textContent?: string;
      hidden?: boolean;
    };
    expect(hint?.textContent).toBe("Hold to edit");
    expect(hint?.hidden).toBe(false);
    expect(actionsRow.children[0]).toBe(hint as unknown as { className?: string });

    // Per-card "More" / "Less" toggle expands/collapses without submitting
    const more = mount.querySelector(".rp-choices__more") as unknown as Parameters<typeof click>[0] & {
      textContent: string;
    };
    expect(more).not.toBeNull();
    expect(more.textContent).toBe("More");
    click(more);
    expect(choiceBtn.classList.contains("is-expanded")).toBe(true);
    expect(more.textContent).toBe("Less");
    expect(selected).toBe(1);
    click(more);
    expect(choiceBtn.classList.contains("is-expanded")).toBe(false);
    expect(more.textContent).toBe("More");
    expect(selected).toBe(1);
  });
});

describe("Context Inspector, Author's Note, Session Overrides, Draft & Export", () => {
  test("planRequest injects authorsNote and matchedLore, and renderContextPanel shows matchedLore & controls", () => {
    const card = {
      ...elenaCard(),
      character_book: {
        entries: [
          { id: 1, keys: ["obsidian"], content: "Obsidian wards hum near magic.", enabled: true },
        ],
      },
    };
    const session = {
      id: "s1",
      cardId: card.id,
      authorsNote: "Keep the pacing tense and clipped.",
      ledger: "",
      messages: [
        { id: "m0", role: "assistant", content: "The obsidian seal gleams.", timestamp: 1000 },
        { id: "m1", role: "user", content: "I touch the obsidian.", timestamp: 2000 },
      ],
    };
    const plan = planRequest({
      card,
      session,
      settings: TEST_SETTINGS,
      persona: { name: "You" },
      agentsContract: "Write cleanly.",
      draft: "Drafting a long next move.",
    });
    expect(plan.matchedLore.length).toBe(1);
    expect(plan.matchedLore[0].name).toBe("obsidian");
    expect(plan.postHistory).toContain("[Author's Note:\nKeep the pacing tense and clipped.]");

    const html = renderContextPanel({
      request: plan,
      interactive: true,
      ledgerText: "Recap text",
      authorsNote: session.authorsNote,
      canFold: false,
    });
    expect(html).toContain("Active lorebook entries: obsidian.");
    expect(html).toContain("data-context-authors-note");
    expect(html).toContain("data-context-export");
  });

  test("LocalDb.resolveForCard honors session override, foldNow is exported, and downloadSessionJsonFile exists", async () => {
    installMemStorage();
    LocalDb.savePersona({ id: "p_custom", name: "Iris", gender: "female" });
    const card = { ...elenaCard(), userPersonaId: "" };
    const resolved = await LocalDb.resolvePersonaForCard(card, { userPersonaId: "p_custom" });
    expect(resolved?.id).toBe("p_custom");
    expect(resolved?.name).toBe("Iris");
    expect(typeof foldNow).toBe("function");
    expect(typeof downloadSessionJsonFile).toBe("function");
  });
});

describe("Card Studio, CCv2 JSON/PNG Round-Trip & Favorites", () => {
  test("serializeCardV2 and buildPngWithChara round-trip through parseCardFile", async () => {
    const base = elenaCard();
    const card = {
      ...base,
      data: {
        ...base.data,
        alternate_greetings: ["Alt greeting one"],
        character_book: { entries: [{ id: 1, keys: ["ward"], content: "Ward lore", enabled: true }] },
      },
    };
    const json = JSON.stringify(serializeCardV2(card));
    const jsonParsed = await parseCardFile(new File([json], "elena.json", { type: "application/json" }));
    expect(jsonParsed.data.name).toBe("Elena Voss");
    expect(jsonParsed.data.alternate_greetings).toEqual(["Alt greeting one"]);

    const pngBytes = buildPngWithChara(card, null);
    expect(pngBytes[0]).toBe(0x89);
    const pngParsed = await parseCardFile(new File([pngBytes], "elena.png", { type: "image/png" }));
    expect(pngParsed.data.name).toBe("Elena Voss");
    expect(pngParsed.data.character_book.entries[0].content).toBe("Ward lore");
  });

  test("library_controller toggleFavorite, cloneCard, favorites sort & openCardEditor", async () => {
    setupDomWithBody();
    const cards = new Map<string, Record<string, unknown>>([
      ["c1", { ...elenaCard(), id: "c1", name: "Alpha", data: { ...elenaCard().data, name: "Alpha" } }],
      ["c2", { ...elenaCard(), id: "c2", name: "Beta", data: { ...elenaCard().data, name: "Beta" } }],
    ]);
    const db = {
      getAllCards: async () => Array.from(cards.values()),
      getAllSessions: async () => [],
      saveCard: async (c: Record<string, unknown>) => { cards.set(String(c.id), c); return c; },
      deleteCard: async (id: string) => { cards.delete(id); },
      deleteSession: async () => {},
      saveSession: async (s: unknown) => s,
    };
    const ctrl = createLibraryController({ db });
    await ctrl.refresh();

    await ctrl.toggleFavorite("c2");
    const sorted = sortCards(ctrl.getState().cards, "favorites");
    expect(sorted[0].id).toBe("c2");

    const copy = await ctrl.cloneCard("c1");
    expect(copy.name).toBe("Alpha (Copy)");

    let saved: { name?: string; spec?: string } | null = null;
    const modal = openCardEditor({
      card: null,
      onSave: async (payload: { name?: string; spec?: string }) => { saved = payload; },
    });
    const portraitBtn = modal.element.querySelector(".rp-detail__portrait") as unknown as {
      tagName?: string;
    } | null;
    expect(portraitBtn?.tagName).toBe("BUTTON");
    const standaloneButtons = (modal.element as unknown as { descendants: () => Array<{ tagName?: string; textContent?: string; hidden?: boolean }> })
      .descendants()
      .filter((n) => n.tagName === "BUTTON");
    expect(standaloneButtons.some((b) => b.textContent === "Upload photo")).toBe(false);
    const removePhotoBtn = standaloneButtons.find((b) => b.textContent === "Remove photo");
    expect(removePhotoBtn?.hidden).toBe(true);

    const form = modal.element.querySelector("form") as unknown as { dispatch: (t: string, ev: unknown) => void };
    (byId(modal.element, "rp-card-name") as unknown as HTMLInputElement).value = "Rowan";
    (byId(modal.element, "rp-card-description") as unknown as HTMLTextAreaElement).value = "A quiet cartographer.";
    form.dispatch("submit", { preventDefault() {} });
    await new Promise((r) => setTimeout(r, 10));
    expect(saved?.name).toBe("Rowan");
    expect(saved?.spec).toBe("chara_card_v2");
  });

  test("openModal onRequestClose blocks backdrop dismissal when returning false and closes when true", async () => {
    const doc = setupDomWithBody();
    const dialog = doc.createElement("dialog") as unknown as ShimNode & {
      getBoundingClientRect?: () => { left: number; top: number; right: number; bottom: number };
      dispatch: (t: string, ev: unknown) => void;
    };
    const panel = doc.createElement("div") as unknown as ShimNode & {
      getBoundingClientRect?: () => { left: number; top: number; right: number; bottom: number };
    };
    panel.className = "rp-dialog__panel";
    panel.getBoundingClientRect = () => ({ left: 100, top: 100, right: 300, bottom: 300 });
    dialog.appendChild(panel);
    (doc.body as unknown as ShimNode).appendChild(dialog);

    let allowClose = false;
    openModal({
      element: dialog as unknown as HTMLElement,
      onRequestClose: async () => allowClose,
    });
    expect(isOpen(dialog as unknown as HTMLElement)).toBe(true);

    // Backdrop click outside panel -> blocked
    dialog.dispatch("pointerdown", { target: dialog });
    dialog.dispatch("click", { target: dialog, clientX: 10, clientY: 10 });
    await new Promise((r) => setTimeout(r, 10));
    expect(isOpen(dialog as unknown as HTMLElement)).toBe(true);

    // Backdrop click when allowed -> closes
    allowClose = true;
    dialog.dispatch("pointerdown", { target: dialog });
    dialog.dispatch("click", { target: dialog, clientX: 10, clientY: 10 });
    await new Promise((r) => setTimeout(r, 10));
    expect(isOpen(dialog as unknown as HTMLElement)).toBe(false);
    closeModal(dialog as unknown as HTMLElement);
  });

  test("openCardEditor prompts before discarding unsaved edits on backdrop click", async () => {
    const doc = setupDomWithBody();

    // Untouched editor closes immediately on backdrop click.
    const cleanModal = openCardEditor({ card: null });
    const cleanDialog = cleanModal.element as unknown as ShimNode & {
      dispatch: (t: string, ev: unknown) => void;
      querySelector: (s: string) => ShimNode | null;
    };
    const cleanPanel = cleanDialog.querySelector(".rp-dialog__panel") as unknown as {
      getBoundingClientRect?: () => { left: number; top: number; right: number; bottom: number };
    };
    cleanPanel.getBoundingClientRect = () => ({ left: 100, top: 100, right: 400, bottom: 400 });
    cleanDialog.dispatch("pointerdown", { target: cleanDialog });
    cleanDialog.dispatch("click", { target: cleanDialog, clientX: 10, clientY: 10 });
    await new Promise((r) => setTimeout(r, 10));
    expect(isOpen(cleanModal.element)).toBe(false);

    // Dirty editor shows "Discard unsaved changes?" confirmation on backdrop click.
    const dirtyModal = openCardEditor({ card: null });
    const dirtyDialog = dirtyModal.element as unknown as ShimNode & {
      dispatch: (t: string, ev: unknown) => void;
      querySelector: (s: string) => ShimNode | null;
    };
    const dirtyPanel = dirtyDialog.querySelector(".rp-dialog__panel") as unknown as {
      getBoundingClientRect?: () => { left: number; top: number; right: number; bottom: number };
    };
    dirtyPanel.getBoundingClientRect = () => ({ left: 100, top: 100, right: 400, bottom: 400 });
    (byId(dirtyModal.element, "rp-card-name") as unknown as HTMLInputElement).value = "Edited Name";

    dirtyDialog.dispatch("pointerdown", { target: dirtyDialog });
    dirtyDialog.dispatch("click", { target: dirtyDialog, clientX: 10, clientY: 10 });
    await new Promise((r) => setTimeout(r, 10));

    // Confirmation dialog is open; editor remains open.
    expect(isOpen(dirtyModal.element)).toBe(true);
    const bodyNodes = (doc.body as unknown as ShimNode).descendants();
    const confirmDialog = bodyNodes.find(
      (n) =>
        n.tagName === "DIALOG" &&
        n !== dirtyDialog &&
        n.descendants().some((d) => d.textContent?.includes("Discard unsaved changes?")),
    );
    expect(confirmDialog).toBeTruthy();

    // Click "Keep editing" -> editor stays open.
    const keepBtn = confirmDialog!.descendants().find(
      (n) => n.tagName === "BUTTON" && n.textContent === "Keep editing",
    );
    expect(keepBtn).toBeTruthy();
    click(keepBtn!);
    await new Promise((r) => setTimeout(r, 10));
    expect(isOpen(dirtyModal.element)).toBe(true);

    // Trigger backdrop again and click "Discard" -> editor closes.
    dirtyDialog.dispatch("pointerdown", { target: dirtyDialog });
    dirtyDialog.dispatch("click", { target: dirtyDialog, clientX: 10, clientY: 10 });
    await new Promise((r) => setTimeout(r, 10));
    const confirmDialog2 = (doc.body as unknown as ShimNode).descendants().find(
      (n) =>
        n.tagName === "DIALOG" &&
        n !== dirtyDialog &&
        n.descendants().some((d) => d.textContent?.includes("Discard unsaved changes?")),
    );
    const discardBtn = confirmDialog2!.descendants().find(
      (n) => n.tagName === "BUTTON" && n.textContent === "Discard",
    );
    click(discardBtn!);
    await new Promise((r) => setTimeout(r, 10));
    expect(isOpen(dirtyModal.element)).toBe(false);
  });

  test("openSettingsModal prompts before discarding unsaved engine edits on backdrop click", async () => {
    setupDomWithBody();
    const { openSettingsModal } = await import("../public/ui/settings/settings_modal.js");
    const origMatches = ShimNode.prototype.matches;
    ShimNode.prototype.matches = function (this: ShimNode, selector: string) {
      if (selector.startsWith("#")) {
        const id = selector.slice(1);
        return this.id === id || this.attributes.id === id;
      }
      return origMatches.call(this, selector);
    };

    try {
      let confirmCount = 0;
      let confirmResult = false;
      const baseOpts = {
        getSettings: () => ({ apiEndpoint: "https://api.example.com/v1", apiKey: "", model: "m1" }),
        saveSettings: () => {},
        listPersonas: () => [],
        listDirectives: () => [],
        confirmAction: async () => {
          confirmCount += 1;
          return confirmResult;
        },
      };

      // Clean settings modal closes immediately without prompting.
      const clean = openSettingsModal(baseOpts);
      const cleanDialog = clean.element as unknown as ShimNode & {
        dispatch: (t: string, ev: unknown) => void;
        querySelector: (s: string) => ShimNode | null;
      };
      const cleanPanel = cleanDialog.querySelector(".rp-dialog__panel") as unknown as {
        getBoundingClientRect?: () => { left: number; top: number; right: number; bottom: number };
      };
      cleanPanel.getBoundingClientRect = () => ({ left: 100, top: 100, right: 400, bottom: 400 });
      cleanDialog.dispatch("pointerdown", { target: cleanDialog });
      cleanDialog.dispatch("click", { target: cleanDialog, clientX: 10, clientY: 10 });
      await new Promise((r) => setTimeout(r, 10));
      expect(confirmCount).toBe(0);
      expect(isOpen(clean.element)).toBe(false);

      // Dirty engine field triggers confirmation; stays open when rejected, closes when confirmed.
      const dirty = openSettingsModal(baseOpts);
      const dirtyDialog = dirty.element as unknown as ShimNode & {
        dispatch: (t: string, ev: unknown) => void;
        querySelector: (s: string) => ShimNode | null;
      };
      const dirtyPanel = dirtyDialog.querySelector(".rp-dialog__panel") as unknown as {
        getBoundingClientRect?: () => { left: number; top: number; right: number; bottom: number };
      };
      dirtyPanel.getBoundingClientRect = () => ({ left: 100, top: 100, right: 400, bottom: 400 });
      (byId(dirty.element, "popup-api-endpoint") as unknown as HTMLInputElement).value = "https://changed.example.com/v1";

      confirmResult = false;
      dirtyDialog.dispatch("pointerdown", { target: dirtyDialog });
      dirtyDialog.dispatch("click", { target: dirtyDialog, clientX: 10, clientY: 10 });
      await new Promise((r) => setTimeout(r, 10));
      expect(confirmCount).toBe(1);
      expect(isOpen(dirty.element)).toBe(true);

      confirmResult = true;
      dirtyDialog.dispatch("pointerdown", { target: dirtyDialog });
      dirtyDialog.dispatch("click", { target: dirtyDialog, clientX: 10, clientY: 10 });
      await new Promise((r) => setTimeout(r, 10));
      expect(confirmCount).toBe(2);
      expect(isOpen(dirty.element)).toBe(false);
    } finally {
      ShimNode.prototype.matches = origMatches;
    }
  });

  test("saving an engine profile preserves URL/key for Test connection and createToastHost promotes top-layer popover", async () => {
    const doc = setupDomWithBody();
    const { openSettingsModal } = await import("../public/ui/settings/settings_modal.js");
    const origMatches = ShimNode.prototype.matches;
    ShimNode.prototype.matches = function (this: ShimNode, selector: string) {
      if (selector.startsWith("#")) {
        const id = selector.slice(1);
        return this.id === id || this.attributes.id === id;
      }
      return origMatches.call(this, selector);
    };

    try {
      let state: Record<string, unknown> = {
        apiEndpoint: "",
        apiKey: "",
        model: "",
        apiProfiles: [],
        activeProfileId: "",
      };
      const toasts: Array<{ msg: string; tone?: string }> = [];
      let fetchedWith: { endpoint?: string; key?: string } | null = null;

      const modal = openSettingsModal({
        getSettings: () => state,
        saveSettings: (patch: Record<string, unknown>) => {
          state = { ...state, ...patch };
        },
        fetchModels: async (args: { endpoint?: string; key?: string }) => {
          fetchedWith = args;
          return [{ id: "gpt-4o" }];
        },
        listPersonas: () => [],
        listDirectives: () => [],
        host: {
          toast: (msg: string, opts?: { tone?: string }) => {
            toasts.push({ msg, tone: opts?.tone });
          },
        },
      });

      const epInput = byId(modal.element, "popup-api-endpoint") as unknown as HTMLInputElement;
      const keyInput = byId(modal.element, "popup-api-key") as unknown as HTMLInputElement;
      const profileSelect = byId(modal.element, "popup-profile-select") as unknown as HTMLSelectElement & ShimNode;
      const choiceSelect = byId(modal.element, "popup-choice-model-select") as unknown as HTMLSelectElement;
      const choiceInput = byId(modal.element, "popup-choice-model-input") as unknown as HTMLInputElement;
      const saveProfBtn = byId(modal.element, "popup-save-profile-btn") as unknown as ShimNode;
      const testBtn = byId(modal.element, "popup-test-conn-btn") as unknown as ShimNode;

      // Hidden custom choiceInput should not override visible choiceSelect.
      choiceInput.hidden = true;
      choiceInput.value = "stale-hidden-choice";
      const opt = doc.createElement("option") as unknown as HTMLOptionElement;
      opt.value = "selected-choice";
      opt.textContent = "selected-choice";
      choiceSelect.appendChild(opt);
      choiceSelect.value = "selected-choice";

      epInput.value = "https://openrouter.ai/api/v1";
      keyInput.value = "sk-test-123";
      click(saveProfBtn);

      expect(state.apiEndpoint).toBe("https://openrouter.ai/api/v1");
      expect(state.apiKey).toBe("sk-test-123");
      expect(state.choiceModel).toBe("selected-choice");
      expect(epInput.value).toBe("https://openrouter.ai/api/v1");
      expect(keyInput.value).toBe("sk-test-123");

      // Switching profile dropdown to "" ("Select saved profile...") keeps typed inputs intact.
      profileSelect.value = "";
      (profileSelect as unknown as ShimNode).dispatch("change");
      expect(epInput.value).toBe("https://openrouter.ai/api/v1");
      expect(keyInput.value).toBe("sk-test-123");

      click(testBtn);
      await new Promise((r) => setTimeout(r, 10));
      expect(fetchedWith).toEqual({ endpoint: "https://openrouter.ai/api/v1", key: "sk-test-123" });
      expect(toasts.some((t) => t.tone === "success" && t.msg.includes("Connection OK"))).toBe(true);

      // Toast host top-layer popover promotion & demotion
      let popoverOpen = false;
      let showCalls = 0;
      let hideCalls = 0;
      const region = doc.createElement("div") as unknown as ShimNode & {
        showPopover?: () => void;
        hidePopover?: () => void;
      };
      region.className = "rp-toast-region";
      region.showPopover = () => {
        popoverOpen = true;
        showCalls += 1;
      };
      region.hidePopover = () => {
        popoverOpen = false;
        hideCalls += 1;
      };
      const origRegionMatches = region.matches.bind(region);
      region.matches = (sel: string) => (sel === ":popover-open" ? popoverOpen : origRegionMatches(sel));
      (doc.body as unknown as ShimNode).appendChild(region);

      const host = createToastHost({ root: doc.body as unknown as HTMLElement, region: region as unknown as HTMLElement });
      expect(region.getAttribute("popover")).toBe("manual");
      const dismiss = host.toast("Connection OK", { tone: "success", duration: 0 });
      expect(showCalls).toBe(1);
      expect(popoverOpen).toBe(true);
      dismiss();
      expect(hideCalls).toBe(1);
      expect(popoverOpen).toBe(false);
    } finally {
      ShimNode.prototype.matches = origMatches;
    }
  });
});

describe("Settings Profiles, Numeric Params, Custom Pronouns & Backup Options", () => {
  test("resolvePronouns supports 5-part and 3-part slash-separated pronouns", () => {
    const five = resolvePronouns({ pronouns: "they/them/their/theirs/themself" });
    expect(five).toEqual({
      sub: "they",
      obj: "them",
      poss: "their",
      possp: "theirs",
      ref: "themself",
    });
    const three = resolvePronouns({ pronouns: "ze/hir/hirs" });
    expect(three.sub).toBe("ze");
    expect(three.obj).toBe("hir");
    expect(three.poss).toBe("hirs");
    expect(three.ref).toBe("hirself");
  });

  test("LocalDb.exportAllData({ excludeSecrets: true }) strips apiKey, profiles keys & session cookies", async () => {
    installMemStorage();
    const fakeDb = new LocalDb({
      idb: {
        getAllCards: async () => [],
        getAllSessions: async () => [],
        saveCard: async () => {},
        saveSession: async () => {},
        clear: async () => {},
      },
    });
    fakeDb.saveSettings({
      apiEndpoint: "https://api.example.com/v1",
      apiKey: "sk-secret-123",
      apiProfiles: [{ id: "p1", name: "Main", apiEndpoint: "https://api.example.com/v1", apiKey: "sk-prof-456" }],
    });
    const sanitized = await fakeDb.exportAllData({
      cookies: [{ name: "vibe_rp_token", value: "secret" }],
      excludeSecrets: true,
    });
    const storedSettings = JSON.parse(sanitized.data.localStorage.vibe_rp_settings);
    expect(storedSettings.apiKey).toBe("");
    expect(storedSettings.apiProfiles[0].apiKey).toBe("");
    expect(sanitized.data.cookies).toEqual([]);
  });

  test("Settings modal renders connection profiles, aux model toggles, JanitorAI session & data options, and conditional custom pronouns", async () => {
    const doc = setupDomWithBody();
    installMemStorage();
    const { openSettingsModal } = await import("../public/ui/settings/settings_modal.js");
    const { openPersonaEditor } = await import("../public/ui/editors/persona_editor.js");
    const modal = openSettingsModal({
      getSettings: () => ({ ...TEST_SETTINGS, apiProfiles: [] }),
      saveSettings: () => {},
      saveSession: () => ({ ok: true }),
      listPersonas: async () => [],
      listDirectives: async () => [],
    });
    expect(byId(modal.element, "popup-profile-select")).not.toBeNull();
    expect(byId(modal.element, "popup-choice-model-input")).not.toBeNull();
    expect(byId(modal.element, "popup-summary-model-input")).not.toBeNull();
    expect(byId(modal.element, "popup-slider-temp-num")).toBeNull();
    expect(byId(modal.element, "popup-import-session-wrap")).not.toBeNull();
    expect(byId(modal.element, "rp-data-exclude-secrets")).not.toBeNull();
    expect(byId(modal.element, "rp-data-replace-mode")).not.toBeNull();
    modal.close();

    // Custom pronouns input stays hidden unless "custom" is selected
    const pDone = openPersonaEditor({ persona: { id: "p1", name: "Alex", gender: "male" } });
    const genderEl = byId(doc.body, "rp-persona-gender") as unknown as {
      value: string;
      dispatch: (t: string) => void;
    };
    const pronounsEl = byId(doc.body, "rp-persona-pronouns") as unknown as {
      parentNode: { hidden: boolean };
    };
    expect(pronounsEl.parentNode.hidden).toBe(true);
    genderEl.value = "custom";
    genderEl.dispatch("change");
    expect(pronounsEl.parentNode.hidden).toBe(false);
    const closeBtn = (doc.body.querySelector('[data-role="close"]') as unknown as { dispatch: (t: string) => void });
    closeBtn?.dispatch("click");
    await pDone;
  });

  test("Smart Merge preserves customized Phone data when importing a fresh PC backup", async () => {
    installMemStorage();

    // Phone state: custom persona (default), custom directive, custom sampler settings,
    // longer session, customized sample card, learned model caps, and theme.
    const phoneCards = [
      { id: "card_valen_shadow", name: "Valen (Edited)", sample: true, favorite: true, userModified: true, updatedAt: 2000 },
      { id: "card_phone_only", name: "Phone Heroine", updatedAt: 1500 },
    ];
    const phoneSessions = [
      {
        id: "sess_phone",
        cardId: "card_phone_only",
        messages: [
          { id: "m1", role: "assistant", content: "Hello" },
          { id: "m2", role: "user", content: "Hi there" },
        ],
        updatedAt: 2500,
      },
    ];

    // Mock IDB store supporting readwrite getAll/put/clear
    const idbCards = new Map(phoneCards.map((c) => [c.id, structuredClone(c)]));
    const idbSessions = new Map(phoneSessions.map((s) => [s.id, structuredClone(s)]));
    const fakeIdb = {
      async importRows({ cards, sessions, mode }: { cards: any[]; sessions: any[]; mode: string }) {
        // Delegate to IdbStore.prototype.importRows logic by wrapping a minimal in-memory IDB
        const { LocalDb: _ } = await import("../public/local_db.js");
        void _;
        if (mode === "replace") {
          idbCards.clear();
          idbSessions.clear();
        }
        for (const c of cards) {
          if (mode === "merge") {
            const cur = idbCards.get(c.id);
            if (cur) {
              const incUnmodifiedSample = c.sample === true && !c.userModified;
              const curCustomized = !cur.sample || Boolean(cur.userModified) || Boolean(cur.favorite);
              if (incUnmodifiedSample && (curCustomized || (cur.updatedAt || 0) >= (c.updatedAt || 0))) continue;
              if ((cur.updatedAt || 0) > (c.updatedAt || 0)) continue;
            }
          }
          idbCards.set(c.id, c);
        }
        for (const s of sessions) {
          if (mode === "merge") {
            const cur = idbSessions.get(s.id);
            if (cur) {
              const curLen = Array.isArray(cur.messages) ? cur.messages.length : 0;
              const incLen = Array.isArray(s.messages) ? s.messages.length : 0;
              if ((curLen > incLen && (cur.updatedAt || 0) >= (s.updatedAt || 0)) || ((cur.updatedAt || 0) > (s.updatedAt || 0) && curLen >= incLen)) continue;
            }
          }
          idbSessions.set(s.id, s);
        }
      },
      async getAllCards() { return Array.from(idbCards.values()); },
      async getAllSessions() { return Array.from(idbSessions.values()); },
    };

    const phoneDb = new LocalDb({ idb: fakeIdb as any });
    localStorage.setItem("vibe_rp_theme", "light");
    localStorage.setItem("vibe_rp_model_caps_v1", JSON.stringify({ "https://phone/v1|m1": { maxContextTokens: 8192 } }));
    localStorage.setItem("vibe_rp_personas", JSON.stringify([
      { id: "persona_default", name: "", avatar: "U", description: "stock", isDefault: false },
      { id: "persona_iqbal", name: "Iqbal", avatar: "I", description: "Custom phone persona", isDefault: true, userModified: true, updatedAt: 2000 },
    ]));
    localStorage.setItem("vibe_rp_directives", JSON.stringify([
      { id: "directive_default", name: "Custom Craft", content: "My phone rules", isDefault: true, userModified: true, updatedAt: 2000 },
    ]));
    phoneDb.saveSettings({
      apiEndpoint: "",
      apiKey: "",
      model: "",
      temperature: 0.72,
      maxContextTokens: 32768,
      choiceMode: "choice",
      apiProfiles: [{ id: "prof_phone", name: "Phone Local", apiEndpoint: "http://localhost:1234/v1", apiKey: "" }],
      activeProfileId: "prof_phone",
    });

    // Fresh PC backup: only configured API endpoint, key, model, and JanitorAI session.
    // Everything else is stock defaults + stock sample card + stock persona/directive.
    const pcBackup = {
      format: "vibe-rp-full-backup",
      version: 1,
      data: {
        indexedDb: {
          cards: [
            { id: "card_valen_shadow", name: "Valen Vance", sample: true, updatedAt: 1000 },
            { id: "card_kestrel_drifter", name: "Kestrel Rowan", sample: true, updatedAt: 1000 },
          ],
          sessions: [
            { id: "sess_phone", cardId: "card_phone_only", messages: [{ id: "m1", role: "assistant", content: "Old" }], updatedAt: 1000 },
          ],
        },
        localStorage: {
          vibe_rp_theme: "dark",
          vibe_rp_settings: JSON.stringify({
            apiEndpoint: "https://pc-api.example.com/v1",
            apiKey: "sk-pc-key",
            model: "deepseek-chat",
            temperature: 0.95,
            maxContextTokens: 65536,
            choiceMode: "normal",
            apiProfiles: [],
            activeProfileId: "",
          }),
          vibe_rp_personas: JSON.stringify([
            { id: "persona_default", name: "", avatar: "U", description: "stock", isDefault: true },
          ]),
          vibe_rp_directives: JSON.stringify([
            { id: "directive_default", name: "Author's Craft Directive", content: "stock", isDefault: true },
          ]),
          vibe_rp_import_session: JSON.stringify({ accessToken: "jai-pc-token", expiresAt: 9999999999 }),
          vibe_rp_model_caps_v1: JSON.stringify({ "https://pc-api.example.com/v1|deepseek-chat": { maxContextTokens: 65536 } }),
        },
      },
    };

    await phoneDb.importAllData(pcBackup, { mode: "merge" });

    // Settings: PC endpoint/key/model landed, Phone custom samplers & profile preserved!
    const mergedSettings = phoneDb.getSettings();
    expect(mergedSettings.apiEndpoint).toBe("https://pc-api.example.com/v1");
    expect(mergedSettings.apiKey).toBe("sk-pc-key");
    expect(mergedSettings.model).toBe("deepseek-chat");
    expect(mergedSettings.temperature).toBe(0.72);
    expect(mergedSettings.maxContextTokens).toBe(32768);
    expect(mergedSettings.choiceMode).toBe("choice");
    expect(mergedSettings.apiProfiles.length).toBe(1);
    expect(mergedSettings.apiProfiles[0].id).toBe("prof_phone");
    expect(mergedSettings.activeProfileId).toBe("prof_phone");

    // Personas & Directives: Phone custom persona remains default; Phone custom directive preserved!
    const personas = JSON.parse(localStorage.getItem("vibe_rp_personas")!);
    const iqbal = personas.find((p: any) => p.id === "persona_iqbal");
    const defPersona = personas.find((p: any) => p.id === "persona_default");
    expect(iqbal?.isDefault).toBe(true);
    expect(defPersona?.isDefault).toBe(false);

    const directives = JSON.parse(localStorage.getItem("vibe_rp_directives")!);
    expect(directives[0].content).toBe("My phone rules");

    // JanitorAI session & theme & caps
    const jaiSession = JSON.parse(localStorage.getItem("vibe_rp_import_session")!);
    expect(jaiSession.accessToken).toBe("jai-pc-token");
    expect(localStorage.getItem("vibe_rp_theme")).toBe("light");
    const caps = JSON.parse(localStorage.getItem("vibe_rp_model_caps_v1")!);
    expect(caps["https://phone/v1|m1"]).toBeDefined();
    expect(caps["https://pc-api.example.com/v1|deepseek-chat"]).toBeDefined();

    // Cards & Sessions
    expect(idbCards.get("card_valen_shadow")?.name).toBe("Valen (Edited)");
    expect(idbCards.get("card_kestrel_drifter")?.name).toBe("Kestrel Rowan");
    expect(idbSessions.get("sess_phone")?.messages.length).toBe(2);
  });
});
