// Pure prompt, lorebook, history, and Choice Mode planner (zero DOM).

import {
  CHOICE_SYSTEM_PROMPT,
  choicePrompt,
} from "./choice_format.js";
import {
  substitutePlaceholders,
  stripThoughtBlocks,
  renderInlineField,
  neutralizeDelimiters,
  resolveCardIdentity,
} from "./text.js";
import {
  analyzeTurnState,
  buildSceneGuidance,
  GUIDANCE_MAX_TOKENS,
} from "./prompt_adaptive.js";
import {
  estimateTokens,
  countMessages,
  cleanPromptText,
  MIN_OUTPUT_TOKENS,
  resolveSafetyMargin,
  frameLedger,
  ledgerFramingTokens,
  clipLedgerToTokens,
  resolveContextBudgets,
  allocateContext,
} from "./context_plan.js";
import {
  getModelCapability,
  sessionOverheadTokens,
  sessionTokenRatio,
  effectiveContextWindow,
  shouldUseCacheBreakpoints,
} from "./model_capability.js";
import { DEFAULT_AGENTS_CONTRACT, COMPACT_AGENTS_CONTRACT } from "./local_db.js";

const LEDGER_FRAMING_TOKENS = ledgerFramingTokens();

/** First field carrying author-written string text, or "". */
export function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
  }
  return "";
}

/** True when a persona carries any authored name, bio, or template. */
export function hasPersonaContent(persona) {
  return Boolean(
    persona && (
      String(persona.name || "").trim() ||
      String(persona.description || persona.persona || persona.content || "").trim() ||
      String(persona.template || "").trim()
    )
  );
}

/** Resolves {{user}}/{{char}}/pronoun placeholders in card-authored text. */
export function substituteCardPlaceholders(text, card, persona) {
  if (typeof text !== "string" || !text) return "";
  const cName = resolveCardIdentity(card).actorName;
  const uName = firstText(persona?.name).trim();
  return substitutePlaceholders(text, { user: uName || "User", char: cName || "Character", persona });
}

const loreKeyRegexCache = new Map();
const LORE_REGEX_CACHE_MAX = 512;

function getLoreKeyRegex(k) {
  if (!k) return null;
  const str = String(k).trim().toLowerCase();
  if (!str) return null;
  let re = loreKeyRegexCache.get(str);
  if (!re) {
    const escaped = str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const isCjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(str);
    re = isCjk
      ? new RegExp(escaped, "iu")
      : new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, "iu");
    if (loreKeyRegexCache.size >= LORE_REGEX_CACHE_MAX) loreKeyRegexCache.clear();
    loreKeyRegexCache.set(str, re);
  }
  return re;
}

/**
 * Selects lorebook entries atomically up to budget without mid-entry slicing.
 * Constant entries join the stable prefix; keyword entries trigger dynamically
 * with cascading secondary-key activation bounded by `maxEntries`.
 */
export function selectLorebookEntries(card, { budget = 1000, constantOnly = false, recentText = "", maxEntries = 0 } = {}) {
  if (!card) return [];
  const book = card.data?.character_book || card.character_book;
  const rawEntries = book?.entries;
  const entries = Array.isArray(rawEntries)
    ? rawEntries
    : rawEntries && typeof rawEntries === "object"
      ? Object.values(rawEntries)
      : [];
  if (!entries.length) return [];

  const active = entries.filter((e) => e && e.enabled !== false && e.content);
  const priorityOf = (e) => (e.priority ?? e.insertion_order ?? 0);
  active.sort((a, b) => priorityOf(b) - priorityOf(a));

  const lowerText = recentText ? String(recentText).toLowerCase() : "";
  const cap = Math.max(0, Math.floor(Number(maxEntries) || 0));
  let usedTokens = 0;
  const selected = [];

  const countHits = (entry, haystack) => {
    const keys = Array.isArray(entry.keys) ? entry.keys : [entry.keys];
    let hits = 0;
    for (const k of keys) {
      const re = getLoreKeyRegex(k);
      if (re) {
        re.lastIndex = 0;
        if (re.test(haystack)) hits += 1;
      }
    }
    return hits;
  };

  const isConstantEntry = (entry) =>
    entry.constant === true || !entry.keys || (Array.isArray(entry.keys) && entry.keys.length === 0);

  if (constantOnly) {
    for (const entry of active) {
      if (!isConstantEntry(entry)) continue;
      if (cap > 0 && selected.length >= cap) break;
      const cost = estimateTokens(entry.content) + 10;
      if (usedTokens + cost <= budget) {
        selected.push(entry);
        usedTokens += cost;
      }
    }
    return selected;
  }

  const candidates = [];
  for (const entry of active) {
    if (isConstantEntry(entry)) continue;
    const hits = lowerText ? countHits(entry, lowerText) : 0;
    if (hits <= 0) continue;
    candidates.push({ entry, hits });
  }
  candidates.sort((a, b) => (b.hits - a.hits) || (priorityOf(b.entry) - priorityOf(a.entry)));

  for (const { entry } of candidates) {
    if (cap > 0 && selected.length >= cap) break;
    const cost = estimateTokens(entry.content) + 10;
    if (usedTokens + cost <= budget) {
      selected.push(entry);
      usedTokens += cost;
    }
  }

  if (selected.length > 0 && usedTokens < budget && (cap <= 0 || selected.length < cap)) {
    const selectedText = selected.map((e) => String(e.content || "").toLowerCase()).join(" ");
    const cascade = [];
    for (const entry of active) {
      if (selected.includes(entry) || isConstantEntry(entry)) continue;
      const hits = countHits(entry, selectedText);
      if (hits <= 0) continue;
      cascade.push({ entry, hits });
    }
    cascade.sort((a, b) => (b.hits - a.hits) || (priorityOf(b.entry) - priorityOf(a.entry)));
    for (const { entry } of cascade) {
      if (cap > 0 && selected.length >= cap) break;
      const cost = estimateTokens(entry.content) + 10;
      if (usedTokens + cost <= budget) {
        selected.push(entry);
        usedTokens += cost;
      }
    }
  }

  return selected;
}

