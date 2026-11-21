// Engine decomposition, prompt token budgets, tokenizer calibration, and adaptive prose contracts.

import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BrowserChatEngine,
  allocateContext,
  estimateTokens,
  promptTokenRatio,
  sessionTokenRatio,
  promptOverheadTokens,
  shouldUseJsonResponseFormat,
  promptCacheKeyFor,
  notePromptOverhead,
  clearModelCapabilities,
  buildSystemSections,
} from "../public/browser_engine.js";
import {
  SUMMARY_SYSTEM_PROMPT,
  SUMMARY_PROMPT,
  SUMMARY_UPDATE_PROMPT,
  LEDGER_COMPRESS_PROMPT,
} from "../public/ledger_manager.js";
import {
  DEFAULT_AGENTS_CONTRACT,
  COMPACT_AGENTS_CONTRACT,
} from "../public/local_db.js";
import { CHOICE_SYSTEM_PROMPT } from "../public/choice_format.js";
import {
  isLikelyEnglish,
  detectLanguageProfile,
  countCrossTurnNgramEchoes,
  analyzeTurnState,
  buildSceneGuidance,
} from "../public/prompt_adaptive.js";
import { SessionController } from "../public/session_controller.js";
import { renderContextPanel } from "../public/ui/chat/context_panel.js";
import { openInlineEdit, closeActiveInlineEdit } from "../public/ui/chat/inline_editor.js";
import { createHistoryModal } from "../public/ui/chat/history_modal.js";
import { structuralViolations } from "../tools/prompt_eval.mjs";
import {
  words,
  elenaCard,
  TEST_SETTINGS,
  jsonResponse,
  resetFetch,
  makeControllerDb,
  makeControllerEngine,
  makeControllerFake,
} from "./helpers.ts";
import { installDom, click, ShimNode } from "./dom_shim.ts";

const ROOT = join(import.meta.dir, "..");

const ORIG_DOC = (globalThis as Record<string, unknown>).document;
const ORIG_WIN = (globalThis as Record<string, unknown>).window;

function restoreGlobals() {
  resetFetch();
  if (ORIG_DOC === undefined) delete (globalThis as Record<string, unknown>).document;
  else (globalThis as Record<string, unknown>).document = ORIG_DOC;
  if (ORIG_WIN === undefined) delete (globalThis as Record<string, unknown>).window;
  else (globalThis as Record<string, unknown>).window = ORIG_WIN;
}

afterEach(restoreGlobals);

