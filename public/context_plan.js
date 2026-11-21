// Pure context planning, token budgeting, and allocation engine (zero DOM).

import { INVISIBLE_RE } from "./text.js";

const tokenCache = new Map();
const BYTE_CACHE_MAX = 4096;
// Bounded by entries AND bytes: entries alone let a few thousand unique
// quarter-megabyte transcripts pin ~1GB. Past the byte ceiling the oldest
// entries go, however few that is.
const BYTE_CACHE_BYTES_MAX = 32 * 1024 * 1024;
let byteCacheBytes = 0;

/**
 * Token estimate: UTF-8 bytes / 4 with safe multilingual calibration.
 * Caches the computed token count directly so repeated measurements on
 * non-ASCII or CJK strings resolve in O(1) without allocating a Uint8Array.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  const str = typeof text === "string" ? text : String(text);
  const cached = tokenCache.get(str);
  if (cached !== undefined) return cached;

  let ascii = 0;
  let cjk = 0;
  let otherMulti = 0;
  const len = str.length;
  for (let i = 0; i < len; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0x7f) ascii++;
    else if (
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      cjk++;
    } else {
      otherMulti++;
    }
  }
  const tokens =
    cjk === 0 && otherMulti === 0
      ? (len + 3) >> 2
      : Math.max(1, Math.ceil(ascii * 0.25 + cjk * 0.95 + otherMulti * 0.55));

  const footprint = len * 2;
  tokenCache.set(str, tokens);
  byteCacheBytes += footprint;
  while (tokenCache.size > BYTE_CACHE_MAX || byteCacheBytes > BYTE_CACHE_BYTES_MAX) {
    const oldest = tokenCache.keys().next();
    if (oldest.done) break;
    const evictedFootprint = oldest.value.length * 2;
    tokenCache.delete(oldest.value);
    byteCacheBytes = Math.max(0, byteCacheBytes - evictedFootprint);
    // Safety valve against a single entry larger than the whole ceiling.
    if (tokenCache.size === 0) break;
  }
  return tokens;
}

/** Tokens for a message array, including per-message framing overhead. */
export function countMessages(messages) {
  let total = 0;
  for (const m of messages || []) {
    if (!m || !m.content) continue;
    total += estimateTokens(m.content) + 4;
  }
  return total;
}