const IDENTITY_MIN_CHARS = 24;
const IDENTITY_SOFT_CHARS = 120;
const IDENTITY_HARD_CHARS = 240;

function clampIdentity(text) {
  const trimStop = (value) => value.replace(/\.$/, "");
  if (text.length <= IDENTITY_SOFT_CHARS) return trimStop(text);
  const hard = text.slice(0, IDENTITY_HARD_CHARS);
  const end = hard.search(/[.!?\u2026](?:\s|$)/);
  if (end >= 0 && end + 1 >= IDENTITY_MIN_CHARS) return trimStop(hard.slice(0, end + 1).trim());
  const soft = text.slice(0, IDENTITY_SOFT_CHARS).replace(/\s+\S*$/, "").trim();
  return soft ? `${soft}\u2026` : renderInlineField(text, IDENTITY_SOFT_CHARS);
}

/** Concise sentence-safe identity phrase for adaptive persona re-injection. */
export function characterIdentity(card, persona = null) {
  if (!card) return "";
  const rawParts = [
    firstText(card.data?.personality, card.personality),
    firstText(card.data?.description, card.description),
    firstText(card.data?.system_prompt, card.system_prompt),
  ].filter(Boolean);
  if (!rawParts.length) return "";
  const clean = substituteCardPlaceholders(rawParts.join(" "), card, persona)
    .replace(/[*`#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  return clampIdentity(clean);
}

/** Normalised multi-character ensemble roster across card formats. */
export function ensembleCast(card) {
  const extGroup = card ? card.data?.extensions?.group || card.extensions?.group : null;
  const rawRoster =
    (Array.isArray(extGroup?.members) && extGroup.members) ||
    (Array.isArray(card?.data?.extensions?.characters) && card.data.extensions.characters) ||
    (Array.isArray(card?.data?.characters) && card.data.characters) ||
    (Array.isArray(card?.characters) && card.characters) ||
    null;
  const sourceList = rawRoster || resolveCardIdentity(card).declaredCharacters;
  return sourceList
    .map((member) => {
      if (!member) return null;
      if (typeof member === "string") {
        const name = renderInlineField(member);
        return name ? { name, role: "", voice: "" } : null;
      }
      const name = renderInlineField(firstText(member.name, member.char_name, member.character_name));
      if (!name) return null;
      return {
        name,
        role: renderInlineField(firstText(member.role, member.description), 160),
        voice: renderInlineField(firstText(member.voice, member.personality, member.traits), 160),
      };
    })
    .filter(Boolean);
}

/**
 * Classifies and builds static Block 0 system prompt sections in render order.
 * Uses COMPACT_AGENTS_CONTRACT automatically for the shipped default directive
 * inside tight (<=4096 token) windows; custom directives remain untouched.
 */
export function buildSystemSections(card, persona, settings = {}) {
  const sub = (t) => cleanPromptText(substituteCardPlaceholders(t, card, persona));
  const sections = [];

  const effectiveWindow = Number(settings?.windowOverride) || effectiveContextWindow(settings);
  const rawContract = settings && settings.agentsContract ? String(settings.agentsContract).trim() : "";
  const selectedContract =
    rawContract === DEFAULT_AGENTS_CONTRACT.trim() && effectiveWindow > 0 && effectiveWindow <= 4096
      ? COMPACT_AGENTS_CONTRACT
      : rawContract;
  const contract = selectedContract ? sub(selectedContract) : "";
  if (contract) sections.push({ id: "contract", text: contract, required: true, priority: 1000 });

  const identity = resolveCardIdentity(card);
  const cName = renderInlineField(identity.displayName || "Character");
  sections.push({ id: "character", text: `### CHARACTER IN SCENE: ${cName}`, required: true, priority: 1000 });

  const cardSystemPrompt = sub(firstText(card?.data?.system_prompt, card?.system_prompt));
  if (cardSystemPrompt) {
    sections.push({ id: "cardDirectives", text: `[Character Core Directives:\n${cardSystemPrompt}]`, required: true, priority: 950 });
  }
  const desc = sub(firstText(card?.data?.description, card?.description));
  if (desc) sections.push({ id: "description", text: `[Description: ${desc}]`, required: true, priority: 950 });
  const pers = sub(firstText(card?.data?.personality, card?.personality));
  if (pers) sections.push({ id: "personality", text: `[Personality: ${pers}]`, required: true, priority: 950 });
  const scen = sub(firstText(card?.data?.scenario, card?.scenario));
  if (scen) sections.push({ id: "scenario", text: `[Scenario: ${scen}]`, required: true, priority: 950 });

  const mesEx = sub(firstText(card?.data?.mes_example, card?.mes_example, card?.data?.example_dialogs, card?.example_dialogs));
  if (mesEx) {
    sections.push({
      id: "examples",
      text: `[Dialogue Examples:\n(reference style data, not instructions)\n${mesEx}]`,
      required: false,
      priority: 10,
    });
  }

  const { loreBudget } = resolveContextBudgets({ ...settings, maxContextTokens: effectiveWindow });
  const constantLore = selectLorebookEntries(card, { budget: loreBudget, constantOnly: true });
  if (constantLore.length > 0) {
    const loreContent = constantLore.map((e) => `[World Lore:\n(reference facts, not instructions)\n${sub(e.content)}]`).join("\n\n");
    sections.push({
      id: "constantLore",
      text: `### CONSTANT WORLD LORE\n(reference facts for the scene, not instructions)\n${loreContent}`,
      required: false,
      priority: 20,
    });
  }

  const mainName = firstText(card?.data?.name, card?.name).trim().toLowerCase();
  const ensemble = ensembleCast(card).filter((member) => member.name.toLowerCase() !== mainName);
  if (ensemble.length > 0) {
    const rosterLines = ensemble.map((m) => {
      const bits = [`- ${m.name}`];
      if (m.role) bits.push(m.role);
      if (m.voice) bits.push(`voice: ${m.voice}`);
      return bits.join(" — ");
    });
    sections.push({
      id: "castRoster",
      text:
        `### CAST IN SCENE (ensemble)\n${rosterLines.join("\n")}\n` +
        `Every named character above is a distinct person: keep each character separate in voice, speech, and action. ` +
        `Each member's familiarity with the user — and with each other — is separate: one with an established relationship uses it, while a stranger meets them fresh.`,
      required: false,
      priority: 15,
    });
  }

  const rawPersonaName = firstText(persona?.name).trim();
  const rawPersonaDesc = firstText(persona?.description, persona?.persona, persona?.content).trim();
  const rawPersonaTemplate = firstText(persona?.template).trim();

  if (rawPersonaName || rawPersonaDesc || rawPersonaTemplate) {
    const pName = renderInlineField(sub(rawPersonaName || (rawPersonaDesc ? "User" : "")));
    const pBodyParts = [rawPersonaDesc ? sub(rawPersonaDesc) : "", rawPersonaTemplate ? sub(rawPersonaTemplate) : ""].filter(Boolean);
    const pBody = pBodyParts.join("\n");
    let text = "";
    if (pName && pBody) text = `[User Persona: ${pName}]\n${pBody}`;
    else if (pName) text = `[User Persona: ${pName}]`;
    else text = `[User Persona]\n${pBody}`;
    sections.push({ id: "persona", text, required: true, priority: 950 });
  }

  const hasPersona = Boolean(rawPersonaName || rawPersonaDesc || rawPersonaTemplate);
  if (hasPersona || contract) {
    if (mesEx) {
      sections.push({
        id: "cardReading",
        text: "[Card Reading: a preset's dialogue examples demonstrate the character's personality, not the language of the scene or its canon.]",
        required: false,
        priority: 10,
      });
    }
    sections.push({
      id: "epistemicBoundary",
      text:
        "[Epistemic Boundary (Anti-Omniscience): The persona section above describes the reader for the " +
        "story's benefit: the character knows only what the story has shown or the reader has said, and " +
        "treats them on that basis. Where the scenario or history establishes an existing bond, they " +
        "interact with that shared familiarity; otherwise, they meet as strangers who discover names, " +
        "backstory, and private traits only as revealed on the page, reading solely observable cues.]",
      required: false,
      priority: 20,
    });
    sections.push({
      id: "voiceDifferentiation",
      text: "[Voice Differentiation: distinguish each speaker through vocabulary, rhythm, and what they withhold before any dialogue tag names them.]",
      required: false,
      priority: 8,
    });
  }

  return sections;
}

/** Renders every static system section without degradation. */
export function formatSystemPrompt(card, persona, settings) {
  return buildSystemSections(card, persona, settings)
    .map((s) => s.text)
    .join("\n\n")
    .trim();
}

/** Resolves effective budgets against model capabilities. */
export function resolveBudgets(settings = {}) {
  return resolveContextBudgets({ ...settings, maxContextTokens: effectiveContextWindow(settings) });
}

/** Monotone position-only thought-block stripping for deep history turns. */
export function shakeThoughts(messages, keepRecent = 2) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const threshold = Math.max(0, messages.length - keepRecent);

  let result = null;
  for (let i = 0; i < threshold; i++) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    const c = m.content;
    if (typeof c !== "string") continue;
    const stripped = stripThoughtBlocks(c);
    if (!stripped || stripped === c.trim()) continue;
    if (!result) result = messages.slice();
    result[i] = { ...m, content: stripped };
  }
  return result || messages;
}