describe("Engine decomposition & DOM-free boundaries", () => {
  test("all four engine modules stay free of DOM globals", () => {
    const files = [
      "public/browser_engine.js",
      "public/prompt_builder.js",
      "public/llm_transport.js",
      "public/ledger_manager.js",
      "public/session_controller.js",
    ];
    for (const rel of files) {
      const raw = readFileSync(join(ROOT, rel), "utf8");
      const codeOnly = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(codeOnly).not.toMatch(/\bdocument(?:\.[A-Za-z_$]|\[)|\bwindow(?:\.[A-Za-z_$]|\[)|\bglobalThis\.(?:document|window)\b/);
    }
  });

  test("facade re-exports unified allocator/capability helpers and preserves the 12 public statics", () => {
    expect(typeof allocateContext).toBe("function");
    expect(typeof promptTokenRatio).toBe("function");
    expect(typeof sessionTokenRatio).toBe("function");
    expect(typeof shouldUseJsonResponseFormat).toBe("function");
    expect(typeof promptCacheKeyFor).toBe("function");

    const statics = Object.getOwnPropertyNames(BrowserChatEngine)
      .filter((k) => !["length", "name", "prototype"].includes(k))
      .sort();
    expect(statics).toEqual([
      "assembleMessages",
      "buildRequestBody",
      "describeRequest",
      "describeUsage",
      "fetchAvailableModels",
      "formatSystemPrompt",
      "generateChoices",
      "planChoiceRequest",
      "planContext",
      "planRequest",
      "resolveBudgets",
      "streamTurn",
    ]);
  });
});

describe("Prompt compression & compact contract tier", () => {
  test("authored prompts fit within target token budgets", () => {
    expect(estimateTokens(DEFAULT_AGENTS_CONTRACT)).toBeLessThanOrEqual(760);
    expect(estimateTokens(COMPACT_AGENTS_CONTRACT)).toBeLessThanOrEqual(280);
    expect(estimateTokens(CHOICE_SYSTEM_PROMPT)).toBeLessThanOrEqual(500);
    const compactionTotal =
      estimateTokens(SUMMARY_SYSTEM_PROMPT) +
      estimateTokens(SUMMARY_PROMPT) +
      estimateTokens(SUMMARY_UPDATE_PROMPT) +
      estimateTokens(LEDGER_COMPRESS_PROMPT);
    expect(compactionTotal).toBeLessThanOrEqual(760);
  });

  test("tight windows (<= 4096) auto-select COMPACT_AGENTS_CONTRACT for default directive only", () => {
    const card = elenaCard(40);
    const session = {
      id: "s1",
      ledger: "",
      consumed: 1,
      messages: [
        { role: "assistant", content: "She studies the cracked map." },
        { role: "user", content: "What did you find on the coast?" },
      ],
    };

    const plan2048 = BrowserChatEngine.planRequest({
      card,
      session,
      settings: { ...TEST_SETTINGS, agentsContract: DEFAULT_AGENTS_CONTRACT },
      persona: null,
      window: 2048,
    });
    expect(plan2048.contractTokens).toBeLessThanOrEqual(260);
    expect(plan2048.impossible).toBe(false);

    const plan4096 = BrowserChatEngine.planRequest({
      card,
      session,
      settings: { ...TEST_SETTINGS, agentsContract: DEFAULT_AGENTS_CONTRACT },
      persona: null,
      window: 4096,
    });
    expect(plan4096.contractTokens).toBeLessThanOrEqual(260);

    const custom = "Custom author directive — keep scene terse and direct.";
    const custom4096 = BrowserChatEngine.planRequest({
      card,
      session,
      settings: { ...TEST_SETTINGS, agentsContract: custom },
      persona: null,
      window: 4096,
    });
    expect(custom4096.systemPrompt).toContain(custom);
    expect(custom4096.systemPrompt).not.toContain(COMPACT_AGENTS_CONTRACT);
  });

  test("cardReading is omitted when mes_example is absent or dropped under pressure", () => {
    const withoutExamples = elenaCard(60);
    const secsEmpty = buildSystemSections(withoutExamples, null, {
      ...TEST_SETTINGS,
      agentsContract: DEFAULT_AGENTS_CONTRACT,
      maxContextTokens: 8192,
    });
    expect(secsEmpty.some((s: { id: string }) => s.id === "cardReading")).toBe(false);

    const withLargeExamples = elenaCard(80, { mes_example: words(1800) });
    const secsWith = buildSystemSections(withLargeExamples, null, {
      ...TEST_SETTINGS,
      agentsContract: DEFAULT_AGENTS_CONTRACT,
      maxContextTokens: 8192,
    });
    expect(secsWith.some((s: { id: string }) => s.id === "cardReading")).toBe(true);

    const tightPlan = BrowserChatEngine.planRequest({
      card: withLargeExamples,
      session: {
        id: "s1",
        ledger: "",
        consumed: 1,
        messages: [
          { role: "assistant", content: "Hello." },
          { role: "user", content: "Respond." },
        ],
      },
      settings: { ...TEST_SETTINGS, agentsContract: DEFAULT_AGENTS_CONTRACT },
      persona: null,
      window: 2048,
    });
    expect(tightPlan.includedSections).not.toContain("examples");
    expect(tightPlan.includedSections).not.toContain("cardReading");
  });
});

describe("Separate choiceModel routing & response_format learning", () => {
  test("choiceModel distinct from main model forces compact choice request (sharedPrefix: false)", () => {
    const card = elenaCard(40);
    const session = {
      id: "s_choice",
      ledger: "",
      consumed: 1,
      messages: [{ role: "assistant", content: "The lamp flickers over the ledger." }],
    };

    const separate = BrowserChatEngine.planChoiceRequest({
      card,
      session,
      settings: { ...TEST_SETTINGS, model: "main-70b", choiceModel: "mini-choice", maxContextTokens: 16384 },
      persona: null,
    });
    expect(separate.sharedPrefix).toBe(false);

    const shared = BrowserChatEngine.planChoiceRequest({
      card,
      session,
      settings: { ...TEST_SETTINGS, model: "main-70b", choiceModel: "main-70b", maxContextTokens: 16384 },
      persona: null,
    });
    expect(shared.sharedPrefix).toBe(true);
  });

  test("generateChoices sends response_format json_object and learns to drop it on HTTP 400 rejection", async () => {
    clearModelCapabilities();
    const bodies: Array<Record<string, unknown>> = [];
    let attempt = 0;
    globalThis.fetch = (async (_url: string | URL | Request, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      bodies.push(body);
      attempt += 1;
      if (attempt === 1) {
        return new Response(JSON.stringify({ error: { message: "Unsupported parameter: response_format" } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                choices: ["Inspect the desk.", "Ask Elena directly.", "Step outside."],
              }),
            },
            finish_reason: "stop",
          },
        ],
      });
    }) as unknown as typeof fetch;

    const settings = { ...TEST_SETTINGS, maxContextTokens: 8192 };
    expect(shouldUseJsonResponseFormat(settings)).toBe(true);

    const result = await BrowserChatEngine.generateChoices({
      card: elenaCard(20),
      session: {
        id: "s_rf",
        ledger: "",
        consumed: 1,
        messages: [{ role: "assistant", content: "She waits by the door." }],
      },
      settings,
      persona: null,
      count: 3,
    });

    expect(bodies.length).toBe(2);
    expect(bodies[0].response_format).toEqual({ type: "json_object" });
    expect("response_format" in bodies[1]).toBe(false);
    expect(result.choices.length).toBe(3);
    expect(shouldUseJsonResponseFormat(settings)).toBe(false);
  });
});

