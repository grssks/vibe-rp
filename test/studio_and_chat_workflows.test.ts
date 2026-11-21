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
  test("choice_panel renders .rp-choices__prose, fires onEdit, and shows Generate choices when idle & canGenerate", () => {
    const doc = setupDomWithBody();
    const mount = doc.createElement("div") as unknown as HTMLElement;
    let edited: { id?: string } | null = null;
    let retried = 0;
    const panel = createChoicePanel({
      mount,
      onSelect: () => {},
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
    const editBtn = mount.querySelector("[data-edit-choice-id]") as unknown as Parameters<typeof click>[0] | null;
    expect(editBtn).not.toBeNull();
    click(editBtn!);
    expect(edited?.id).toBe("c1");
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
    const form = modal.element.querySelector("form") as unknown as { dispatch: (t: string, ev: unknown) => void };
    (byId(modal.element, "rp-card-name") as unknown as HTMLInputElement).value = "Rowan";
    (byId(modal.element, "rp-card-description") as unknown as HTMLTextAreaElement).value = "A quiet cartographer.";
    form.dispatch("submit", { preventDefault() {} });
    await new Promise((r) => setTimeout(r, 10));
    expect(saved?.name).toBe("Rowan");
    expect(saved?.spec).toBe("chara_card_v2");
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

  test("Settings modal renders connection profiles, custom aux inputs, numeric params & data options", async () => {
    setupDomWithBody();
    installMemStorage();
    const { openSettingsModal } = await import("../public/ui/settings/settings_modal.js");
    const modal = openSettingsModal({
      getSettings: () => ({ ...TEST_SETTINGS, apiProfiles: [] }),
      saveSettings: () => {},
      listPersonas: async () => [],
      listDirectives: async () => [],
    });
    expect(byId(modal.element, "popup-profile-select")).not.toBeNull();
    expect(byId(modal.element, "popup-choice-model-input")).not.toBeNull();
    expect(byId(modal.element, "popup-summary-model-input")).not.toBeNull();
    expect(byId(modal.element, "popup-slider-temp-num")).not.toBeNull();
    expect(byId(modal.element, "rp-data-exclude-secrets")).not.toBeNull();
    expect(byId(modal.element, "rp-data-restore-mode")).not.toBeNull();
    modal.close();
  });
});