/** Walking backward from newest, finds oldest user-turn boundary within budget. */
export function findCutPoint(messages, budgetTokens) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  let tokens = 0;
  let cut = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || !m.content) continue;
    const mTokens = estimateTokens(m.content) + 4;
    if (m.role === "user") {
      if (tokens + mTokens > budgetTokens && cut !== -1) break;
      cut = i;
    }
    tokens += mTokens;
  }
  return cut >= 0 ? cut : Math.max(0, messages.filter((m) => m && m.content).length - 1);
}

/** Last-resort truncation preserving system prompt and pinned opening when possible. */
export function truncateHistory(history, settings, ledger, extraInputTokens = 0, inputBudget = null, systemPrompt = "") {
  const { promptBudget } = resolveBudgets(settings);
  const capacity = Math.max(0, Number(inputBudget) || promptBudget);
  const hasSysMsg = Boolean(history[0] && history[0].role === "system");
  const system = hasSysMsg ? [history[0]] : [];
  const systemTokens = hasSysMsg ? countMessages(system) : (systemPrompt ? estimateTokens(systemPrompt) + 4 : 0);
  const rest = history.slice(system.length);
  const ledgerTokens = ledger ? estimateTokens(ledger) + LEDGER_FRAMING_TOKENS : 0;
  const extra = Math.max(0, Number(extraInputTokens) || 0);
  const budget = Math.max(0, capacity - systemTokens - ledgerTokens - extra);
  if (budget <= 0 || rest.length <= 1) {
    return rest.length ? [...system, rest[rest.length - 1]] : system;
  }
  const pinned = rest[0];
  const current = rest[rest.length - 1];
  const pinnedTokens = countMessages([pinned]);
  const currentTokens = countMessages([current]);
  if (pinnedTokens + currentTokens > budget) {
    return [...system, current];
  }
  const tail = rest.slice(1);
  const tailBudget = budget - pinnedTokens;
  const cut = findCutPoint(tail, tailBudget);
  if (cut <= 0) return history;
  return [...system, pinned, ...tail.slice(cut)];
}