describe("Cross-lingual & narration-only prose heuristics", () => {
  test("language detection handles short English phrases, diacritics, CJK, and asymmetric cross-lingual precedence", () => {
    expect(isLikelyEnglish("I step back cleanly.")).toBe(true);
    expect(isLikelyEnglish("Saya melangkah mundur.")).toBe(false);

    expect(detectLanguageProfile("The wind crossed the harbor cleanly.")).toBe("latin-en");
    expect(detectLanguageProfile("—Era necesario —respondí sin vacilar.")).toBe("latin-non-en");
    expect(detectLanguageProfile("Dia membuka pintu kayu itu dengan hati-hati.")).toBe("latin-non-en");
    expect(detectLanguageProfile("彼女は静かに窓の外を見つめた。")).toBe("cjk");
    expect(detectLanguageProfile("Он медленно открыл тяжёлую дверь.")).toBe("cyrillic");

    const enUserIdCard = analyzeTurnState({
      messages: [
        { role: "assistant", content: "She studies the quiet harbor from the archive window." },
        { role: "user", content: "I sit down across from her and open the ledger." },
      ],
      charName: "Sari",
      playerName: "Rowan",
      cardText: "Sari adalah seorang arsiparis yang sangat teliti dan tenang.",
      personaText: "Rowan is a quiet traveler carrying only a worn compass.",
    });
    expect(enUserIdCard.crossLingual).toBe(false);

    const idUserJaCard = analyzeTurnState({
      messages: [
        { role: "assistant", content: "彼女は静かに振り返り、冷たい声で尋ねた。" },
        { role: "user", content: "Aku menutup pintu dan meletakkan lentera di atas meja." },
      ],
      charName: "Ren",
      playerName: "Adi",
      cardText: "蓮は古い図書館を守る寡黙な番人である。",
      personaText: "Adi adalah seorang kurir yang baru tiba dari pelabuhan selatan.",
    });
    expect(idUserJaCard.crossLingual).toBe(true);
    const guidance = buildSceneGuidance(idUserJaCard, { maxTokens: 320 });
    expect(guidance.notes).toContain("languageShift");
  });

  test("narration-only stripping, streaks, stub-reply guard, CJK/overlapping n-grams, cast boundaries, and keep priority", () => {
    const quotedOnly = [
      { role: "assistant", content: '"We never leave before midnight arrives," he whispered. She waited.' },
      { role: "assistant", content: '"We never leave before midnight arrives," she added. Calm settled.' },
      { role: "assistant", content: '"We never leave before midnight arrives," he repeated. Dawn broke.' },
    ];
    const quotedSignals = analyzeTurnState({ messages: quotedOnly, charName: "A", playerName: "B" });
    expect(quotedSignals.slopHits).toBe(0);

    const singleQuestion = analyzeTurnState({
      messages: [
        { role: "assistant", content: "She closes the shutter." },
        { role: "assistant", content: "What happens next?" },
      ],
      charName: "A",
      playerName: "B",
    });
    expect(singleQuestion.tics.some((t: { id: string }) => t.id === "askedThePlayer")).toBe(false);

    const tripleQuestion = analyzeTurnState({
      messages: [
        { role: "assistant", content: "Will you answer?" },
        { role: "assistant", content: "Or step back?" },
        { role: "assistant", content: "What do you choose?" },
      ],
      charName: "A",
      playerName: "B",
    });
    expect(tripleQuestion.tics.some((t: { id: string }) => t.id === "askedThePlayer")).toBe(true);

    const parallelPara = `${words(15)}\n\n${words(15)}\n\n${words(15)}`;
    const uniform = analyzeTurnState({
      messages: [
        { role: "assistant", content: parallelPara },
        { role: "assistant", content: parallelPara },
      ],
      charName: "A",
      playerName: "B",
    });
    expect(uniform.tics.some((t: { id: string }) => t.id === "uniformBlocks")).toBe(true);

    const stubTurns = analyzeTurnState({
      messages: [
        { role: "user", content: words(60) },
        { role: "assistant", content: `She adjusts the heavy bronze lantern along the wet stone sill and watches the outer gate carefully tonight. ${words(8)}` },
        { role: "user", content: words(60) },
        { role: "assistant", content: `Nothing changes near the dockside warehouse while the late bell finishes ringing across the empty harbor square. ${words(8)}` },
        { role: "assistant", content: `She closes the brass compass calmly and waits beside the rain-darkened balustrade without adding a single word. ${words(8)}` },
        { role: "user", content: "Okay." },
      ],
      charName: "A",
      playerName: "B",
    });
    expect(stubTurns.tics.some((t: { id: string }) => t.id === "shrank")).toBe(false);

    const trueShrink = analyzeTurnState({
      messages: [
        { role: "user", content: words(60) },
        { role: "assistant", content: `She walks along the pier. ${words(40)}` },
        { role: "assistant", content: "She nods once." },
        { role: "assistant", content: "Rain falls softly." },
        { role: "user", content: words(60) },
      ],
      charName: "A",
      playerName: "B",
    });
    expect(trueShrink.tics.some((t: { id: string }) => t.id === "shrank")).toBe(true);

    const openingHit = analyzeTurnState({
      messages: [
        { role: "assistant", content: "She stepped back toward the salt-flat watchtower." },
        { role: "assistant", content: "She stepped closer to the brass lantern." },
        { role: "assistant", content: "She stepped aside as the door swung wide." },
      ],
      charName: "A",
      playerName: "B",
    });
    expect(openingHit.tics.some((t: { id: string }) => t.id === "openingRepeat")).toBe(true);

    const castCheck = analyzeTurnState({
      messages: [{ role: "assistant", content: "Analia speaks to Kaizen near the lantern." }],
      charName: "Elena Voss",
      playerName: "Rowan",
      castNames: ["Ana", "Kai"],
    });
    expect(castCheck.absentCast).toEqual(["Ana", "Kai"]);

    const mainExcluded = BrowserChatEngine.planRequest({
      card: {
        data: {
          name: "Elena Voss",
          description: "Surveyor.",
          personality: "",
          scenario: "",
          mes_example: "",
          system_prompt: "",
          post_history_instructions: "",
          extensions: { group: { members: [{ name: "Elena Voss" }, { name: "Mara" }] } },
        },
      },
      session: {
        id: "s_cast",
        ledger: "",
        consumed: 1,
        messages: [
          { role: "assistant", content: "She opens the shutter." },
          { role: "user", content: "Look out." },
        ],
      },
      settings: TEST_SETTINGS,
      persona: null,
      window: 8192,
    });
    expect(mainExcluded.adaptiveNotes).not.toContain("silentCast");

    expect(
      countCrossTurnNgramEchoes([
        "She walked across the shadowed courtyard toward the gate.",
        "He paused across the shadowed courtyard before speaking.",
        "Rain fell across the shadowed courtyard until dawn.",
      ])
    ).toBe(2);

    const jaClause = "静かな夜風が古い石畳の上を吹き抜けていく";
    expect(countCrossTurnNgramEchoes([`${jaClause}。`, `${jaClause}。`, `${jaClause}。`])).toBeGreaterThanOrEqual(2);

    const tight = buildSceneGuidance(
      {
        charName: "Elena Voss",
        playerName: "Rowan",
        assistantTurns: 8,
        folded: false,
        narration: { pov: "third", tense: "past" },
        tics: [{ id: "contrast", priority: 70, keep: 88, note: 'State the true thing once. The last replies leaned on "not X, but Y".' }],
        absentCast: ["Mara", "Tomas"],
        slopHits: 4,
      },
      { maxTokens: 115, identity: "guarded surveyor" }
    );
    expect(tight.notes).toContain("scope");
    expect(tight.notes).toContain("contrast");
    expect(tight.notes).not.toContain("reinject");
    expect(tight.notes).not.toContain("lock");
  });
});