/** Trims zero-width characters, excessive blank lines, and invisible tokens. */
export function cleanPromptText(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(INVISIBLE_RE, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const SUMMARY_MIN_TOKENS = 1536;
export const SUMMARY_DEFAULT_TOKENS = 2048;
export const SUMMARY_MAX_TOKENS = 4096;
export const SUMMARY_REASONING_HEADROOM = 512;
export const SUMMARY_FLOOR_TOKENS = 512;
export const TOKEN_SAFETY_MARGIN = 512;
export const MIN_INPUT_HEADROOM = 512;
export const MIN_OUTPUT_TOKENS = 256;

export function resolveSafetyMargin(contextWindow) {
  const window = Math.max(0, Number(contextWindow) || 0);
  if (window <= 0) return 256;
  return Math.max(256, Math.min(4096, Math.floor(window * 0.02)));
}

export const SUMMARY_TARGET_WORDS = 700;
export const SUMMARY_UPDATE_TARGET_WORDS = 900;
export const LEDGER_OPEN =
  "The story so far, in ledger form. Treat this as settled continuity and build directly on it. " +
  "Each character's knowledge is scoped to what they have witnessed or been told — consult each character's Cast entry before writing them, keeping their actions, references, and reactions within what they know.\n\n<ledger>\n";
export const LEDGER_CLOSE = "\n</ledger>";
export const LEDGER_HARD_MAX_TOKENS = 16384;

/**
 * Neutralises a closing tag inside text that is about to be wrapped in it.
 *
 * Every fenced block the engine builds (the ledger, the summarizer's transcript
 * and prior-ledger, the compressor's ledger) wraps text the engine does not
 * author: a ledger written by the summarizer, a transcript of the model's own
 * replies, or a ledger restored verbatim from an imported backup. The fence is
 * what tells the model where "reference material" stops and "instructions"
 * resume, so a `</ledger>` inside that text closes the block early and whatever
 * follows reads as engine-authored instruction at the same level as the real
 * prompt. That is a persistent injection: a ledger is re-sent every turn, so one
 * successful breakout is permanent.
 *
 * The rule is one home rather than one per call site, because the call sites are
 * exactly where this was missed: only the label was guarded, never the fence.
 * Both the opening and the closing form are neutralised — an embedded `<ledger>`
 * opens a nested block that reads as a second, competing continuity record, and
 * a reader of the payload cannot tell it from the real one.
 *
 * A zero-width space after the `<` keeps the text legible to a reader and the
 * model while making the sequence stop matching the tag.
 */
export function neutralizeFence(text, tag) {
  const str = typeof text === "string" ? text : String(text ?? "");
  if (!str) return "";
  const name = String(tag || "").replace(/[^a-zA-Z0-9-]/g, "");
  if (!name) return str;
  return str.replace(new RegExp(`<\\s*/?\\s*${name}(?:\\s[^>]*)?\\s*/?>`, "gi"), (m) => m.replace("<", "<\u200b"));
}

/** The ledger body, fenced, with any embedded terminator neutralised. */
export function frameLedger(ledger) {
  const body = neutralizeFence(ledger, "ledger");
  return body ? `${LEDGER_OPEN}${body}${LEDGER_CLOSE}` : "";
}

/** Token allowance for the ledger's own framing (the open/close wrapper plus
 * one message's framing overhead). Charged wherever the ledger is measured,
 * so the planner, the truncator and the allocator all count the same bytes. */
export function ledgerFramingTokens() {
  return estimateTokens(LEDGER_OPEN + LEDGER_CLOSE) + 4;
}
function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function snapCodePointBoundary(str, idx) {
  let cut = Math.max(0, Math.min(str.length, idx));
  if (cut > 0 && cut < str.length && isHighSurrogate(str.charCodeAt(cut - 1))) {
    cut -= 1;
  }
  return cut;
}

export function clipLedgerToTokens(text, maxTokens, marker = "\n- [older ledger material omitted at the size ceiling; the full transcript is preserved]") {
  const str = typeof text === "string" ? text : String(text ?? "");
  const limit = Math.max(0, Math.floor(Number(maxTokens) || 0));
  if (!str || limit <= 0) return "";
  if (estimateTokens(str) <= limit) return str;

  const markerStr = typeof marker === "string" ? marker : "";
  const markerTokens = markerStr ? estimateTokens(markerStr) : 0;
  const useMarker = markerStr && markerTokens < limit;
  const suffix = useMarker ? markerStr : "";

  let lo = 0;
  let hi = str.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cut = snapCodePointBoundary(str, mid);
    const candidate = `${str.slice(0, cut)}${suffix}`;
    if (estimateTokens(candidate) <= limit) {
      best = cut;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  let kept = str.slice(0, best);
  const nl = kept.lastIndexOf("\n");
  const sp = kept.lastIndexOf(" ");
  const boundary = nl > kept.length * 0.5 ? nl : sp > kept.length * 0.5 ? sp : -1;
  if (boundary > 0) kept = kept.slice(0, snapCodePointBoundary(kept, boundary));
  return `${kept}${suffix}`;
}

function scaleSummaryBudget(workload) {
  if (!(workload > 0)) return SUMMARY_MIN_TOKENS;
  if (workload < SUMMARY_DEFAULT_TOKENS) {
    const t = workload / SUMMARY_DEFAULT_TOKENS;
    return Math.round(SUMMARY_MIN_TOKENS + (SUMMARY_DEFAULT_TOKENS - SUMMARY_MIN_TOKENS) * t);
  }
  const t = Math.min(1, (workload - SUMMARY_DEFAULT_TOKENS) / SUMMARY_DEFAULT_TOKENS);
  return Math.round(SUMMARY_DEFAULT_TOKENS + (SUMMARY_MAX_TOKENS - SUMMARY_DEFAULT_TOKENS) * t);
}

export function resolveSummaryBudget({
  transcriptTokens = 0,
  ledgerTokens = 0,
  promptTokens = 0,
  overheadTokens = 0,
  contextWindow = 0,
  hasPriorLedger = false,
  extraTokens = 0,
} = {}) {
  const transcript = Math.max(0, Number(transcriptTokens) || 0);
  const ledger = Math.max(0, Number(ledgerTokens) || 0);
  const overhead = Math.max(0, Number(promptTokens) || 0) + Math.max(0, Number(overheadTokens) || 0);
  const workload = transcript + Math.floor(ledger * 0.5);
  let budget = scaleSummaryBudget(workload) + Math.max(0, Number(extraTokens) || 0);
  if (hasPriorLedger) budget = Math.min(SUMMARY_MAX_TOKENS, budget + SUMMARY_REASONING_HEADROOM);
  const window = Math.max(0, Number(contextWindow) || 0);
  if (window > 0) {
    const margin = Math.max(TOKEN_SAFETY_MARGIN, resolveSafetyMargin(window));
    const headroom = window - (overhead + transcript + ledger) - margin;
    budget = Math.max(SUMMARY_FLOOR_TOKENS, Math.min(budget, headroom));
  }
  return Math.max(SUMMARY_FLOOR_TOKENS, Math.min(SUMMARY_MAX_TOKENS, budget));
}

export function fitFoldLedgerTokens({ contextWindow = 0, promptTokens = 0, overheadTokens = 0, transcriptTokens = 0, ledgerTokens = 0 } = {}) {
  const window = Math.max(0, Number(contextWindow) || 0);
  const ledger = Math.max(0, Number(ledgerTokens) || 0);
  if (window <= 0 || ledger <= 0) return ledger;
  const overhead = Math.max(0, Number(promptTokens) || 0) + Math.max(0, Number(overheadTokens) || 0);
  const transcript = Math.max(0, Number(transcriptTokens) || 0);
  const margin = Math.max(TOKEN_SAFETY_MARGIN, resolveSafetyMargin(window));
  const forLedger = window - overhead - transcript - SUMMARY_FLOOR_TOKENS - margin;
  if (forLedger >= ledger) return ledger;
  return Math.max(0, forLedger);
}

export function resolveContextBudgets(settings = {}) {
  const contextWindow = Math.max(2048, Number(settings.maxContextTokens) || 16384);
  const maxOutput = Math.max(MIN_OUTPUT_TOKENS, Number(settings.maxTokens) || 1200);
  const safetyMargin = resolveSafetyMargin(contextWindow);
  const reservedOutput = Math.max(
    MIN_OUTPUT_TOKENS,
    Math.min(maxOutput, contextWindow - safetyMargin - MIN_INPUT_HEADROOM)
  );
  const promptBudget = Math.max(512, contextWindow - reservedOutput - safetyMargin);
  const loreBudget = Math.min(4000, Math.max(512, Math.floor(promptBudget * 0.12)));
  const fallbackMaxChars = Math.min(16000, Math.max(1200, Math.floor(promptBudget * 3.5)));
  return {
    contextWindow,
    maxOutput,
    reservedOutput,
    safetyMargin,
    promptBudget,
    loreBudget,
    fallbackMaxChars,
  };
}

export function allocateContext({
  contextWindow = 0,
  desiredOutput = MIN_OUTPUT_TOKENS,
  safetyMargin = 0,
  minOutput = MIN_OUTPUT_TOKENS,
  requiredTokens = 0,
  optionalItems = [],
  optionalBudgetTokens = null,
} = {}) {
  const window = Math.max(0, Number(contextWindow) || 0);
  const margin = Math.max(0, Number(safetyMargin) || 0);
  const floor = Math.max(1, Number(minOutput) || MIN_OUTPUT_TOKENS);
  const desired = Math.max(floor, Number(desiredOutput) || floor);
  const required = Math.max(0, Number(requiredTokens) || 0);

  const outputCeiling = window - margin - required;
  const output = Math.max(floor, Math.min(desired, outputCeiling));
  const inputBudget = Math.max(0, window - margin - output);
  const feasible = required + floor + margin <= window;

  // Degradable sections can be sized against a budget other than the required
  // content. A caller uses this to keep the set — and therefore the shape of the
  // system message — a function of stable inputs rather than of the turn being
  // sent. `null` keeps the historical behaviour.
  const optionalBase =
    optionalBudgetTokens === null ? required : Math.max(0, Number(optionalBudgetTokens) || 0);

  let remaining = Math.max(0, inputBudget - optionalBase);
  const ordered = [...optionalItems].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const included = [];
  const excluded = [];
  for (const item of ordered) {
    const tokens = Math.max(0, Number(item.tokens) || 0);
    if (tokens <= remaining) {
      included.push(item);
      remaining -= tokens;
    } else {
      excluded.push(item);
    }
  }

  const optionalTokens = included.reduce((n, i) => n + Math.max(0, Number(i.tokens) || 0), 0);
  return {
    output,
    inputBudget,
    requiredTokens: required,
    optionalTokens,
    historyBudget: remaining,
    included,
    excluded,
    feasible,
  };
}