/** Assembles the ordered OpenAI-compatible payload array. */
export function assembleMessages(arg1, arg2, arg3, arg4) {
  let systemPrompt = "";
  let history = [];
  let ledger = "";
  let postHistoryInstructions = "";
  if (arg1 && typeof arg1 === "object" && !Array.isArray(arg1) && ("systemPrompt" in arg1 || "history" in arg1)) {
    systemPrompt = arg1.systemPrompt || "";
    history = arg1.history || [];
    ledger = arg1.ledger || "";
    postHistoryInstructions = arg1.postHistoryInstructions || "";
  } else {
    systemPrompt = typeof arg1 === "string" ? arg1 : "";
    history = Array.isArray(arg2) ? arg2.slice() : [];
    if (typeof arg3 === "string" && arg3.trim()) {
      history.push({ role: "user", content: arg3.trim() });
    }
    postHistoryInstructions = typeof arg4 === "string" ? arg4 : "";
  }
  const payload = [];
  if (typeof systemPrompt === "string" && systemPrompt.trim()) {
    payload.push({ role: "system", content: systemPrompt.trim() });
  }
  if (ledger) payload.push({ role: "user", content: frameLedger(ledger) });
  for (const msg of history || []) {
    if (!msg || !msg.content) continue;
    const role = msg.role === "user" ? "user" : "assistant";
    payload.push({ role, content: msg.content });
  }
  if (postHistoryInstructions && postHistoryInstructions.trim()) {
    const last = payload[payload.length - 1];
    if (last && last.role === "user") last.content += `\n\n[Writing Guidance: ${postHistoryInstructions.trim()}]`;
    else payload.push({ role: "user", content: `[Writing Guidance: ${postHistoryInstructions.trim()}]` });
  }
  return payload;
}

/** Plans history tail and fold slice without mutating session state. */
export function planContext({ systemPrompt, messages, ledger, consumed = 1, settings, extraInputTokens = 0, inputBudget = null }) {
  const budgets = resolveBudgets(settings);
  const promptBudget = Math.max(0, Number(inputBudget) || budgets.promptBudget);
  const all = Array.isArray(messages) ? messages : [];
  const extra = Math.max(0, Number(extraInputTokens) || 0);
  const outer = estimateTokens(systemPrompt) + (ledger ? estimateTokens(ledger) + LEDGER_FRAMING_TOKENS : 0) + extra;
  const overflow = outer >= promptBudget;
  const overflowWarning = overflow
    ? `The static prompt, ledger and writing guidance (${outer} est. tokens) exceed the configured prompt budget (${promptBudget} tokens) that remains once the reply is reserved; raise the context window, shrink the preset, or lower the max output tokens.`
    : "";
  const budget = Math.max(256, promptBudget - outer);
  const pinned = all.length > 0 && all[0] && all[0].content ? [all[0]] : [];
  const start = Math.max(pinned.length, Math.min(consumed, all.length));
  const live = [];
  const liveIdx = [];
  for (let i = start; i < all.length; i++) {
    if (all[i] && all[i].content) {
      live.push(all[i]);
      liveIdx.push(i);
    }
  }
  const pinnedTokens = countMessages(pinned);
  const tailBudget = Math.max(256, budget - pinnedTokens);
  const shakenLive = shakeThoughts(live, 1);
  const liveTokens = countMessages(shakenLive);

  const unchanged = {
    history: [...pinned, ...shakenLive],
    folded: [],
    consumedAfter: start,
    compacted: false,
    promptTokens: outer + pinnedTokens + liveTokens,
    budget,
    overflow,
    overflowWarning,
  };
  if (liveTokens <= tailBudget) return unchanged;

  const cut = findCutPoint(shakenLive, Math.floor(tailBudget * 0.6));
  if (cut <= 0) return unchanged;
  const folded = shakenLive.slice(0, cut);
  const consumedAfter = cut < liveIdx.length ? liveIdx[cut] : all.length;
  return {
    history: [...pinned, ...shakenLive.slice(cut)],
    folded,
    consumedAfter,
    compacted: true,
    promptTokens: outer + pinnedTokens + countMessages(shakenLive.slice(cut)),
    budget,
    overflow,
    overflowWarning,
  };
}

