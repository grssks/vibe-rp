import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  resolvePronouns,
  substitutePlaceholders,
  findImpersonationBoundary,
  looksLikeModelRefusal,
  resolveCardIdentity,
} from "../public/text.js";
import {
  clipLedgerToTokens,
  estimateTokens,
  resolveSummaryBudget,
  fitFoldLedgerTokens,
} from "../public/context_plan.js";
import {
  notePromptOverhead,
  sessionOverheadTokens,
  invalidateCapabilitiesCache,
  clearModelCapabilities,
} from "../public/model_capability.js";
import { BrowserChatEngine } from "../public/browser_engine.js";
import { SessionController, CHOICE_STATUS } from "../public/session_controller.js";
import { formatProse } from "../public/message_format.js";
import { parseChoices } from "../public/choice_format.js";
import { buildUsageScopeKey } from "../public/usage_history.js";
import { createComposer } from "../public/ui/chat/composer.js";
import { createTurnMachine } from "../public/ui/chat/turn_machine.js";
import { renderContextPanel, applyContextPanelStyles } from "../public/ui/chat/context_panel.js";
import { readBrowserCookies, clearBrowserCookies } from "../public/ui/data_transfer.js";
import { LocalDb } from "../public/local_db.js";
import { createLibraryController } from "../public/ui/library_controller.js";
import { decodeHtmlEntities, parsePngChara, parseWebpChara, normalizeCard } from "../public/card_parse.js";
import { parseCardUrl } from "../public/remote_import.js";
import { initTabs } from "../public/ui/tabs.js";
import { handleRequest, SECURITY_HEADERS } from "../serve.js";
import { installDom, ShimNode } from "./dom_shim.ts";
import {
  makeControllerDb,
  makeControllerEngine,
  makeControllerFake,
  resetFetch,
} from "./helpers.ts";

const ROOT = join(import.meta.dir, "..");
const origFetch = globalThis.fetch;
const origStorage = globalThis.localStorage;
const origSessionStorage = (globalThis as Record<string, unknown>).sessionStorage;
const origDoc = (globalThis as Record<string, unknown>).document;
const origWin = (globalThis as Record<string, unknown>).window;

afterEach(() => {
  resetFetch();
  globalThis.fetch = origFetch;
  if (origStorage === undefined) delete (globalThis as Record<string, unknown>).localStorage;
  else (globalThis as Record<string, unknown>).localStorage = origStorage;
  if (origSessionStorage === undefined) delete (globalThis as Record<string, unknown>).sessionStorage;
  else (globalThis as Record<string, unknown>).sessionStorage = origSessionStorage;
  if (origDoc === undefined) delete (globalThis as Record<string, unknown>).document;
  else (globalThis as Record<string, unknown>).document = origDoc;
  if (origWin === undefined) delete (globalThis as Record<string, unknown>).window;
  else (globalThis as Record<string, unknown>).window = origWin;
  clearModelCapabilities();
});

function installMockStorage(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial };
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() { return Object.keys(store).length; },
  };
  return store;
}

function buildPngWithChunks(chunks: Array<{ type: string; keyword: string; text: string }>): ArrayBuffer {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const parts: number[] = [...sig];
  const pushU32 = (n: number) => {
    parts.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  };
  const enc = new TextEncoder();
  for (const ch of chunks) {
    const kw = enc.encode(ch.keyword);
    const body = enc.encode(ch.text);
    const len = kw.length + 1 + body.length;
    pushU32(len);
    for (const c of ch.type) parts.push(c.charCodeAt(0));
    parts.push(...kw, 0, ...body);
    pushU32(0); // dummy CRC
  }
  pushU32(0);
  for (const c of "IEND") parts.push(c.charCodeAt(0));
  pushU32(0);
  return new Uint8Array(parts).buffer;
}

