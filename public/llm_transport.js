// LLM HTTP transport, SSE streaming, error parsing, and capability learning (zero DOM).

import {
  countMessages,
  MIN_OUTPUT_TOKENS,
  resolveContextBudgets,
} from "./context_plan.js";
import {
  getModelCapability,
  updateModelCapability,
  effectiveContextWindow,
  detectParameterRejection,
  shouldUseCacheBreakpoints,
  shouldUseJsonResponseFormat,
  withCacheBreakpoints,
  noteObservedReasoning,
  promptCacheKeyFor,
} from "./model_capability.js";

/** Resolves endpoint base URL, model, and Authorization headers. */
export function resolveEndpoint(settings) {
  const rawEp = String(settings?.apiEndpoint || "").trim();
  const model = String(settings?.model || "").trim();
  if (!rawEp || !model) {
    throw new Error("Configure an API base URL and model in Settings before generating a reply.");
  }
  const headers = { "Content-Type": "application/json" };
  if (settings && settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  const base = rawEp.replace(/\/$/, "").replace(/\/chat\/completions$/, "");
  return { base, model, headers };
}

/** Single JSON POST to `/chat/completions`. */
export function postChat(base, headers, body, signal) {
  return fetch(`${base}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
}

/** Normalises a non-2xx HTTP response into a descriptive Error. */
export async function generationHttpError(res) {
  let detail = "";
  try {
    const raw = await res.text();
    if (raw) {
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      const error = parsed?.error ?? parsed;
      detail =
        (typeof error === "string" ? error : error?.message || error?.type || "") ||
        (typeof parsed?.message === "string" ? parsed.message : "");
      if (!detail) detail = raw.slice(0, 300).trim();
    }
  } catch {
    // Preserve HTTP status even if the error body is unreadable.
  }
  const suffix = detail ? `: ${detail}` : "";
  return new Error(`HTTP ${res.status}${suffix}`);
}

/** Normalises a provider error payload inside a 200 body. */
export function providerError(error) {
  const detail = typeof error === "string" ? error : error?.message || error?.type || "unknown provider error";
  const code = typeof error === "object" && error?.code ? ` (code: ${error.code})` : "";
  return new Error(`Provider error: ${detail}${code}`);
}

/** Describes a completion carrying zero visible content. */
export function emptyCompletionError({ finishReason, sawReasoning, sawRefusal, usage }) {
  const detail =
    finishReason === "length"
      ? "the output token limit was reached before any visible text was produced"
      : sawRefusal
        ? "the provider refused the request (refusal signal, no visible reply)"
        : sawReasoning
          ? "the model produced only reasoning/thinking tokens and no visible reply"
          : "the provider returned no message content";
  const completion = usage && typeof usage.completion_tokens === "number" ? ` (completion_tokens: ${usage.completion_tokens})` : "";
  const finish = finishReason ? ` (finish_reason: ${finishReason})` : "";
  return new Error(
    `The model returned an empty reply: ${detail}${finish}${completion}. Retry, or raise the max output tokens for this model.`
  );
}

/** Extracts the provider-reported context window from an overflow error, or null. */
export function providerContextWindow(err) {
  const rawMessage = String(err?.message || "");
  const message = rawMessage.replace(/(\d),(?=\d{3}\b)/g, "$1");
  const overflow = /context[_ ]length|maximum context|context window|too long|too many tokens|exceeds? (?:the )?(?:available )?(?:context|maximum number of tokens)/i.test(message);
  if (!overflow) return null;
  const patterns = [
    /(?:maximum|max)\s+context\s+(?:length|window|size)\s*(?:is|of|:)?\s*\(?(\d{3,9})\)?/i,
    /exceeds?\s+the\s+available\s+context\s+size\s*\(?(\d{3,9})\)?/i,
    /exceeds?\s+the\s+maximum\s+number\s+of\s+tokens\s+allowed\s*\(?(\d{3,9})\)?/i,
    /context\s+(?:length|window|size)\s*(?:is|of|:)?\s*\(?(\d{3,9})\)?/i,
    /\d{3,9}\s*(?:tokens?\s*)?>\s*(\d{3,9})\s*(?:maximum|max)/i,
  ];
  for (const re of patterns) {
    const m = message.match(re);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= 512) return n;
    }
  }
  return null;
}

/** Records rejected optional parameters against `(endpoint, model)`. */
export function learnRejectedParam(endpoint, model, err) {
  const rejection = detectParameterRejection(err);
  if (!rejection) return false;
  const patch = {};
  if (rejection.unsupportedTemp) patch.supportsTemperature = false;
  if (rejection.needsMaxCompletionTokens) patch.tokenKey = "max_completion_tokens";
  if (rejection.needsMaxTokens) patch.tokenKey = "max_tokens";
  if (rejection.unsupportedReasoningEffort) patch.supportsReasoningEffort = false;
  if (rejection.unsupportedStreamOptions) patch.supportsStreamOptions = false;
  if (rejection.unsupportedCacheControl) patch.supportsCacheControl = false;
  if (rejection.unsupportedPromptCacheKey) patch.supportsPromptCacheKey = false;
  if (rejection.unsupportedResponseFormat) patch.supportsResponseFormat = false;
  const entries = Object.entries(patch);
  if (!entries.length) return false;
  const cur = getModelCapability(endpoint, model);
  if (!entries.some(([k, v]) => cur[k] !== v)) return false;
  updateModelCapability(endpoint, model, patch);
  return true;
}

/**
 * Shared POST + multi-step parameter-rejection retry loop used across stream,
 * fold summarization, ledger compression, and Choice Mode generation.
 */
export async function postWithParamRetry({ base, headers, endpoint, model, buildBody, signal, maxRetries = 4 }) {
  let res = await postChat(base, headers, buildBody(0), signal);
  let httpErr = null;
  for (let attempt = 0; !res.ok && attempt < maxRetries; attempt += 1) {
    httpErr = await generationHttpError(res);
    if (!learnRejectedParam(endpoint, model, httpErr)) {
      return { res, error: httpErr };
    }
    res = await postChat(base, headers, buildBody(attempt + 1), signal);
  }
  if (!res.ok) httpErr = await generationHttpError(res);
  return res.ok ? { res, error: null } : { res, error: httpErr };
}

/** Builds a non-streaming auxiliary chat-completions request body. */
export function buildAuxiliaryBody({
  settings = {},
  model = "",
  messages = [],
  outputTokens = 512,
  temperature = null,
  capReasoningLow = false,
  forceReasoningLow = false,
  useCacheBreakpoints = false,
  session = null,
  jsonMode = false,
} = {}) {
  const endpoint = settings?.apiEndpoint || "";
  const effectiveModel = String(model || settings?.model || "").trim();
  const cap = getModelCapability(endpoint, effectiveModel);
  const tokenKey = cap.tokenKey === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens";
  const wireMessages = useCacheBreakpoints && shouldUseCacheBreakpoints({ ...settings, model: effectiveModel }, cap)
    ? withCacheBreakpoints(messages)
    : messages;
  const body = {
    model: effectiveModel,
    messages: wireMessages,
    stream: false,
    [tokenKey]: outputTokens,
  };
  if (session) {
    const cacheKey = promptCacheKeyFor(session, cap);
    if (cacheKey) body.prompt_cache_key = cacheKey;
  }
  if (temperature !== null && cap.supportsTemperature !== false) {
    body.temperature = temperature;
  }
  if ((settings?.reasoningEffort || (forceReasoningLow && cap.observedReasoning)) && cap.supportsReasoningEffort !== false && capReasoningLow) {
    body.reasoning_effort = "low";
  }
  if (jsonMode && shouldUseJsonResponseFormat({ ...settings, model: effectiveModel }, cap)) {
    body.response_format = { type: "json_object" };
  }
  return body;
}

/** Builds the primary streaming completion request body. */
export function buildRequestBody(settings, messages, outputCeiling = null, session = null) {
  const model = String(settings?.model || "").trim();
  const endpoint = settings?.apiEndpoint || "";
  const cap = getModelCapability(endpoint, model);
  const wireMessages = shouldUseCacheBreakpoints(settings, cap) ? withCacheBreakpoints(messages) : messages;
  const body = {
    model,
    messages: wireMessages,
    stream: true,
  };
  const cacheKey = promptCacheKeyFor(session, cap);
  if (cacheKey) body.prompt_cache_key = cacheKey;
  if (cap.supportsStreamOptions !== false) {
    body.stream_options = { include_usage: true };
  }
  if (cap.supportsTemperature !== false) {
    if (typeof settings.temperature === "number") body.temperature = settings.temperature;
    if (typeof settings.topP === "number" && settings.topP < 1) body.top_p = settings.topP;
    if (typeof settings.minP === "number" && settings.minP > 0) body.min_p = settings.minP;
    if (typeof settings.frequencyPenalty === "number" && settings.frequencyPenalty !== 0) {
      body.frequency_penalty = settings.frequencyPenalty;
    }
    if (typeof settings.presencePenalty === "number" && settings.presencePenalty !== 0) {
      body.presence_penalty = settings.presencePenalty;
    }
  }
  if (settings?.reasoningEffort && cap.supportsReasoningEffort !== false) {
    body.reasoning_effort = settings.reasoningEffort;
  }
  if (typeof settings.maxTokens === "number" || typeof outputCeiling === "number") {
    const { reservedOutput, contextWindow, safetyMargin } = resolveContextBudgets({
      ...settings,
      maxContextTokens: effectiveContextWindow(settings),
    });
    const promptTokens = countMessages(messages);
    const headroom = Math.max(MIN_OUTPUT_TOKENS, contextWindow - promptTokens - safetyMargin);
    const ceiling = typeof outputCeiling === "number" ? outputCeiling : reservedOutput;
    const targetTokens = Math.max(MIN_OUTPUT_TOKENS, Math.min(ceiling, headroom));
    if (cap.tokenKey === "max_completion_tokens") {
      body.max_completion_tokens = targetTokens;
    } else {
      body.max_tokens = targetTokens;
    }
  }
  return body;
}

/** Streams one completion over SSE or plain-JSON fallback. */
export async function* streamDirect(settings, messages, onCleanChunk, onUsage, signal, outputCeiling = null, onLengthCut = null, session = null, onReasoning = null) {
  const { base, headers } = resolveEndpoint(settings);
  const endpoint = settings?.apiEndpoint;
  const model = settings?.model;

  const { res, error } = await postWithParamRetry({
    base,
    headers,
    endpoint,
    model,
    signal,
    buildBody: () => buildRequestBody(settings, messages, outputCeiling, session),
  });
  if (!res.ok) throw error;

  const contentType = (res.headers?.get?.("content-type") || "").toLowerCase();
  const isJsonBody = contentType.includes("application/json");

  const decoder = new TextDecoder();
  let buffer = "";
  let rawAccum = "";
  const RAW_ACCUM_LIMIT = 2 * 1024 * 1024;
  let eventDataLines = [];
  let usage = null;
  let finishReason = null;
  let sawReasoning = false;
  let sawReasoningDelta = false;
  let sawRefusal = false;
  let sawEvent = false;
  let sawContent = false;
  let corruptLines = 0;

  const readPayload = (json) => {
    if (json && json.error) throw providerError(json.error);
    if (json && json.usage) usage = json.usage;
    const choice = json?.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta || null;
    const reasoning =
      delta?.reasoning_content ?? delta?.reasoning ?? delta?.thought ??
      choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? null;
    if ((typeof reasoning === "string" && reasoning) || (Array.isArray(reasoning) && reasoning.length)) {
      sawReasoning = true;
      sawReasoningDelta = true;
      if (typeof onReasoning === "function" && typeof reasoning === "string" && reasoning) {
        onReasoning(reasoning);
      }
    }
    const refusal = delta?.refusal ?? choice?.message?.refusal ?? null;
    if (typeof refusal === "string" && refusal) {
      sawReasoning = true;
      sawRefusal = true;
    }
    const text = choice?.delta?.content ?? choice?.message?.content;
    if (typeof text !== "string" || !text) return null;
    return text;
  };

  const dispatchData = (rawPayload) => {
    const payload = rawPayload.trim();
    if (!payload || payload === "[DONE]") return [];
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      corruptLines += 1;
      return [];
    }
    const chunk = readPayload(json);
    return chunk ? [chunk] : [];
  };

  const flushEvent = () => {
    if (!eventDataLines.length) return [];
    const joined = eventDataLines.join("\n");
    eventDataLines = [];
    return dispatchData(joined);
  };

  const consumeLine = (line) => {
    const cleanLine = line.replace(/\r$/, "");
    if (!cleanLine.trim()) {
      return flushEvent();
    }
    if (cleanLine.trimStart().startsWith("data:")) {
      sawEvent = true;
      const dataPart = cleanLine.trimStart().slice(5).replace(/^ /, "");
      if (eventDataLines.length > 0) {
        const prior = eventDataLines.join("\n").trim();
        let priorComplete = prior === "[DONE]";
        if (!priorComplete && prior) {
          try {
            JSON.parse(prior);
            priorComplete = true;
          } catch {
            priorComplete = false;
          }
        }
        if (priorComplete) {
          const flushed = flushEvent();
          eventDataLines.push(dataPart);
          return flushed;
        }
      }
      eventDataLines.push(dataPart);
      return [];
    }
    return [];
  };

  if (!isJsonBody) {
    if (res.body) {
      const reader = res.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const decoded = decoder.decode(value, { stream: true });
          if (!sawEvent && rawAccum.length < RAW_ACCUM_LIMIT) {
            rawAccum += decoded.slice(0, RAW_ACCUM_LIMIT - rawAccum.length);
          }
          buffer += decoded;
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            for (const chunk of consumeLine(line)) {
              sawContent = true;
              if (onCleanChunk) onCleanChunk(chunk);
              yield chunk;
            }
          }
        }
        const tailDecoded = decoder.decode();
        if (tailDecoded) {
          if (!sawEvent && rawAccum.length < RAW_ACCUM_LIMIT) {
            rawAccum += tailDecoded.slice(0, RAW_ACCUM_LIMIT - rawAccum.length);
          }
          buffer += tailDecoded;
        }
      } finally {
        try { await reader.cancel(); } catch {}
        try { reader.releaseLock(); } catch {}
      }
    }
    if (buffer.trim()) {
      for (const chunk of consumeLine(buffer)) {
        sawContent = true;
        if (onCleanChunk) onCleanChunk(chunk);
        yield chunk;
      }
    }
    for (const chunk of flushEvent()) {
      sawContent = true;
      if (onCleanChunk) onCleanChunk(chunk);
      yield chunk;
    }
    const wholeRaw = (!sawEvent && rawAccum.trim()) ? rawAccum : (!sawEvent && buffer.trim()) ? buffer : "";
    if (wholeRaw) {
      let json = null;
      try {
        json = JSON.parse(wholeRaw);
      } catch {
        json = null;
      }
      if (json) {
        const chunk = readPayload(json);
        if (chunk) {
          sawContent = true;
          if (onCleanChunk) onCleanChunk(chunk);
          yield chunk;
        }
      }
    }
  } else {
    const raw = await res.text();
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {
      json = null;
    }
    if (json) {
      const chunk = readPayload(json);
      if (chunk) {
        sawContent = true;
        if (onCleanChunk) onCleanChunk(chunk);
        yield chunk;
      }
    } else {
      for (const line of raw.split("\n")) {
        for (const chunk of consumeLine(line)) {
          sawContent = true;
          if (onCleanChunk) onCleanChunk(chunk);
          yield chunk;
        }
      }
      for (const chunk of flushEvent()) {
        sawContent = true;
        if (onCleanChunk) onCleanChunk(chunk);
        yield chunk;
      }
    }
  }

  if (usage && onUsage) onUsage(usage);
  noteObservedReasoning(endpoint, model, usage, sawReasoningDelta);

  if (sawContent && corruptLines > 0 && onLengthCut) {
    onLengthCut(
      `The provider sent ${corruptLines} unreadable stream fragment${corruptLines === 1 ? "" : "s"} that ${corruptLines === 1 ? "was" : "were"} skipped; the reply may be missing a sentence.`
    );
  }

  if (!sawContent) {
    throw emptyCompletionError({ finishReason, sawReasoning, sawRefusal, usage });
  }
  if (finishReason === "length" && onLengthCut) {
    const completion = usage && typeof usage.completion_tokens === "number"
      ? ` (completion_tokens: ${usage.completion_tokens})`
      : "";
    onLengthCut(`The reply was cut off at the output token limit${completion}. Raise max output tokens for this model to get the full reply.`);
  }
}

function reportedPromptTokens(usage) {
  if (!usage) return null;
  if (typeof usage.prompt_tokens === "number") return usage.prompt_tokens;
  const parts = [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens].filter(
    (n) => typeof n === "number"
  );
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}

function reportedCachedTokens(usage) {
  if (!usage) return null;
  return (
    usage.prompt_tokens_details?.cached_tokens ??
    usage.cache_read_input_tokens ??
    usage.prompt_cache_hit_tokens ??
    usage.total_cached_tokens ??
    null
  );
}

function reportedReasoningTokens(usage) {
  if (!usage) return null;
  const value = usage.completion_tokens_details?.reasoning_tokens;
  return typeof value === "number" ? value : null;
}

/** Reconciles our estimated input volume with the provider's usage report. */
export function describeUsage({ usage, payload = [], outputCeiling = null } = {}) {
  const estimatedInput = countMessages(payload);
  const totalInput = reportedPromptTokens(usage);
  const uncachedInput = typeof usage?.input_tokens === "number" && typeof usage?.prompt_tokens !== "number"
    ? usage.input_tokens : null;
  const cacheWriteTokens = typeof usage?.cache_creation_input_tokens === "number" && typeof usage?.prompt_tokens !== "number"
    ? usage.cache_creation_input_tokens : null;
  const cachedTokens = reportedCachedTokens(usage);
  const completionTokens = typeof usage?.completion_tokens === "number" ? usage.completion_tokens : null;
  const reasoningTokens = reportedReasoningTokens(usage);
  const generated = (completionTokens || 0) + (reasoningTokens || 0);
  const reasoningShare = reasoningTokens === null || generated <= 0 ? null : reasoningTokens / generated;
  const ceilingIgnored =
    typeof outputCeiling === "number" &&
    typeof completionTokens === "number" &&
    completionTokens > Math.max(outputCeiling * 1.05, outputCeiling + 8);
  return {
    estimatedInput,
    totalInput,
    billedInput: totalInput,
    uncachedInput,
    cacheWriteTokens,
    overhead: totalInput === null ? null : totalInput - estimatedInput,
    cachedTokens,
    cacheHitRate: totalInput > 0 && cachedTokens !== null ? cachedTokens / totalInput : null,
    completionTokens,
    reasoningTokens,
    reasoningShare,
    outputCeiling,
    ceilingIgnored,
    reported: Boolean(usage),
  };
}

/** Fetches available model IDs from the OpenAI-compatible `/models` endpoint. */
export async function fetchAvailableModels(endpoint, apiKey) {
  const rawEndpoint = String(endpoint || "").trim();
  if (!rawEndpoint) throw new Error("Enter an API base URL before fetching models.");
  const base = rawEndpoint.replace(/\/$/, "").replace(/\/chat\/completions$/, "");
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${base}/models`, { headers });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const errJson = await res.json();
      if (errJson?.error?.message) detail = `${detail}: ${errJson.error.message}`;
    } catch {}
    throw new Error(detail);
  }
  const data = await res.json();
  return (data.data || []).map((m) => m.id);
}