/** Single request planner used by both streaming send and Context inspector. */
export function planRequest({ card, session, settings, persona, agentsContract, window = null, draft = "", continueMode = false }) {
  const activePersona = hasPersonaContent(persona) ? persona : null;
  const activeSettings = agentsContract !== undefined ? { ...settings, agentsContract } : settings;
  const baseWindow = effectiveContextWindow(activeSettings);
  const contextWindow = Math.max(0, Number(window) || baseWindow);
  const budgets = resolveContextBudgets({ ...activeSettings, maxContextTokens: contextWindow });

  const overheadTokens = sessionOverheadTokens(activeSettings, session);
  const tokenRatio = sessionTokenRatio(activeSettings, session);
  const scale = tokenRatio > 1.02 ? tokenRatio : 1;
  const rawUsable = Math.max(MIN_OUTPUT_TOKENS, contextWindow - overheadTokens);
  const effectiveUsable = Math.max(MIN_OUTPUT_TOKENS, Math.floor(rawUsable / scale));
  const scaledMargin = Math.ceil(budgets.safetyMargin / scale);
  const scaledMinOutput = Math.ceil(MIN_OUTPUT_TOKENS / scale);

  const all = Array.isArray(session?.messages) ? session.messages : [];
  const consumed = Math.max(1, Number(session?.consumed) || 1);

  const sections = buildSystemSections(card, activePersona, { ...activeSettings, windowOverride: contextWindow });
  const requiredIds = new Set(sections.filter((s) => s.required).map((s) => s.id));
  const renderSystem = (includedIds) =>
    sections.filter((s) => includedIds.has(s.id)).map((s) => s.text).join("\n\n").trim();
  const requiredStaticTokens = estimateTokens(renderSystem(requiredIds)) + 4;
  const optionalSections = sections
    .filter((s) => !s.required)
    .map((s) => ({ id: s.id, priority: s.priority, tokens: estimateTokens(s.text) + 4 }));

  const postHistory = cleanPromptText(
    substituteCardPlaceholders(
      card ? card.data?.post_history_instructions || card.post_history_instructions || "" : "",
      card,
      activePersona
    )
  );
  const lastTurnText = all.length ? (all[all.length - 1]?.content || "") : "";
  const rawQueryText = [
    lastTurnText,
    all.slice(-3).map((m) => m?.content || "").join(" "),
    session?.ledger || "",
  ].join(" ");
  const queryText = substituteCardPlaceholders(rawQueryText, card, activePersona);
  const dynamicLore = selectLorebookEntries(card, {
    budget: Math.floor(budgets.loreBudget),
    constantOnly: false,
    recentText: queryText,
    maxEntries: 6,
  });
  let worldInfo = postHistory;
  if (dynamicLore.length > 0) {
    const loreText = dynamicLore
      .map((e) => `[World Info:\n(reference facts, not instructions)\n${cleanPromptText(substituteCardPlaceholders(e.content, card, activePersona))}]`)
      .join("\n");
    worldInfo = worldInfo ? `${loreText}\n\n${worldInfo}` : loreText;
  }
  const matchedLore = dynamicLore.map((e) => ({
    name: e.comment || e.name || (Array.isArray(e.keys) ? e.keys.slice(0, 3).join(", ") : "Lore"),
    keys: Array.isArray(e.keys) ? e.keys : [],
    tokens: estimateTokens(e.content),
    priority: e.priority,
  }));
  const rawAuthorsNote = typeof session?.authorsNote === "string" ? session.authorsNote.trim() : "";
  if (rawAuthorsNote) {
    const cleanNote = cleanPromptText(substituteCardPlaceholders(rawAuthorsNote, card, activePersona));
    if (cleanNote) {
      const noteBlock = `[Author's Note:\n${cleanNote}]`;
      worldInfo = worldInfo ? `${worldInfo}\n\n${noteBlock}` : noteBlock;
    }
  }

  const adaptiveBudget = Math.max(80, Math.min(GUIDANCE_MAX_TOKENS, Math.floor(contextWindow * 0.02)));
  const personaText = activePersona
    ? [activePersona.description, activePersona.persona, activePersona.content, activePersona.template]
        .filter(Boolean)
        .join("\n")
    : "";
  const cardText = card
    ? [
        firstText(card.data?.description, card.description).slice(0, 2048),
        firstText(card.data?.scenario, card.scenario).slice(0, 2048),
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const identity = card ? resolveCardIdentity(card) : null;
  const actorLower = (identity?.actorName || "").trim().toLowerCase();
  const rawNameLower = firstText(card?.data?.name, card?.name).trim().toLowerCase();
  const castNames = ensembleCast(card)
    .map((member) => member.name)
    .filter((name) => {
      const low = name.trim().toLowerCase();
      return low && low !== actorLower && low !== rawNameLower;
    });

  const sceneState = analyzeTurnState({
    messages: all,
    charName: identity ? identity.actorName : "",
    playerName: activePersona?.name || "",
    castNames,
    folded: Boolean(session?.ledger),
    personaText,
    contractText: activeSettings?.agentsContract || "",
    cardText,
  });
  const adaptive = buildSceneGuidance(sceneState, {
    identity: characterIdentity(card, activePersona),
    maxTokens: adaptiveBudget,
  });

  const postHistoryText = [worldInfo, adaptive.text].filter(Boolean).join("\n\n");
  const fullPostHistory = postHistoryText;
  const loreTokens = worldInfo.trim() ? estimateTokens(worldInfo) + 4 : 0;
  const adaptiveTokens = adaptive.tokens;
  const guidanceTokens = loreTokens + adaptiveTokens;

  const CONTINUE_PROMPT =
    "[Continue the scene directly from the exact last sentence above in the same voice, perspective, and language, without repeating or summarizing the preceding line.]";
  const nonEmpty = all.filter((m) => m && m.content);
  const pinned = nonEmpty.length ? [nonEmpty[0]] : [];
  const currentTurn = nonEmpty.length > 1 ? nonEmpty[nonEmpty.length - 1] : null;
  const pinnedTokens = countMessages(pinned);
  const draftTokens = typeof draft === "string" && draft.trim() ? estimateTokens(draft.trim()) + 4 : 0;
  const isContinueTurn = Boolean(continueMode && nonEmpty.length > 0 && nonEmpty[nonEmpty.length - 1]?.role === "assistant");
  const continueTokens = isContinueTurn ? estimateTokens(CONTINUE_PROMPT) + 4 : 0;
  const currentTurnTokens = (currentTurn ? estimateTokens(currentTurn.content) + 4 : 0) + draftTokens + continueTokens;

  const desiredOutput = typeof activeSettings.maxTokens === "number" ? activeSettings.maxTokens : budgets.maxOutput;
  const scaledDesiredOutput = Math.ceil(desiredOutput / scale);
  const requiredWithoutLedger = requiredStaticTokens + guidanceTokens + pinnedTokens + currentTurnTokens + LEDGER_FRAMING_TOKENS;
  const ledgerBudget = Math.max(0, effectiveUsable - scaledMargin - scaledMinOutput - requiredWithoutLedger);

  let requestLedger = session?.ledger || "";
  let ledgerCondensed = false;
  if (estimateTokens(requestLedger) > ledgerBudget) {
    requestLedger = clipLedgerToTokens(requestLedger, ledgerBudget);
    ledgerCondensed = true;
  }
  const ledgerTokens = requestLedger ? estimateTokens(requestLedger) + LEDGER_FRAMING_TOKENS : 0;
  const requiredTokens = requiredStaticTokens + ledgerTokens + guidanceTokens + pinnedTokens + currentTurnTokens;

  const prefixOnly = requiredStaticTokens + ledgerTokens + pinnedTokens;
  const allocOptions = {
    contextWindow: effectiveUsable,
    desiredOutput: scaledDesiredOutput,
    safetyMargin: scaledMargin,
    minOutput: scaledMinOutput,
    requiredTokens,
    optionalItems: optionalSections,
  };
  let alloc = allocateContext({ ...allocOptions, optionalBudgetTokens: prefixOnly });
  if (requiredTokens + alloc.optionalTokens + scaledMinOutput + scaledMargin > effectiveUsable) {
    alloc = allocateContext(allocOptions);
  }

  const includedIds = new Set([...requiredIds, ...alloc.included.map((i) => i.id)]);
  const excludedSections = alloc.excluded.map((i) => i.id);
  if (includedIds.has("cardReading") && !includedIds.has("examples")) {
    includedIds.delete("cardReading");
    if (!excludedSections.includes("cardReading")) excludedSections.push("cardReading");
  }
  const systemPrompt = renderSystem(includedIds);

  let plan = planContext({
    systemPrompt,
    messages: all,
    ledger: requestLedger,
    consumed,
    settings: activeSettings,
    extraInputTokens: guidanceTokens,
    inputBudget: alloc.inputBudget,
  });

  const subbed = (list) =>
    list.map((m) => ({ role: m.role, content: substituteCardPlaceholders(m.content, card, activePersona) }));
  const assemble = (history) => {
    const resolved = subbed(history);
    if (continueMode && resolved.length > 0 && resolved[resolved.length - 1]?.role === "assistant") {
      resolved.push({ role: "user", content: CONTINUE_PROMPT });
    }
    return assembleMessages({
      systemPrompt,
      history: resolved,
      ledger: requestLedger,
      postHistoryInstructions: fullPostHistory,
    });
  };

  let payload = assemble(plan.history);
  let inputTokens = countMessages(payload);
  if (inputTokens > alloc.inputBudget && plan.history.length > 1) {
    const truncated = truncateHistory(plan.history, activeSettings, requestLedger, guidanceTokens, alloc.inputBudget, systemPrompt);
    if (truncated.length !== plan.history.length) {
      plan = { ...plan, history: truncated };
      payload = assemble(truncated);
      inputTokens = countMessages(payload);
    }
  }

  const realInputTokens = scale > 1 ? Math.ceil(inputTokens * scale) : inputTokens;
  const rawAllocOutput = scale > 1 ? Math.min(desiredOutput, Math.round(alloc.output * scale)) : alloc.output;
  const outputTokens = Math.max(
    MIN_OUTPUT_TOKENS,
    Math.min(rawAllocOutput, rawUsable - budgets.safetyMargin - realInputTokens)
  );

  const includedOptionalTokens = alloc.included
    .filter((i) => includedIds.has(i.id))
    .reduce((n, i) => n + i.tokens, 0);
  const contractSection = sections.find((s) => s.id === "contract" && includedIds.has(s.id));
  const contractTokens = contractSection ? estimateTokens(contractSection.text) : 0;
  const personaTokens = sections.some((s) => s.id === "persona")
    ? estimateTokens(renderSystem(new Set(["persona"]))) + 4
    : 0;
  const historyTokens = Math.max(0, countMessages(plan.history) - currentTurnTokens);

  return {
    payload,
    systemPrompt,
    requestLedger,
    postHistory: fullPostHistory,
    plan,
    budgets,
    contextWindow,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    contractTokens,
    tokenRatio: scale,
    ledgerCondensed,
    breakdown: {
      requiredStatic: requiredStaticTokens - personaTokens,
      optionalStatic: includedOptionalTokens,
      persona: personaTokens,
      lore: guidanceTokens,
      loreTokens,
      adaptiveTokens,
      ledger: ledgerTokens,
      history: historyTokens,
      currentInput: currentTurnTokens,
      output: outputTokens,
      safetyMargin: budgets.safetyMargin,
      remaining: Math.max(0, contextWindow - realInputTokens - outputTokens - overheadTokens),
    },
    adaptiveNotes: adaptive.notes || [],
    matchedLore,
    includedSections: [...includedIds],
    excludedSections,
    overheadTokens,
    billedInput: realInputTokens + overheadTokens,
    impossible: realInputTokens + outputTokens + overheadTokens > contextWindow,
  };
}

/** Whether silent deliberation hints should be requested for Choice Mode. */
export function shouldDeliberate(settings = {}, { endpoint = "", model = "" } = {}) {
  const mode = String(settings?.choiceDeliberation || "auto").trim().toLowerCase();
  if (mode === "always") return true;
  if (mode === "never") return false;
  if (String(settings?.reasoningEffort || "").trim()) return false;
  const cap = getModelCapability(
    endpoint || settings?.apiEndpoint,
    model || settings?.choiceModel || settings?.model
  );
  return !cap.observedReasoning;
}

/** Builds the choice-generation payload, sharing main prefix only when on main model and within budget. */
export function planChoiceRequest({
  card = null,
  session = null,
  settings = {},
  persona = null,
  count = 4,
  charName = "",
  playerName = "",
  previousChoices = [],
  window: windowOverride = null,
  intent = "",
  boostOutput = false,
} = {}) {
  const activePersona = hasPersonaContent(persona) ? persona : null;
  const rawCardName = firstText(card?.data?.name, card?.name).trim();
  const resolvedActor = card ? resolveCardIdentity(card).actorName : "";
  const effectiveCharName =
    charName && charName !== rawCardName ? charName : (resolvedActor || charName || "the character");
  const name = renderInlineField(effectiveCharName);
  const who = renderInlineField(playerName || activePersona?.name || "the protagonist");

  const configuredChoiceModel = String(settings?.choiceModel || "").trim();
  const mainModel = String(settings?.model || "").trim();
  const choiceModel = configuredChoiceModel || mainModel;
  const usesMainModel = !configuredChoiceModel || configuredChoiceModel === mainModel;

  const task = choicePrompt(count, {
    charName: name,
    playerName: who,
    previousChoices,
    deliberate: shouldDeliberate(settings, {
      endpoint: settings?.apiEndpoint,
      model: choiceModel,
    }),
    intent,
  });

  const steerTail = intent
    ? `\n\nPlayer Steering Focus:\nAnchor all options to the requested direction: "${neutralizeDelimiters(intent, 120)}". Every choice should pursue this path through different tactics.`
    : "";
  const taskContent = `${task}\n\n${CHOICE_SYSTEM_PROMPT}${steerTail}`;
  const taskTokens = estimateTokens(taskContent) + 4;

  const choiceSettings = choiceModel ? { ...settings, model: choiceModel } : settings;
  const baseWindow = Math.max(0, Number(windowOverride) || effectiveContextWindow(choiceSettings));
  const choiceOverhead = sessionOverheadTokens(choiceSettings, session);
  const choiceRatio = sessionTokenRatio(choiceSettings, session);
  const choiceScale = choiceRatio > 1.02 ? choiceRatio : 1;
  const margin = resolveSafetyMargin(baseWindow);
  const choiceCap = getModelCapability(settings?.apiEndpoint, choiceModel);
  const isReasoningChoice = Boolean(choiceCap.observedReasoning || boostOutput);
  const usableWindow = Math.max(0, baseWindow - choiceOverhead - margin);
  const windowChoiceTarget = Math.max(MIN_OUTPUT_TOKENS, Math.floor((baseWindow * 3) / 32));
  const configuredMax =
    typeof choiceSettings?.maxTokens === "number" && choiceSettings.maxTokens > 0
      ? Math.max(MIN_OUTPUT_TOKENS, choiceSettings.maxTokens)
      : null;
  const reasonShare = boostOutput ? 0.5 : 0.35;
  const rawReasonTarget = Math.max(
    windowChoiceTarget,
    configuredMax || 0,
    Math.floor(usableWindow * reasonShare)
  );
  const maxChoiceOutput = isReasoningChoice
    ? Math.max(MIN_OUTPUT_TOKENS, Math.min(rawReasonTarget, Math.floor(usableWindow * 0.6)))
    : configuredMax !== null
      ? Math.min(windowChoiceTarget, configuredMax)
      : windowChoiceTarget;
  const desiredOutput = maxChoiceOutput;
  const minRequiredOutput = isReasoningChoice
    ? Math.min(maxChoiceOutput, Math.max(MIN_OUTPUT_TOKENS, Math.floor(usableWindow * 0.3)))
    : MIN_OUTPUT_TOKENS;

  const stripTrailingGuidance = (payload) => {
    if (!Array.isArray(payload) || payload.length === 0) return payload || [];
    const last = payload[payload.length - 1];
    if (last?.role === "user" && typeof last.content === "string" && last.content.startsWith("[Writing Guidance:")) {
      return payload.slice(0, -1);
    }
    return payload;
  };

  const skipSharedForCost =
    !choiceCap.observedCacheHit &&
    (choiceCap.uncachedStreak || 0) >= 3 &&
    !shouldUseCacheBreakpoints(choiceSettings, choiceCap);

  if (usesMainModel && !skipSharedForCost) {
    let main = planRequest({
      card,
      session,
      settings,
      persona: activePersona,
      window: Math.max(MIN_OUTPUT_TOKENS * 4, baseWindow - Math.ceil(taskTokens * choiceScale)),
    });

    if (main.plan.compacted) {
      const fullMain = planRequest({
        card,
        session,
        settings,
        persona: activePersona,
        window: baseWindow,
      });
      const fullPayload = [...stripTrailingGuidance(fullMain.payload), { role: "user", content: taskContent }];
      const fullInput = countMessages(fullPayload);
      const fullRealInput = choiceScale > 1 ? Math.ceil(fullInput * choiceScale) : fullInput;
      const fullOut = Math.max(
        MIN_OUTPUT_TOKENS,
        Math.min(maxChoiceOutput, baseWindow - margin - fullRealInput - choiceOverhead)
      );
      if (
        !fullMain.impossible &&
        !fullMain.plan.compacted &&
        fullOut >= minRequiredOutput &&
        fullRealInput + fullOut + choiceOverhead <= baseWindow
      ) {
        main = { ...fullMain, outputTokens: fullOut };
      }
    }

    const mainPayload = [...stripTrailingGuidance(main.payload), { role: "user", content: taskContent }];
    const mainInputTokens = countMessages(mainPayload);
    const mainRealInput = choiceScale > 1 ? Math.ceil(mainInputTokens * choiceScale) : mainInputTokens;
    const choiceOutput = Math.max(
      MIN_OUTPUT_TOKENS,
      Math.min(maxChoiceOutput, baseWindow - margin - mainRealInput - choiceOverhead)
    );
    const mainFits =
      !main.impossible &&
      choiceOutput >= minRequiredOutput &&
      mainRealInput + choiceOutput + choiceOverhead <= baseWindow;
    if (mainFits) {
      return {
        payload: mainPayload,
        inputTokens: mainInputTokens,
        outputTokens: choiceOutput,
        contextWindow: baseWindow,
        overheadTokens: choiceOverhead,
        tokenRatio: choiceScale,
        ledgerIncluded: Boolean(main.requestLedger),
        historyIncluded: main.plan.history.length,
        sharedPrefix: true,
      };
    }
  }

  // Compact choice prompt (fallback on tight windows/cards, or direct path for a separate choiceModel).
  const sceneRaw = substituteCardPlaceholders(
    firstText(card?.data?.scenario, card?.scenario, card?.data?.description, card?.description),
    card,
    activePersona
  );
  const sceneBrief = renderInlineField(sceneRaw, 160);
  const identityBrief = !sceneBrief ? renderInlineField(characterIdentity(card, activePersona), 120) : "";
  const personaBrief = activePersona ? renderInlineField(substituteCardPlaceholders(firstText(activePersona.description), card, activePersona), 100) : "";
  const noteRaw = typeof session?.authorsNote === "string" ? session.authorsNote.trim() : "";
  const noteBrief = noteRaw ? renderInlineField(substituteCardPlaceholders(noteRaw, card, activePersona), 120) : "";
  const sceneParts = [
    (sceneBrief || identityBrief) ? `${neutralizeDelimiters(name)}: ${neutralizeDelimiters(sceneBrief || identityBrief, 160)}` : "",
    personaBrief ? `${neutralizeDelimiters(who)}: ${neutralizeDelimiters(personaBrief, 100)}` : "",
    noteBrief ? `Note: ${neutralizeDelimiters(noteBrief, 120)}` : "",
  ].filter(Boolean);
  const compactSystem = sceneParts.length > 0
    ? `${CHOICE_SYSTEM_PROMPT}\n\nScene context — ${sceneParts.join(" | ")}`
    : CHOICE_SYSTEM_PROMPT;

  const head = [{ role: "system", content: compactSystem }];
  const headTokens = estimateTokens(compactSystem) + 4;
  const taskOnlyTokens = estimateTokens(`${task}${steerTail}`) + 4;
  const reservedOutput = Math.min(desiredOutput, Math.max(MIN_OUTPUT_TOKENS, Math.floor(usableWindow * 0.5)));
  const maxEstWindow = Math.max(0, Math.floor((usableWindow - reservedOutput) / choiceScale));
  const recentLimit = Math.max(MIN_OUTPUT_TOKENS, Math.floor(Math.sqrt(maxEstWindow) * 25));
  const ledgerLimit = Math.floor(recentLimit * 0.32);
  let budget = Math.min(recentLimit, maxEstWindow - headTokens - taskOnlyTokens);

  const storedLedger = session?.ledger || "";
  const recap = [];
  if (storedLedger && budget > LEDGER_FRAMING_TOKENS) {
    const ledger = clipLedgerToTokens(storedLedger, Math.min(ledgerLimit, budget - LEDGER_FRAMING_TOKENS), "");
    if (ledger) {
      recap.push({ role: "user", content: frameLedger(ledger) });
      budget -= estimateTokens(ledger) + LEDGER_FRAMING_TOKENS;
    }
  }

  const tail = [];
  const all = (Array.isArray(session?.messages) ? session.messages : []).filter((m) => m && m.content);
  for (let i = all.length - 1; i >= 0 && budget > 0; i -= 1) {
    const role = all[i].role === "user" ? "user" : "assistant";
    const resolved = substituteCardPlaceholders(String(all[i].content), card, activePersona);
    const content = role === "assistant" ? stripThoughtBlocks(resolved) : resolved;
    if (!content) continue;
    const tokens = estimateTokens(content) + 4;
    if (tokens > budget) break;
    tail.unshift({ role, content });
    budget -= tokens;
  }
  const payload = [...head, ...recap, ...tail, { role: "user", content: `${task}${steerTail}` }];
  const inputTokens = countMessages(payload);
  const realInput = choiceScale > 1 ? Math.ceil(inputTokens * choiceScale) : inputTokens;

  return {
    payload,
    inputTokens,
    outputTokens: Math.max(
      MIN_OUTPUT_TOKENS,
      Math.min(desiredOutput, baseWindow - choiceOverhead - realInput - margin)
    ),
    contextWindow: baseWindow,
    overheadTokens: choiceOverhead,
    tokenRatio: choiceScale,
    ledgerIncluded: recap.length > 0,
    historyIncluded: tail.length,
    sharedPrefix: false,
  };
}