describe("Engine, text, context_plan & model_capability guards", () => {
  test("resolvePronouns defaults to neutral they/them instead of it", () => {
    expect(resolvePronouns({})).toEqual({
      sub: "they",
      obj: "them",
      poss: "their",
      possp: "theirs",
      ref: "themselves",
    });
    expect(resolvePronouns({ description: "The Spanish detective." }).sub).toBe("they");
    expect(resolvePronouns({ description: "Ia menunggu di stasiun." }).sub).toBe("they");
  });

  test("substitutePlaceholders preserves HTML <sub> and <ref> tags while expanding macros", () => {
    const out = substitutePlaceholders(
      "<sub>note</sub><ref>1</ref> {user} saw {{sub}} beside {{obj}}.",
      { user: "Rowan", char: "Elena", persona: { gender: "female" } },
    );
    expect(out).toBe("<sub>note</sub><ref>1</ref> Rowan saw she beside her.");
  });

  test("findImpersonationBoundary ignores hyphenated words like Player-built", () => {
    expect(findImpersonationBoundary("The Player-built fortress stood tall.", { user: "Player" })).toBe(-1);
  });

  test("looksLikeModelRefusal distinguishes in-character continuation from meta refusal", () => {
    expect(looksLikeModelRefusal("I cannot continue walking through the rain with a twisted ankle.")).toBe(false);
    expect(looksLikeModelRefusal("As an AI, I cannot generate explicit content.")).toBe(true);
  });

  test("resolveCardIdentity ignores inanimate/non-character headers and scenario titles", () => {
    const armorCard = {
      data: {
        name: "Night Patrol! Dark Watch",
        description: "### Equipment\nName: Full Plate\nName: Iron Sword\n\n**Full name**: Lyra Vance",
        scenario: "Name: Shadow Guild\nOther: No actors.",
      },
    };
    const identity = resolveCardIdentity(armorCard);
    expect(identity.displayName).toBe("Lyra Vance");
    expect(identity.isMultiCharOrRpg).toBe(false);
  });

  test("clipLedgerToTokens stays surrogate-safe on emoji and returns empty when limit <= 0", () => {
    expect(clipLedgerToTokens("hello", 0)).toBe("");
    const emojiLedger = "👩🏽‍🚀🌟 ".repeat(200);
    const clipped = clipLedgerToTokens(emojiLedger, 80);
    expect(clipped.length).toBeGreaterThan(0);
    expect(estimateTokens(clipped)).toBeLessThanOrEqual(80);
    expect(/[\uD800-\uDBFF]$/.test(clipped)).toBe(false);
  });

  test("summary budgets account for overheadTokens and resolveSafetyMargin", () => {
    const small = resolveSummaryBudget({ transcriptTokens: 2000, contextWindow: 4096, overheadTokens: 1000 });
    const clean = resolveSummaryBudget({ transcriptTokens: 2000, contextWindow: 4096, overheadTokens: 0 });
    expect(small).toBeLessThan(clean);
    const foldFit = fitFoldLedgerTokens({
      contextWindow: 4096,
      promptTokens: 500,
      overheadTokens: 400,
      transcriptTokens: 1800,
      ledgerTokens: 3000,
    });
    expect(foldFit).toBeLessThan(3000);
    expect(foldFit).toBeLessThanOrEqual(4096);
  });

  test("model_capability isolates per-model sessionOverhead and supports cache invalidation", () => {
    const session = { id: "s1", messages: [{ id: "m1", role: "user", content: "hi" }] };
    const o1 = sessionOverheadTokens({ apiEndpoint: "https://a.test/v1", model: "m1" }, session);
    const o2 = sessionOverheadTokens({ apiEndpoint: "https://a.test/v1", model: "m2" }, session);
    expect(typeof o1).toBe("number");
    expect(typeof o2).toBe("number");

    const store = installMockStorage();
    notePromptOverhead("https://a.test/v1", "m1", 2000, 1200);
    expect(JSON.parse(store["vibe_rp_model_caps"])["https://a.test/v1::m1"].promptOverheadTokens).toBe(800);
    delete store["vibe_rp_model_caps"];
    invalidateCapabilitiesCache();
    expect(sessionOverheadTokens({ apiEndpoint: "https://a.test/v1", model: "m1" }, session)).toBe(o1);
  });

  test("Engine streams multi-line SSE data and learns comma/llama/Gemini context windows", async () => {
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) {
        return new Response(
          JSON.stringify({
            error: { message: "Input token count exceeds the maximum number of tokens allowed (12,800) by this model." },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      const multiLineSse = [
        'data: {"choices":',
        'data: [{"delta":{"content":"Hi "}}]}',
        "",
        'data: {"choices":[{"delta":{"content":"there"}}]}',
        "",
        "data: [DONE]",
        "",
      ].join("\n");
      return new Response(multiLineSse, { headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const card = { id: "c1", data: { name: "Elena", description: "Scout." } };
    const session = { id: "s1", messages: [{ id: "m1", role: "user", content: "Hello" }], consumed: 0 };
    const notices: string[] = [];
    const text = await BrowserChatEngine.streamTurn({
      card,
      session,
      settings: { apiEndpoint: "https://x.test/v1", model: "gemini-like", maxContextTokens: 65536, maxTokens: 512 },
      persona: { name: "Rowan" },
      onNotice: (n: string) => notices.push(n),
    });
    expect(text).toBe("Hi there");
    expect(call).toBe(2);
    expect(notices.some((n) => n.includes("12,800") || n.includes("12800"))).toBe(true);
  });
});

describe("Controller, Choice Format, Prose, Usage Scope & Turn/Composer guards", () => {
  test("SessionController handles loadCard, no-op edit, reroll rollback, restoreChoices abort, and sync selectChoice", async () => {
    const cards = [
      { id: "c1", name: "Elena", data: { name: "Elena", first_mes: "Hi." } },
    ];
    let failTurn = false;
    let choiceSignal: AbortSignal | undefined;
    let rejectSave = false;
    const db = makeControllerDb({ cards });
    const origSave = db.saveSession;
    db.saveSession = async (s: unknown) => {
      if (rejectSave) throw new Error("quota");
      return origSave(s);
    };
    const engine = {
      ...makeControllerEngine({}),
      async streamTurn(args: { onChunk: (c: string) => void }) {
        if (failTurn) throw new Error("boom");
        args.onChunk("Reply A");
        return "Reply A";
      },
      async generateChoices(args: { signal?: AbortSignal }) {
        choiceSignal = args.signal;
        return new Promise((_res, rej) => {
          args.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            rej(err);
          });
        });
      },
    };
    const { ctl } = await makeControllerFake(
      SessionController as unknown as new (deps: { db: unknown; engine: unknown }) => { init: (c: string, s: null) => Promise<void> },
      { db, engine },
    );

    const s1 = await ctl.createSession({ title: "A" });
    const s2 = await ctl.createSession({ title: "B" });
    expect(s1.id).not.toBe(s2.id);

    cards[0].data.name = "Elena II";
    await ctl.loadCard("c1");
    expect(ctl.activeCard.data.name).toBe("Elena II");

    const u = ctl.appendMessage({ role: "user", content: "knock" });
    const unchanged = ctl.editMessage(u.id, "knock");
    expect(unchanged).toBe(u);
    expect(u.forks).toBeUndefined();

    await ctl.streamResponse();
    const replyA = ctl.messages.at(-1);
    expect(replyA.content).toBe("Reply A");

    failTurn = true;
    const prompt = ctl.reroll();
    expect(prompt).toBe("knock");
    await expect(ctl.streamResponse(undefined, undefined, { persistPending: false })).rejects.toThrow("boom");
    expect(ctl.messages.at(-1)).toBe(replyA);

    const inflight = ctl.requestChoices();
    ctl.restoreChoices();
    expect(choiceSignal?.aborted).toBe(true);
    await inflight;

    ctl.activeSession.choiceSet = {
      id: "cs1",
      sourceId: replyA.id,
      sourceSig: `${replyA.id}:${replyA.content.length}:0`,
      choices: [{ id: "c1", text: "Wave." }],
    };
    ctl.restoreChoices();
    expect(ctl.choiceState.status).toBe(CHOICE_STATUS.READY);
    rejectSave = true;
    const claimed = ctl.selectChoice("c1");
    expect(claimed).toEqual({ id: "c1", text: "Wave." });
  });

  test("formatProse keeps em-dashes, snake_case underscores, paragraph boundaries, and headings", () => {
    expect(formatProse("wait — what -- now")).toBe("<p>wait — what -- now</p>");
    expect(formatProse("snake_case_identifier")).toBe("<p>snake_case_identifier</p>");
    expect(formatProse("**one\n\ntwo**")).toBe("<p>**one</p><p>two**</p>");
    expect(formatProse("# Heading\nBody line")).toBe('<h1 class="prose-h1">Heading</h1><p>Body line</p>');
  });

  test("parseChoices preserves comment tokens inside strings and reads detail/title aliases", () => {
    const withUrl = '[{"label":"Go","detail":"Visit https://example.com/a//b /*safe*/ now"}]';
    const parsed = parseChoices(withUrl);
    expect(parsed.choices.length).toBe(1);
    expect(parsed.choices[0].text).toContain("https://example.com/a//b /*safe*/");
  });

  test("buildUsageScopeKey tracks example_dialogs, lorebook, gender, effort, and context window", () => {
    const base = {
      card: { id: "c1", data: { name: "E", mes_example: "ex1", character_book: { entries: [{ keys: ["a"], content: "b" }] } } },
      persona: { id: "p1", name: "R", gender: "neutral" },
      directive: { id: "d1", content: "rules" },
      settings: { apiEndpoint: "https://a.test/v1", model: "m", reasoningEffort: "low", maxContextTokens: 8192 },
    };
    const k0 = buildUsageScopeKey(base);
    expect(buildUsageScopeKey({ ...base, settings: { ...base.settings, reasoningEffort: "high" } })).not.toBe(k0);
    expect(buildUsageScopeKey({ ...base, settings: { ...base.settings, maxContextTokens: 16384 } })).not.toBe(k0);
    expect(buildUsageScopeKey({ ...base, persona: { ...base.persona, gender: "female" } })).not.toBe(k0);
    expect(buildUsageScopeKey({ ...base, card: { id: "c1", data: { ...base.card.data, mes_example: "ex2" } } })).not.toBe(k0);
  });

  test("composer skips composing Enter and preserves input edited after send; turn_machine retry guards session", async () => {
    const sent: string[] = [];
    const listeners: Record<string, Array<(e: unknown) => void>> = {};
    const input = {
      value: "first",
      style: {} as Record<string, string>,
      scrollHeight: 30,
      addEventListener: (t: string, fn: (e: unknown) => void) => { (listeners[t] ||= []).push(fn); },
      dispatch: (t: string, ev: unknown) => { for (const fn of listeners[t] || []) fn(ev); },
    };
    const sendButton = { disabled: false, setAttribute() {}, addEventListener() {} };
    const composer = createComposer({
      input: input as unknown as HTMLTextAreaElement,
      sendButton: sendButton as unknown as HTMLButtonElement,
      matchFinePointer: () => true,
      onSend: (t: string) => sent.push(t),
    });

    input.dispatch("keydown", { key: "Enter", isComposing: true, preventDefault() {} });
    expect(sent).toEqual([]);

    composer.send();
    input.value = "first";
    input.dispatch("input", {});
    composer.clearIfMatched("first");
    expect(input.value).toBe("first");

    const toasts: Array<{ onAction?: (() => void) | null }> = [];
    const ctl = {
      activeSession: { id: "s1" },
      calls: [] as string[],
      appendMessage: () => ({ id: "u1" }),
      pendingUserTurn: () => {
        ctl.calls.push("retry");
        return { content: "hi" };
      },
      async streamResponse() {
        if (ctl.calls.length === 0) throw new Error("HTTP 500");
        return { id: "a1", content: "ok" };
      },
    };
    const feed = { beginStream: () => ({ id: "x" }), appendChunk() {}, settleStream() {}, failStream() {} };
    const machine = createTurnMachine({
      controller: ctl,
      composer: { busy: false, setBusy() {}, clearIfMatched() {}, focus() {} },
      feed,
      notifier: { toast: (_m: string, o: { onAction?: (() => void) | null }) => toasts.push(o), setStatus() {} },
    });
    await machine.submitTurn("hi");
    expect(toasts.length).toBe(1);
    ctl.activeSession.id = "s2";
    toasts[0].onAction?.();
    expect(ctl.calls).toEqual([]);
  });
});

describe("Storage, Cookie Namespace, Import, Card Parse & Tabs guards", () => {
  test("cookie helpers only read and clear vibe_rp_ cookies", () => {
    const writes: string[] = [];
    (globalThis as Record<string, unknown>).document = {
      get cookie() { return "other=1; vibe_rp_keep=yes; csrftoken=secret"; },
      set cookie(v: string) { writes.push(v); },
    };
    expect(readBrowserCookies()).toEqual([{ name: "vibe_rp_keep", value: "yes" }]);
    clearBrowserCookies();
    expect(writes.length).toBe(1);
    expect(writes[0]).toContain("vibe_rp_keep=");
  });

  test("LocalDb validates preset arrays on restore, promotes default on delete, and cleans sessionStorage on wipe", async () => {
    const store = installMockStorage();
    const ss: Record<string, string> = { vibe_rp_import_session: "tok", unrelated: "keep" };
    (globalThis as Record<string, unknown>).sessionStorage = {
      getItem: (k: string) => ss[k] ?? null,
      setItem: (k: string, v: string) => { ss[k] = v; },
      removeItem: (k: string) => { delete ss[k]; },
      key: (i: number) => Object.keys(ss)[i] ?? null,
      get length() { return Object.keys(ss).length; },
    };

    const p2 = await LocalDb.savePersona({ name: "Backup", isDefault: false });
    await LocalDb.deletePersona("persona_default");
    const listAfterDelete = await LocalDb.getAllPersonas();
    expect(listAfterDelete.some((p: { id: string; isDefault?: boolean }) => p.id === p2.id && p.isDefault)).toBe(true);

    const db = new LocalDb({
      idb: {
        importRows: async () => {},
        clearAllCards: async () => {},
      } as never,
    });
    const resBad = await db.importAllData({
      format: "vibe-rp-full-backup",
      version: 1,
      data: {
        indexedDb: { cards: [{ id: "" }, { id: "c_ok", data: { name: "Ok" } }], sessions: [{ id: "s_ok" }, null] },
        localStorage: { vibe_rp_personas: '{"not":"array"}', vibe_rp_directives: "[123]" },
      },
    });
    expect(resBad.cardsImported).toBe(1);
    expect(resBad.sessionsImported).toBe(1);
    expect(resBad.localStorageKeysImported).toBe(0);

    await db.wipeAllData();
    expect(ss["vibe_rp_import_session"]).toBeUndefined();
    expect(ss["unrelated"]).toBe("keep");
    expect(store["vibe_rp_settings"]).toBeUndefined();
  });

  test("library_controller assigns fresh non-colliding ID on Add as a separate preset", async () => {
    const cards = [{ id: "card_1", data: { name: "Elena" } }];
    const saved: Array<{ id?: string }> = [];
    const ctl = createLibraryController({
      db: {
        getAllCards: async () => cards,
        getAllSessions: async () => [],
        saveCard: async (c: { id?: string }) => { saved.push(c); cards.push(c as never); },
      },
      now: () => 5000,
    });
    await ctl.refresh();
    const added = await ctl.importCard(
      { id: "card_1", data: { name: "Elena", first_mes: "Different" } },
      { onDuplicate: async () => "add" },
    );
    expect(added?.id).toBeTruthy();
    expect(added?.id).not.toBe("card_1");
  });

  test("card_parse rejects NUL/surrogate entities, prefers ccv3 in PNG, validates WEBP, and cleans group greetings", async () => {
    expect(decodeHtmlEntities("&#0;&#xD800;&#65;")).toBe("&#0;&#xD800;A");
    const png = buildPngWithChunks([
      { type: "tEXt", keyword: "chara", text: JSON.stringify({ name: "Old" }) },
      { type: "tEXt", keyword: "ccv3", text: JSON.stringify({ name: "V3" }) },
    ]);
    const parsedPng = await parsePngChara(png);
    expect(parsedPng.name).toBe("V3");

    const fakeWebp = new Uint8Array(24);
    fakeWebp.set([0x52, 0x49, 0x46, 0x46, 16, 0, 0, 0, 0x41, 0x56, 0x49, 0x20], 0);
    expect(parseWebpChara(fakeWebp.buffer)).toBeNull();

    const norm = normalizeCard({ name: "E", group_only_greetings: ["<b>Hello</b>"] });
    expect(norm.data.group_only_greetings[0]).toBe("**Hello**");
  });

  test("remote_import rejects non-http(s) URLs and falls back when content-type image/png actually holds JSON", async () => {
    await expect(parseCardUrl("javascript:alert(1)", null)).rejects.toThrow(/http/i);

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ name: "Mislabelled", first_mes: "Hi" }), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      })) as unknown as typeof fetch;
    const card = await parseCardUrl("https://example.test/card.json", null);
    expect(card.data.name).toBe("Mislabelled");
  });

  test("tabs manual mode moves focus on Arrow without mutating activeTab until Enter", () => {
    const doc = installDom();
    const tablist = new ShimNode("div");
    const t1 = new ShimNode("button");
    (t1 as unknown as { id: string }).id = "t1";
    t1.attributes.id = "t1";
    t1.attributes.class = "rp-tab";
    t1.setAttribute("aria-selected", "true");
    t1.setAttribute("aria-controls", "p1");
    const t2 = new ShimNode("button");
    (t2 as unknown as { id: string }).id = "t2";
    t2.attributes.id = "t2";
    t2.attributes.class = "rp-tab";
    t2.setAttribute("aria-controls", "p2");
    tablist.append(t1, t2);
    const p1 = new ShimNode("div");
    (p1 as unknown as { id: string }).id = "p1";
    p1.attributes.id = "p1";
    const p2 = new ShimNode("div");
    (p2 as unknown as { id: string }).id = "p2";
    p2.attributes.id = "p2";
    doc.append(tablist, p1, p2);
    (doc as unknown as { getElementById: (id: string) => ShimNode | null }).getElementById = (id: string) =>
      ({ p1, p2 }[id] ?? null);

    const api = initTabs(tablist as unknown as HTMLElement, { activation: "manual" });
    tablist.dispatch("keydown", { key: "ArrowRight", target: t1 });
    expect(api.activeTab()).toBe(t1 as unknown as HTMLElement);
    expect(t2.focused).toBe(true);
    tablist.dispatch("keydown", { key: "Enter", target: t2 });
    expect(api.activeTab()).toBe(t2 as unknown as HTMLElement);
  });
});