describe("Tokenizer-ratio & fixed-overhead separation", () => {
  test("notePromptOverhead separates slope ratio from fixed preamble and planRequest applies it", () => {
    clearModelCapabilities();
    const endpoint = "https://ratio.test/v1";
    const model = "multilingual-tok";

    // Single sample keeps ratio = 1 and attributes delta as fixed preamble.
    notePromptOverhead(endpoint, model, 2300, 2000);
    expect(promptTokenRatio({ apiEndpoint: endpoint, model })).toBe(1);
    expect(promptOverheadTokens({ apiEndpoint: endpoint, model })).toBe(300);

    // Varying sizes with exact linear relation billed = round(1.5 * sent + 1500).
    clearModelCapabilities();
    notePromptOverhead(endpoint, model, 3000, 1000);
    notePromptOverhead(endpoint, model, 4500, 2000);
    notePromptOverhead(endpoint, model, 6000, 3000);

    const ratio = promptTokenRatio({ apiEndpoint: endpoint, model });
    const overhead = promptOverheadTokens({ apiEndpoint: endpoint, model });
    expect(ratio).toBeGreaterThanOrEqual(1.45);
    expect(ratio).toBeLessThanOrEqual(1.55);
    expect(overhead).toBeGreaterThanOrEqual(1400);
    expect(overhead).toBeLessThanOrEqual(1600);

    const plan = BrowserChatEngine.planRequest({
      card: elenaCard(30),
      session: {
        id: "s_ratio",
        ledger: "",
        consumed: 1,
        messages: [
          { role: "assistant", content: "Hello there." },
          { role: "user", content: "Tell me more." },
        ],
      },
      settings: { apiEndpoint: endpoint, model, agentsContract: DEFAULT_AGENTS_CONTRACT, maxTokens: 1000 },
      persona: null,
      window: 8192,
    });
    expect(plan.tokenRatio).toBeGreaterThan(1.4);
    expect(plan.overheadTokens).toBeGreaterThanOrEqual(1400);
    expect(plan.billedInput).toBe(Math.ceil(plan.inputTokens * plan.tokenRatio) + plan.overheadTokens);
  });
});

