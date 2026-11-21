// Model capabilities and learned telemetry store (pure ES module, zero DOM).
//
// What an endpoint has been observed to accept, reject, ignore, or charge for.
// Learned at runtime, never guessed from the model name. Persisted so facts
// learned in one session survive page reloads and cross-session turns.

import { LEDGER_OPEN } from "./context_plan.js";

const modelCapabilities = new Map();
const CAPABILITY_STORE_KEY = "vibe_rp_model_caps";
// Bounded so a user who tries many endpoints cannot grow the store without
// limit. Least-recently-written entries are dropped first.
const CAPABILITY_STORE_MAX = 64;
/** How many overhead samples the median is taken over. */
const OVERHEAD_SAMPLES = 5;

function capabilityKey(endpoint, model) {
  return `${String(endpoint || "").trim()}::${String(model || "").trim()}`;
}

function capabilityStorage() {
  try {
    const store = globalThis.localStorage;
    return store && typeof store.getItem === "function" ? store : null;
  } catch {
    // A host that throws on property access (some sandboxes) is the same as
    // one that has no storage.
    return null;
  }
}

let capabilitiesHydrated = false;
function hydrateCapabilities() {
  if (capabilitiesHydrated) return;
  capabilitiesHydrated = true;
  const store = capabilityStorage();
  if (!store) return;
  try {
    const raw = store.getItem(CAPABILITY_STORE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    for (const [key, value] of Object.entries(parsed)) {
      if (value && typeof value === "object") modelCapabilities.set(key, value);
    }
  } catch {
    // Corrupt or unreadable: start clean rather than fail every lookup.
    try {
      store.removeItem(CAPABILITY_STORE_KEY);
    } catch {
      /* nothing further to do */
    }
  }
}

function persistCapabilities() {
  const store = capabilityStorage();
  if (!store) return;
  try {
    const entries = [...modelCapabilities.entries()];
    // Map iteration is insertion-ordered; the tail is the most recent.
    const kept = entries.slice(Math.max(0, entries.length - CAPABILITY_STORE_MAX));
    store.setItem(CAPABILITY_STORE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Quota or a hostile store: the in-memory map still serves this session.
  }
}

export function getModelCapability(endpoint, model) {
  hydrateCapabilities();
  return modelCapabilities.get(capabilityKey(endpoint, model)) || {};
}

export function updateModelCapability(endpoint, model, updates) {
  hydrateCapabilities();
  const key = capabilityKey(endpoint, model);
  const current = modelCapabilities.get(key) || {};
  // Re-insert so the key moves to the recent end of the eviction order.
  modelCapabilities.delete(key);
  modelCapabilities.set(key, { ...current, ...updates });
  persistCapabilities();
}

function lowerMedian(nums) {
  const sorted = nums.slice().sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/**
 * Records one observation of how many tokens the endpoint bills versus our
 * estimate. Separates fixed per-request preamble (gateway injections) from
 * linear tokenizer-ratio scaling (e.g. non-English or high-ratio tokenizers)
 * whenever samples span distinct request sizes (`|s2 - s1| >= 500`), falling
 * back to raw lower-median overhead on single or fixed-size observations.
 */
export function notePromptOverhead(endpoint, model, billed, sent) {
  if (typeof billed !== "number" || typeof sent !== "number") return;
  if (!Number.isFinite(billed) || !Number.isFinite(sent)) return;
  const delta = billed - sent;
  if (delta < 0 || delta > 32768) return;
  const cap = getModelCapability(endpoint, model);
  const samples = Array.isArray(cap.promptOverheadSamples) ? cap.promptOverheadSamples.slice() : [];
  samples.push(Math.round(delta));
  while (samples.length > OVERHEAD_SAMPLES) samples.shift();

  const pairs = Array.isArray(cap.promptOverheadPairs) ? cap.promptOverheadPairs.slice() : [];
  pairs.push([Math.round(sent), Math.round(billed)]);
  while (pairs.length > OVERHEAD_SAMPLES) pairs.shift();

  const slopes = [];
  for (let i = 0; i < pairs.length; i += 1) {
    for (let j = i + 1; j < pairs.length; j += 1) {
      const ds = pairs[j][0] - pairs[i][0];
      if (Math.abs(ds) >= 500) {
        slopes.push((pairs[j][1] - pairs[i][1]) / ds);
      }
    }
  }

  let tokenRatio = 1;
  let fixedOverhead = lowerMedian(samples);
  if (slopes.length > 0) {
    const rawSlope = lowerMedian(slopes);
    tokenRatio = Math.max(1, Math.min(2.5, Math.round(rawSlope * 100) / 100));
    const intercepts = pairs.map(([s, b]) => Math.max(0, Math.round(b - tokenRatio * s)));
    fixedOverhead = lowerMedian(intercepts);
  }

  updateModelCapability(endpoint, model, {
    promptOverheadSamples: samples,
    promptOverheadPairs: pairs,
    promptOverheadTokens: fixedOverhead,
    promptTokenRatio: tokenRatio,
  });
}

/**
 * The measured per-request fixed preamble for this endpoint, or 0 when none
 * has been observed.
 */
export function promptOverheadTokens(settings = {}) {
  const cap = getModelCapability(settings?.apiEndpoint, settings?.model);
  return typeof cap.promptOverheadTokens === "number" && cap.promptOverheadTokens > 0
    ? cap.promptOverheadTokens
    : 0;
}

/**
 * Learned multiplier of the provider's tokenizer relative to `estimateTokens`
 * (1 when unmeasured or indistinguishable from 1).
 */
export function promptTokenRatio(settings = {}) {
  const cap = getModelCapability(settings?.apiEndpoint, settings?.model);
  return typeof cap.promptTokenRatio === "number" && cap.promptTokenRatio > 1
    ? cap.promptTokenRatio
    : 1;
}

let sessionOverhead = new WeakMap();
let sessionTokenRatios = new WeakMap();

/**
 * The overhead to charge for one session: the value frozen at the first plan
 * that had one, otherwise the learned value, which is then frozen.
 */
export function sessionOverheadTokens(settings = {}, session = null) {
  const learned = promptOverheadTokens(settings);
  if (!session || typeof session !== "object") return learned;
  const scopeKey = capabilityKey(settings?.apiEndpoint, settings?.model);
  let byModel = sessionOverhead.get(session);
  if (!byModel) {
    byModel = new Map();
    sessionOverhead.set(session, byModel);
  }
  const frozen = byModel.get(scopeKey);
  if (frozen !== undefined) return frozen;
  if (learned <= 0) return 0;
  byModel.set(scopeKey, learned);
  return learned;
}

/**
 * Tokenizer ratio frozen per `(session, endpoint, model)` to avoid mid-session
 * prefix invalidation when samples jitter.
 */
export function sessionTokenRatio(settings = {}, session = null) {
  const learned = promptTokenRatio(settings);
  if (!session || typeof session !== "object") return learned;
  const scopeKey = capabilityKey(settings?.apiEndpoint, settings?.model);
  let byModel = sessionTokenRatios.get(session);
  if (!byModel) {
    byModel = new Map();
    sessionTokenRatios.set(session, byModel);
  }
  const frozen = byModel.get(scopeKey);
  if (frozen !== undefined) return frozen;
  if (learned <= 1) return 1;
  byModel.set(scopeKey, learned);
  return learned;
}

export function invalidateCapabilitiesCache() {
  modelCapabilities.clear();
  // A frozen overhead or ratio derives from the store, so forgetting the store forgets both.
  sessionOverhead = new WeakMap();
  sessionTokenRatios = new WeakMap();
  capabilitiesHydrated = false;
}

export function clearModelCapabilities() {
  invalidateCapabilitiesCache();
  const store = capabilityStorage();
  if (!store) return;
  try {
    store.removeItem(CAPABILITY_STORE_KEY);
  } catch {
    /* nothing further to do */
  }
}

/**
 * Records the model's real context window, as named by a provider error.
 *
 * A context-length rejection is the only portable signal of the model's true
 * window over an OpenAI-compatible API, so recovering it is worth the parse. The
 * value is remembered against the endpoint+model, which is what turns a
 * per-turn mistake into a per-model one: without this, every session on a model
 * whose window is smaller than the configured guess pays a rejected request
 * before it can send anything.
 */
export function noteContextWindow(endpoint, model, window) {
  const n = Number(window);
  if (!Number.isFinite(n) || n < 2048) return;
  updateModelCapability(endpoint, model, { contextWindow: Math.round(n) });
}

/**
 * The window to actually plan against: the configured value, lowered to the
 * learned one when a provider has told the app it is smaller.
 *
 * Clamping rather than overriding is deliberate. The learned value is evidence
 * about the model; the configured value is the user's intent, and a user who
 * later raises the setting has raised it on purpose. Taking the minimum keeps
 * both: the learned limit is respected, and the setting still governs.
 */
export function effectiveContextWindow(settings = {}) {
  const configured = Math.max(2048, Number(settings?.maxContextTokens) || 16384);
  const cap = getModelCapability(settings?.apiEndpoint, settings?.model);
  const learned = Number(cap.contextWindow);
  if (!Number.isFinite(learned) || learned < 2048) return configured;
  return Math.min(configured, learned);
}

/**
 * Detects HTTP 400 parameter rejection errors returned by OpenAI-compatible
 * providers, routers, gateways, and local inference engines.
 */
export function detectParameterRejection(err) {
  const msg = String(err?.message || "").toLowerCase();
  const unsupportedTemp =
    /(?:temperature|sampling).*?(?:not supported|unsupported)/i.test(msg) ||
    /unsupported.*?(?:parameter ['"]?temperature['"]?|temperature|top_p|presence_penalty|frequency_penalty)/i.test(msg);
  const needsMaxCompletionTokens =
    /max_tokens.*?(?:not supported|unsupported|unrecognized)/i.test(msg) ||
    /use ['"]?max_completion_tokens['"]?/i.test(msg);
  const needsMaxTokens =
    /max_completion_tokens.*?(?:not supported|unsupported|unrecognized|unknown)/i.test(msg);
  const unsupportedReasoningEffort =
    /reasoning_effort.*?(?:not supported|unsupported|unrecognized|unknown|invalid|not permitted|extra)/i.test(msg) ||
    /(?:unsupported|unrecognized|unknown|extra|invalid|not permitted).{0,40}?reasoning_effort/i.test(msg);
  const unsupportedMinP =
    /min_p.*?(?:not supported|unsupported|unrecognized|unknown|invalid|not permitted|extra)/i.test(msg) ||
    /(?:unsupported|unrecognized|unknown|extra|invalid).{0,40}?min_p/i.test(msg);
  const unsupportedStreamOptions =
    /stream_options.*?(?:not supported|unsupported|unrecognized|unknown)/i.test(msg) ||
    /unsupported.*?parameter ['\"]?stream_options['\"]?/i.test(msg);
  const unsupportedCacheControl =
    /cache_control.*?(?:not supported|unsupported|unrecognized|unknown|invalid)/i.test(msg) ||
    /unsupported.*?parameter ['\"]?cache_control['\"]?/i.test(msg);
  const unsupportedPromptCacheKey =
    /prompt_cache_key.*?(?:not supported|unsupported|unrecognized|unknown|invalid|not permitted|extra)/i.test(msg) ||
    /(?:unsupported|unrecognized|unknown|extra).{0,40}?prompt_cache_key/i.test(msg);
  const unsupportedResponseFormat =
    /response_format.*?(?:not supported|unsupported|unrecognized|unknown|invalid|not permitted|extra)/i.test(msg) ||
    /(?:unsupported|unrecognized|unknown|invalid).{0,40}?response_format/i.test(msg) ||
    /json_object.*?(?:not supported|unsupported|invalid)/i.test(msg);

  if (unsupportedTemp || needsMaxCompletionTokens || needsMaxTokens || unsupportedReasoningEffort || unsupportedMinP || unsupportedStreamOptions || unsupportedCacheControl || unsupportedPromptCacheKey || unsupportedResponseFormat) {
    return {
      unsupportedTemp,
      needsMaxCompletionTokens,
      needsMaxTokens,
      unsupportedReasoningEffort,
      unsupportedMinP,
      unsupportedStreamOptions,
      unsupportedCacheControl,
      unsupportedPromptCacheKey,
      unsupportedResponseFormat,
    };
  }
  return null;
}

/**
 * The routing key that ties every request of one chat together.
 *
 * Providers and multi-account gateways keep a prompt cache per backend; a
 * request only hits it when it is routed back to the backend that served the
 * previous turn. `prompt_cache_key` is the OpenAI-compatible hint for exactly
 * that, and gateways such as CLIProxyAPI read it as a session-affinity signal.
 * The key is the chat's own id, so the main turn, the choice menu and a fold of
 * the same chat share one route, and two chats never do. `null` (no key sent)
 * when the chat has no id or the provider has rejected the field.
 */
export function promptCacheKeyFor(session, cap = null) {
  if (cap && cap.supportsPromptCacheKey === false) return null;
  const id = session && typeof session.id === "string" ? session.id.trim() : "";
  return id ? `vibe-rp:${id}` : null;
}

/**
 * The model that performs folds.
 *
 * A fold is extraction over tokens that have already been paid for once: read
 * the transcript, merge it into the ledger. It does not write prose, and nothing
 * the reader sees comes from it directly — only the ledger does. Measured on a
 * real endpoint, one fold generates ~2,200 tokens, of which ~72% are invisible
 * reasoning, which makes it about as expensive as a full narrative turn while
 * being a far simpler task.
 *
 * Empty means "use the main model", which keeps every existing configuration
 * working unchanged.
 */
export function summaryModelOf(settings = {}) {
  return String(settings?.summaryModel || "").trim() || String(settings?.model || "").trim();
}

/**
 * Whether this endpoint can be asked to cache the prompt prefix.
 *
 * Prefix caching is the single largest cost lever this app has: measured, 95.9%
 * to 99.2% of a turn's input is a byte-stable prefix, and the four context rules
 * exist precisely to keep it that way. OpenAI-compatible providers that cache
 * automatically get that for free. Anthropic does not — it caches only where an
 * explicit `cache_control` breakpoint says so, which is also where the discount
 * is deepest.
 *
 * The field is an extension, so this is opt-in by shape and reversible by
 * observation: it is sent for endpoints that identify as Anthropic, and switched
 * off for the whole endpoint+model pair the first time a provider rejects it.
 * A provider that accepts and ignores the field is harmless — the request is
 * byte-identical apart from a field it discards.
 */
export function shouldUseCacheBreakpoints(settings = {}, capability = null) {
  const cap = capability || getModelCapability(settings?.apiEndpoint, settings?.model);
  if (settings?.promptCacheBreakpoints === false) return false;
  if (cap.supportsCacheControl === false) return false;
  if (cap.supportsCacheControl === true) return true;
  const endpoint = String(settings?.apiEndpoint || "").toLowerCase();
  const model = String(settings?.model || "").toLowerCase();
  return endpoint.includes("anthropic") || model.includes("claude");
}

/**
 * Whether structured JSON mode (`response_format: { type: "json_object" }`)
 * should be requested for auxiliary JSON tasks like Choice Mode.
 */
export function shouldUseJsonResponseFormat(settings = {}, capability = null) {
  const cap = capability || getModelCapability(settings?.apiEndpoint, settings?.model);
  if (cap.supportsResponseFormat === false) return false;
  if (settings?.choiceJsonMode === false) return false;
  const endpoint = String(settings?.apiEndpoint || "").toLowerCase();
  if (endpoint.includes("api.anthropic.com")) return false;
  return true;
}

/**
 * Rewrites the payload into Anthropic-style content blocks carrying
 * `cache_control` breakpoints, up to the four the API allows.
 *
 * The breakpoints map onto the layout the app already maintains, which is why
 * they are cheap to add: the stable prefix first (system), then the ledger
 * (replaced in place, so it hits until a fold), then the frozen history. The
 * newest turn is deliberately left unmarked — it is the only part that changes
 * every request, and marking it would buy nothing while writing a cache entry
 * that is never read.
 *
 * Only the marked messages change shape. Everything else stays a plain string,
 * so the array a provider sees is otherwise byte-identical to what the app
 * assembled and measured.
 */
export function withCacheBreakpoints(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const marks = new Set([0]);
  // Message 1 is the ledger whenever one is present; it is worth its own
  // breakpoint because it is replaced in place rather than appended to.
  const second = messages[1];
  if (second && typeof second.content === "string" && second.content.startsWith(LEDGER_OPEN)) {
    marks.add(1);
  }
  // The newest message changes every turn; the one before it does not.
  // When a choice request appends its task after a synthetic `[Writing Guidance:`
  // user message, step back one more slot to land on the frozen assistant turn
  // that the next main turn will share.
  if (messages.length >= 3) {
    const penultimate = messages[messages.length - 2];
    const isSyntheticGuidance =
      messages.length >= 4 &&
      penultimate?.role === "user" &&
      typeof penultimate.content === "string" &&
      penultimate.content.startsWith("[Writing Guidance:");
    const tailMark = isSyntheticGuidance ? messages.length - 3 : messages.length - 2;
    marks.add(tailMark);
    // Use the fourth allowed breakpoint on the prior turn's frozen tail so
    // endpoints that match strictly at marked blocks hit the previous turn's
    // cache before extending it to `tailMark`.
    if (tailMark - 2 >= 2) marks.add(tailMark - 2);
  }
  return messages.map((m, i) => {
    if (!marks.has(i) || typeof m?.content !== "string") return m;
    return { ...m, content: [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }] };
  });
}

/**
 * Records that a model reasons on its own, inferred from the provider's own
 * usage report or streaming reasoning deltas rather than from the model's name.
 */
export function noteObservedReasoning(endpoint, model, usage, sawReasoningDelta = false) {
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
  if (sawReasoningDelta || (typeof reasoning === "number" && reasoning > 0)) {
    updateModelCapability(endpoint, model, { observedReasoning: true });
  }
}

/**
 * Records whether the endpoint actually returned cached prompt tokens on a
 * sizable request, so non-caching gateways can skip full-prefix sharing in
 * auxiliary calls (like Choice Mode) and save ~75% input tokens.
 */
export function noteCacheObservation(endpoint, model, usage) {
  if (!usage || typeof usage !== "object") return;
  const cached =
    usage.prompt_tokens_details?.cached_tokens ??
    usage.cache_read_input_tokens ??
    usage.prompt_cache_hit_tokens ??
    usage.total_cached_tokens ??
    null;
  if (typeof cached !== "number") return;
  if (cached > 0) {
    updateModelCapability(endpoint, model, { observedCacheHit: true, uncachedStreak: 0 });
    return;
  }
  const input = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : (usage.input_tokens || 0);
  if (input >= 1024) {
    const cap = getModelCapability(endpoint, model);
    updateModelCapability(endpoint, model, { uncachedStreak: (cap.uncachedStreak || 0) + 1 });
  }
}