describe("CSP, Context Panel CSSOM, Service Worker & Server Parity guards", () => {
  test("context_panel emits data-* attributes with zero style= and applyContextPanelStyles sets CSSOM values", () => {
    const req = BrowserChatEngine.describeRequest({
      card: { id: "c1", data: { name: "Elena", description: "Scout." } },
      session: { id: "s1", messages: [{ id: "m1", role: "user", content: "Hi" }], ledger: "", consumed: 1 },
      settings: { apiEndpoint: "https://x.test/v1", model: "m", maxContextTokens: 8192, maxTokens: 512 },
      persona: { name: "Rowan" },
    });
    const html = renderContextPanel({
      request: req,
      usage: { reported: true, billedInput: 500, cachedTokens: 250, estimatedInput: 480 },
      samples: [{ at: 1, scope: "k", billed: 500, cached: 250, estimated: 480, folded: false }],
      scope: "k",
    });
    expect(html).not.toContain("style=");
    expect(html).toContain("data-bars=");
    expect(html).toContain("data-h=");
    expect(html).toContain("data-pct=");

    const cssVars: Record<string, string> = {};
    const trendEl = { dataset: { bars: "1" }, style: { setProperty: (k: string, v: string) => { cssVars[k] = v; } } };
    const barEl = { dataset: { h: "0.500" }, style: { setProperty: (k: string, v: string) => { cssVars[k] = v; } } };
    const meterEl = { dataset: { pct: "12" }, style: { width: "" } };
    const fakeContainer = {
      querySelector: (s: string) => (s.includes("data-bars") ? trendEl : s.includes("data-pct") ? meterEl : null),
      querySelectorAll: () => [barEl],
    };
    applyContextPanelStyles(fakeContainer as unknown as HTMLElement);
    expect(cssVars["--bars"]).toBe("1");
    expect(cssVars["--h"]).toBe("0.500");
    expect(meterEl.style.width).toBe("12%");
  });

  test("sw.js bumps cache to v27+ and aborts partial crawls instead of publishing", () => {
    const sw = readFileSync(join(ROOT, "public", "sw.js"), "utf8");
    const ver = Number(sw.match(/const CACHE = "vibe-rp-shell-v(\d+)"/)?.[1] || 0);
    expect(ver).toBeGreaterThanOrEqual(27);
    expect(sw).toMatch(/if\s*\(failed\.length\)\s*\{[\s\S]*?return null;/);
  });

  test("serve.js enforces 405, directory 404, trailing-slash 302, no-cache on HTML/sw.js, COOP, and style-src 'self'", async () => {
    const postRes = await handleRequest(new Request("http://127.0.0.1:3000/", { method: "POST" }));
    expect(postRes.status).toBe(405);
    expect(postRes.headers.get("Allow")).toBe("GET, HEAD");

    const dirRes = await handleRequest(new Request("http://127.0.0.1:3000/ui"));
    expect(dirRes.status).toBe(404);

    const redirRes = await handleRequest(new Request("http://127.0.0.1:3000/settings/"));
    expect(redirRes.status).toBe(302);
    expect(redirRes.headers.get("Location")).toBe("/?openSettings=1");

    const rootRes = await handleRequest(new Request("http://127.0.0.1:3000/"));
    expect(rootRes.status).toBe(200);
    expect(rootRes.headers.get("Cache-Control")).toBe("no-cache");
    expect(rootRes.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(SECURITY_HEADERS["Content-Security-Policy"]).toContain("style-src 'self';");

    const swRes = await handleRequest(new Request("http://127.0.0.1:3000/sw.js"));
    expect(swRes.status).toBe(200);
    expect(swRes.headers.get("Cache-Control")).toBe("no-cache");
  });
});