describe("Controller ops, UI components, and Context panel telemetry", () => {
  test("SessionController lifecycle operations: activeAgentsContract, updateSettings, fork, rename, delete, restore", async () => {
    const storeSessions: Record<string, Record<string, unknown>> = {};
    const baseDb = makeControllerDb();
    const deletedIds: string[] = [];
    const db = {
      ...baseDb,
      saveSession: async (s: Record<string, unknown>) => {
        storeSessions[String(s.id)] = JSON.parse(JSON.stringify(s));
        return baseDb.saveSession(s);
      },
      getSessionsForCard: async () => Object.values(storeSessions).map((s) => JSON.parse(JSON.stringify(s))),
      deleteSession: async (id: string) => {
        deletedIds.push(id);
        delete storeSessions[id];
      },
      resolveDirectiveForCard: async () => null,
    };

    const { ctl } = await makeControllerFake(SessionController as any, { db });
    await db.saveSession((ctl as any).activeSession);

    expect((ctl as any).activeAgentsContract).toBe("contract");
    const updatedSettings = (ctl as any).updateSettings({ temperature: 0.77 });
    expect(updatedSettings.temperature).toBe(0.77);
    expect((ctl as any).settings.temperature).toBe(0.77);

    // Build two turns so we can fork at the first message and delete safely.
    await (ctl as any).send("First user turn");
    const firstMsgId = (ctl as any).activeSession.messages[0].id;
    const origId = (ctl as any).activeSession.id;

    const renamed = await (ctl as any).renameSession(origId, "Harbor Scene");
    expect(renamed.title).toBe("Harbor Scene");

    const forked = await (ctl as any).forkSession(firstMsgId, { title: "Branch A" });
    expect(forked.title).toBe("Branch A");
    expect(forked.id).not.toBe(origId);
    expect(forked.messages.length).toBe(1);
    expect((ctl as any).activeSession.id).toBe(forked.id);

    const listed = await (ctl as any).refreshSessions();
    expect(listed.length).toBe(2);

    // Undo deletion restoration check.
    const removed = (ctl as any).activeSession.messages.splice(0, 1)[0];
    await (ctl as any).restoreDeletedMessage((ctl as any).activeSession, {
      index: 0,
      message: removed,
      ledgerSnapshot: { ledger: "restored ledger", consumed: 2 },
    });
    expect((ctl as any).activeSession.messages.length).toBe(1);
    expect((ctl as any).activeSession.ledger).toBe("restored ledger");

    // Delete active forked session -> cancels turn & switches to original session.
    const delResult = await (ctl as any).deleteSession(forked.id);
    expect(deletedIds).toContain(forked.id);
    expect(delResult.activeChanged).toBe(true);
    expect(delResult.nextSession.id).toBe(origId);
  });

  test("inline_editor mounts via el(), saves on Ctrl+Enter, and closes via Escape / closeActiveInlineEdit", async () => {
    const doc = installDom();
    const feed = doc.createElement("div");
    const cardEl = doc.createElement("div");
    cardEl.className = "rp-message__card";
    const contentCol = doc.createElement("div");
    contentCol.className = "rp-message__content";
    const proseEl = doc.createElement("div");
    proseEl.className = "rp-message__prose";
    const trayEl = doc.createElement("div");
    trayEl.className = "rp-message__tray";
    contentCol.append(proseEl, trayEl);
    cardEl.append(contentCol);
    feed.append(cardEl);

    const saved: Array<{ id: string; text: string }> = [];
    const inst = openInlineEdit({
      cardEl,
      msg: { id: "m1", content: "Initial line" },
      onSave: async (m: { id: string }, val: string, close: () => void) => {
        saved.push({ id: m.id, text: val });
        close();
      },
    });
    expect(inst).not.toBeNull();
    expect(cardEl.classList.contains("is-editing")).toBe(true);
    expect(proseEl.hidden).toBe(true);
    expect(trayEl.hidden).toBe(true);

    inst!.textarea.value = "Revised line  ";
    inst!.textarea.dispatch("keydown", { key: "Enter", ctrlKey: true });
    await Promise.resolve();
    expect(saved).toEqual([{ id: "m1", text: "Revised line" }]);
    expect(cardEl.classList.contains("is-editing")).toBe(false);
    expect(proseEl.hidden).toBe(false);

    const inst2 = openInlineEdit({ cardEl, msg: { id: "m2", content: "Another" } });
    expect(inst2).not.toBeNull();
    closeActiveInlineEdit(feed);
    expect(cardEl.classList.contains("is-editing")).toBe(false);
    expect(feed.querySelector(".rp-inline-editor")).toBeNull();
  });

  test("history_modal renders XSS-safe thread titles, switches/renames/deletes threads, and populates preset selects", async () => {
    const doc = installDom();
    const listEl = doc.createElement("div");
    const personaSelectEl = doc.createElement("select") as ShimNode;
    const directiveSelectEl = doc.createElement("select") as ShimNode;

    let sessions = [
      { id: "s1", title: '<img src=x onerror="alert(1)">', messages: [{ id: "m1" }], updatedAt: Date.now() },
      { id: "s2", title: "Second Thread", messages: [], updatedAt: Date.now() },
    ];
    let active = sessions[0];
    const activated: string[] = [];

    const modal = createHistoryModal({
      listEl,
      personaSelectEl,
      directiveSelectEl,
      controller: {
        activeCard: { id: "c1", userPersonaId: "p1", directivePresetId: "d1" },
        get activeSession() { return active; },
        get sessions() { return sessions; },
        refreshSessions: async () => sessions,
        refreshPresets: async () => {},
        renameSession: async (id: string, title: string) => {
          const t = sessions.find((s) => s.id === id);
          if (t) t.title = title;
          return t;
        },
        deleteSession: async (id: string) => {
          sessions = sessions.filter((s) => s.id !== id);
          const activeChanged = active.id === id;
          if (activeChanged) active = sessions[0];
          return { activeChanged, nextSession: active };
        },
        db: {
          getAllPersonas: async () => [{ id: "p1", name: "Rowan", isDefault: true }],
          getDefaultPersona: async () => ({ id: "p1", name: "Rowan" }),
          getAllDirectives: async () => [{ id: "d1", name: "Built-in", isDefault: true }],
          getDefaultDirective: async () => ({ id: "d1", name: "Built-in" }),
        },
      },
      onActivateSession: (s: { id: string }) => { activated.push(s.id); active = s as typeof active; },
      onConfirm: async () => true,
    });

    await modal.renderThreads();
    const titleSpan = listEl.querySelector(".rp-card__title");
    expect(titleSpan?.textContent).toBe('<img src=x onerror="alert(1)">');
    expect(titleSpan?.innerHTML).toBe("");

    const switchBtn = listEl.querySelector("[data-switch]")!;
    click(switchBtn);
    expect(activated).toEqual(["s2"]);

    const rows = listEl.querySelectorAll(".rp-thread-card");
    const renameBtn = rows[0].querySelector("[data-rename]")!;
    click(renameBtn);
    const renameInput = rows[0].querySelector("input")!;
    renameInput.value = "Harbor Draft";
    renameInput.dispatch("keydown", { key: "Enter" });
    await new Promise((r) => setTimeout(r, 10));
    expect(sessions[0].title).toBe("Harbor Draft");

    const delBtn = listEl.querySelector("[data-delete]")!;
    click(delBtn);
    await new Promise((r) => setTimeout(r, 10));
    expect(sessions.length).toBe(1);

    await modal.refreshPresets();
    expect(personaSelectEl.children.length).toBe(2);
    expect(personaSelectEl.value).toBe("p1");
    expect(directiveSelectEl.children.length).toBe(2);
    expect(directiveSelectEl.value).toBe("d1");
  });

  test("context_panel renders ledgerTruncated and ignoresMaxTokens warnings only when signaled", () => {
    const req = {
      contextWindow: 8192,
      inputTokens: 1200,
      outputTokens: 600,
      breakdown: {
        requiredStatic: 800,
        optionalStatic: 0,
        persona: 0,
        lore: 0,
        ledger: 320,
        history: 80,
        currentInput: 20,
        output: 600,
        safetyMargin: 256,
        remaining: 6116,
      },
      excludedSections: [],
      overheadTokens: 0,
    };

    const quiet = renderContextPanel({ request: req, ledgerTruncated: false, ignoresMaxTokens: false });
    expect(quiet).not.toContain("reached its size ceiling");
    expect(quiet).not.toContain("previously exceeded Max response tokens");

    const signaled = renderContextPanel({ request: req, ledgerTruncated: true, ignoresMaxTokens: true });
    expect(signaled).toContain("reached its size ceiling");
    expect(signaled).toContain("previously exceeded Max response tokens");
  });
});

describe("prompt_eval gate & structural reports", () => {
  test("structuralViolations catches missing/invalid fields and CLI eval reports zero violations", () => {
    expect(() => structuralViolations(null)).toThrow(TypeError);
    const flagged = structuralViolations({
      rows: [{ scenario: "rp/x", singleDef: [{ id: "rule-dup" }] }],
      contractChecks: [{ id: "authority-rule" }],
      parityGaps: [{ rule: "universal" }],
      framingGaps: [{ id: "choiceSystem" }],
      choiceSingleDef: [{ id: "choice-steer", count: 0, expect: 1 }],
    });
    expect(flagged.length).toBe(5);

    const run = Bun.spawnSync(["bun", "run", "tools/prompt_eval.mjs"], { cwd: ROOT });
    const out = run.stdout.toString();
    expect(run.exitCode).toBe(0);
    expect(out).toContain("compactContract");
    expect(out).toContain("rp/window-4096");
    expect(out).toContain("rp/window-2048");
    expect(out).toContain("all 16 authored prompts carry zero negative and zero absolutist markers");
  });
});
