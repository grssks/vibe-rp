// Browser-side Chat & Prompt Engine Facade (Pure ES Module, zero DOM).
//
// Preserves one import surface for callers and tests while delegating prompt
// building, HTTP/SSE transport, and ledger compaction to focused submodules.

import { parseChoices, CHOICE_COUNT_DEFAULT } from "./choice_format.js";
import { pruneImpersonation } from "./text.js";
import {
  applyFold,
  noteUsage,
  noteUsageReport,
  markLedgerTruncated,
  setOverflowReported,
  setCondensedReported,
} from "./session_state.js";
export {
  estimateTokens,
  countMessages,
  cleanPromptText,
  SUMMARY_MIN_TOKENS,
  SUMMARY_DEFAULT_TOKENS,
  SUMMARY_MAX_TOKENS,
  SUMMARY_REASONING_HEADROOM,
  SUMMARY_FLOOR_TOKENS,
  TOKEN_SAFETY_MARGIN,
  MIN_INPUT_HEADROOM,
  MIN_OUTPUT_TOKENS,
  resolveSafetyMargin,
  SUMMARY_TARGET_WORDS,
  SUMMARY_UPDATE_TARGET_WORDS,
  LEDGER_OPEN,
  LEDGER_CLOSE,
  LEDGER_HARD_MAX_TOKENS,
  neutralizeFence,
  frameLedger,
  ledgerFramingTokens,
  clipLedgerToTokens,
  resolveSummaryBudget,
  fitFoldLedgerTokens,
  resolveContextBudgets,
  allocateContext,
} from "./context_plan.js";
export {
  analyzeTurnState,
  buildSceneGuidance,
  detectNarration,
  PROSE_TICS,
  SLOP_LEXICON,
  GUIDANCE_MAX_TOKENS,
} from "./prompt_adaptive.js";
import {
  notePromptOverhead,
  updateModelCapability,
  noteContextWindow,
  noteObservedReasoning,
} from "./model_capability.js";
export {
  getModelCapability,
  updateModelCapability,
  notePromptOverhead,
  promptOverheadTokens,
  sessionOverheadTokens,
  promptTokenRatio,
  sessionTokenRatio,
  clearModelCapabilities,
  noteContextWindow,
  effectiveContextWindow,
  detectParameterRejection,
  summaryModelOf,
  shouldUseCacheBreakpoints,
  shouldUseJsonResponseFormat,
  withCacheBreakpoints,
  noteObservedReasoning,
  promptCacheKeyFor,
} from "./model_capability.js";
import {
  hasPersonaContent,
  substituteCardPlaceholders,
  selectLorebookEntries,
  characterIdentity,
  ensembleCast,
  buildSystemSections,
  formatSystemPrompt,
  resolveBudgets,
  assembleMessages,
  planContext,
  planRequest,
  shouldDeliberate,
  planChoiceRequest,
} from "./prompt_builder.js";
export {
  hasPersonaContent,
  substituteCardPlaceholders,
  selectLorebookEntries,
  characterIdentity,
  ensembleCast,
  buildSystemSections,
  shouldDeliberate,
  planChoiceRequest,
};
import {
  resolveEndpoint,
  postWithParamRetry,
  buildAuxiliaryBody,
  buildRequestBody,
  streamDirect,
  describeUsage,
  providerError,
  providerContextWindow,
  fetchAvailableModels,
  extractMessageText,
  hasReasoningField,
} from "./llm_transport.js";
import {
  LEDGER_COMPRESS_TARGET_WORDS,
  LEDGER_COMPRESS_PROMPT,
  SUMMARY_SYSTEM_PROMPT,
  SUMMARY_PROMPT,
  SUMMARY_UPDATE_PROMPT,
  foldLedger,
} from "./ledger_manager.js";
export {
  LEDGER_COMPRESS_TARGET_WORDS,
  LEDGER_COMPRESS_PROMPT,
  SUMMARY_SYSTEM_PROMPT,
  SUMMARY_PROMPT,
  SUMMARY_UPDATE_PROMPT,
};

export class BrowserChatEngine {
  static formatSystemPrompt(card, persona, settings) {
    return formatSystemPrompt(card, persona, settings);
  }

  static resolveBudgets(settings = {}) {
    return resolveBudgets(settings);
  }

  static assembleMessages(arg1, arg2, arg3, arg4) {
    return assembleMessages(arg1, arg2, arg3, arg4);
  }

  static planContext(args) {
    return planContext(args);
  }

  static describeUsage(args) {
    return describeUsage(args);
  }

  static buildRequestBody(settings, messages, outputCeiling = null, session = null) {
    return buildRequestBody(settings, messages, outputCeiling, session);
  }

  static planRequest(args) {
    return planRequest(args);
  }

  static describeRequest({ card, session, settings, persona, agentsContract, draft = "" }) {
    return planRequest({ card, session, settings, persona, agentsContract, draft });
  }

  static planChoiceRequest(args) {
    return planChoiceRequest(args);
  }

  /** Unified RP turn runner: fold-before-drop continuity, stream, overflow recovery, and telemetry. */
  static async streamTurn({ card, session, settings, persona, agentsContract, onChunk, onReasoning = null, onNotice, signal, continueMode = false }) {
    const activePersona = hasPersonaContent(persona) ? persona : null;
    const activeSettings = agentsContract !== undefined ? { ...settings, agentsContract } : settings;
    const budgets = resolveBudgets(activeSettings);
    const all = Array.isArray(session.messages) ? session.messages : [];
    const consumed = Math.max(1, Number(session.consumed) || 1);

    let request = planRequest({ card, session, settings, persona: activePersona, agentsContract, window: budgets.contextWindow, continueMode });
    let ledgerCondensed = request.ledgerCondensed;

    if (request.plan.compacted && request.plan.folded.length > 0) {
      const toFold = all.slice(consumed, request.plan.consumedAfter);
      const result = await foldLedger({
        settings: activeSettings,
        messages: toFold,
        card,
        persona: activePersona,
        previousLedger: session.ledger || "",
        signal,
        session,
      });
      if (applyFold(session, { ledger: result.ledger, consumedAfter: request.plan.consumedAfter })) {
        if (result.degraded && onNotice) onNotice(`Continuity condensed without summarizer: ${result.error}`);
        if (result.truncated) {
          markLedgerTruncated(session);
          if (onNotice) onNotice("Continuity ledger reached its size limit and was compressed; some detail may be condensed.");
        }
        request = planRequest({ card, session, settings, persona: activePersona, agentsContract, window: budgets.contextWindow, continueMode });
        ledgerCondensed = ledgerCondensed || request.ledgerCondensed;
      }
    }

    let overflowNoticedThisTurn = false;
    if (request.impossible) {
      if (setOverflowReported(session, true) && onNotice) {
        onNotice(this.#overflowReport(request, ledgerCondensed));
        overflowNoticedThisTurn = true;
      }
    } else {
      setOverflowReported(session, false);
    }

    let streamedAny = false;
    let lastUsage = null;
    let ceilingSent = null;
    const send = async (req) => {
      const ceiling = typeof activeSettings.maxTokens === "number" ? req.outputTokens : null;
      ceilingSent = ceiling;
      let text = "";
      for await (const chunk of streamDirect(
        activeSettings,
        req.payload,
        onChunk,
        (u) => {
          lastUsage = u;
          noteUsage(session, u);
        },
        signal,
        ceiling,
        onNotice ? (msg) => onNotice(msg) : null,
        session,
        onReasoning
      )) {
        streamedAny = true;
        text += chunk;
      }
      return text;
    };

    let fullText = "";
    try {
      fullText = await send(request);
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
      const realWindow = providerContextWindow(err);
      if (request.impossible && onNotice && !overflowNoticedThisTurn) {
        onNotice(this.#overflowReport(request, ledgerCondensed));
        overflowNoticedThisTurn = true;
      }
      if (streamedAny || realWindow === null || realWindow > budgets.contextWindow) throw err;

      const targetWindow = realWindow < budgets.contextWindow
        ? realWindow
        : Math.max(512, Math.floor(budgets.contextWindow * 0.88));

      if (realWindow < budgets.contextWindow) {
        noteContextWindow(activeSettings.apiEndpoint, activeSettings.model, realWindow);
      }

      request = planRequest({ card, session, settings, persona: activePersona, agentsContract, window: targetWindow, continueMode });
      if (request.plan.compacted && request.plan.folded.length > 0) {
        const refitConsumed = Math.max(1, Number(session.consumed) || 1);
        const toFold = all.slice(refitConsumed, request.plan.consumedAfter);
        const foldRes = await foldLedger({
          settings: { ...activeSettings, maxContextTokens: targetWindow },
          messages: toFold,
          card,
          persona: activePersona,
          previousLedger: session.ledger || "",
          signal,
          session,
        });
        if (applyFold(session, { ledger: foldRes.ledger, consumedAfter: request.plan.consumedAfter })) {
          if (foldRes.degraded && onNotice) onNotice(`Continuity condensed without summarizer: ${foldRes.error}`);
          if (foldRes.truncated) {
            markLedgerTruncated(session);
            if (onNotice) onNotice("Continuity ledger reached its size limit and was compressed; some detail may be condensed.");
          }
          request = planRequest({ card, session, settings, persona: activePersona, agentsContract, window: targetWindow, continueMode });
        }
      }
      ledgerCondensed = ledgerCondensed || request.ledgerCondensed;
      if (onNotice) {
        onNotice(
          realWindow < budgets.contextWindow
            ? `The provider rejected the request for exceeding the model's real context window (~${realWindow} tokens, not the ${budgets.contextWindow} configured). The request was re-fitted to the model's limit and sent again, and the context window is now remembered for this model.`
            : `The request exceeded the provider's token limit and was re-compacted to ~${targetWindow} tokens.`
        );
      }
      try {
        fullText = await send(request);
      } catch (retryErr) {
        if (request.impossible && onNotice) {
          onNotice(this.#overflowReport(request, ledgerCondensed));
        }
        throw retryErr;
      }
    }

    const playerName = activePersona?.name || "";
    const prunedText = pruneImpersonation(fullText, { user: playerName });
    if (prunedText.length < fullText.length) {
      fullText = prunedText;
      if (onNotice) {
        onNotice("Trimmed hallucinated player turn from reply to preserve character agency.");
      }
    }

    const usageReport = describeUsage({
      usage: lastUsage,
      payload: request.payload,
      outputCeiling: ceilingSent,
    });
    if (usageReport.reported) {
      notePromptOverhead(activeSettings.apiEndpoint, activeSettings.model, usageReport.totalInput, usageReport.estimatedInput);
      const learned = {};
      if (usageReport.ceilingIgnored) learned.ignoresMaxTokens = true;
      if (usageReport.cachedTokens !== null && usageReport.cachedTokens > 0) learned.observedCaching = true;
      if (Object.keys(learned).length) {
        updateModelCapability(activeSettings.apiEndpoint, activeSettings.model, learned);
      }
      noteUsageReport(session, usageReport);
    }

    if (request.impossible) {
      if (setOverflowReported(session, true) && onNotice) onNotice(this.#overflowReport(request, ledgerCondensed));
    } else {
      setOverflowReported(session, false);
    }

    if (ledgerCondensed) {
      if (setCondensedReported(session, true) && onNotice) {
        onNotice("The continuity ledger was condensed to fit this request; older ledger detail is omitted from the model's context but the stored ledger and transcript are unchanged. Raise the context window to restore it.");
      }
    } else {
      setCondensedReported(session, false);
    }

    return fullText;
  }

  /** Generates the next player choices for the settled scene (non-streaming auxiliary request). */
  static async generateChoices({
    card = null,
    session = null,
    settings = {},
    persona = null,
    agentsContract,
    count = CHOICE_COUNT_DEFAULT,
    charName = "",
    playerName = "",
    previousChoices = [],
    isRegenerate = false,
    onNotice = null,
    signal,
    intent = "",
  } = {}) {
    const activePersona = hasPersonaContent(persona) ? persona : null;
    const activeSettings = agentsContract !== undefined ? { ...settings, agentsContract } : settings;
    const { base, headers } = resolveEndpoint(activeSettings);

    const choiceModel = String(activeSettings.choiceModel || activeSettings.model || "").trim();
    const endpoint = activeSettings.apiEndpoint || "";
    const planArgs = { card, session, settings: activeSettings, persona: activePersona, count, charName, playerName, previousChoices, intent };
    let request = planChoiceRequest(planArgs);

    const attempt = async (plan, { jsonMode = true } = {}) =>
      postWithParamRetry({
        base,
        headers,
        endpoint,
        model: choiceModel,
        signal,
        buildBody: (retryIndex) => {
          const baseTemp = typeof activeSettings.temperature === "number" ? activeSettings.temperature : 0.8;
          const wanted =
            isRegenerate || (previousChoices && previousChoices.length > 0)
              ? Math.min(1.0, Math.max(0.85, baseTemp + 0.15))
              : Math.min(1.0, baseTemp);
          const temperature = retryIndex === 0 ? wanted : Math.min(wanted, 0.7);
          return buildAuxiliaryBody({
            settings: activeSettings,
            model: choiceModel,
            messages: plan.payload,
            outputTokens: plan.outputTokens,
            temperature,
            capReasoningLow: true,
            forceReasoningLow: true,
            useCacheBreakpoints: plan.sharedPrefix,
            session: plan.sharedPrefix ? session : null,
            jsonMode,
          });
        },
      });

    let { res, error } = await attempt(request);

    if (!res.ok) {
      const realWindow = providerContextWindow(error);
      if (realWindow !== null && realWindow < request.contextWindow) {
        const prevWindow = request.contextWindow;
        noteContextWindow(endpoint, choiceModel, realWindow);
        request = planChoiceRequest({ ...planArgs, window: realWindow });
        ({ res, error } = await attempt(request));
        if (res.ok && onNotice) {
          onNotice(
            `Your provider's window for this model is ~${realWindow} tokens, smaller than the ${prevWindow} configured. The choice menu was re-fitted to it and sent again.`
          );
        }
      }
    }
    if (!res.ok) throw error;

    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (data && data.error) throw providerError(data.error);
    let choiceObj = data?.choices?.[0];
    let msg = choiceObj?.message;
    let raw = extractMessageText(msg?.content);
    let sawReasoning = hasReasoningField(msg);
    noteObservedReasoning(endpoint, choiceModel, data?.usage, sawReasoning);
    let { choices } = parseChoices(raw, { maxChars: Infinity });
    const hitLength = choiceObj?.finish_reason === "length";
    if (choices.length === 0 && sawReasoning && !hitLength) {
      const reasoningRaw = extractMessageText(msg?.reasoning_content || msg?.reasoning || msg?.thought);
      if (reasoningRaw) ({ choices } = parseChoices(reasoningRaw, { maxChars: Infinity }));
    }
    if (choices.length === 0) {
      const needMoreTokens = hitLength || sawReasoning;
      const retryRequest = planChoiceRequest({
        ...planArgs,
        window: request.contextWindow,
        boostOutput: needMoreTokens,
      });
      if (!needMoreTokens || retryRequest.outputTokens >= request.outputTokens) {
        ({ res, error } = await attempt(retryRequest, { jsonMode: hitLength }));
        if (!res.ok) throw error;
        let retryData = null;
        try {
          retryData = await res.json();
        } catch {
          retryData = null;
        }
        if (retryData && retryData.error) throw providerError(retryData.error);
        data = retryData;
        request = retryRequest;
        choiceObj = data?.choices?.[0];
        msg = choiceObj?.message;
        raw = extractMessageText(msg?.content);
        sawReasoning = hasReasoningField(msg);
        noteObservedReasoning(endpoint, choiceModel, data?.usage, sawReasoning);
        ({ choices } = parseChoices(raw, { maxChars: Infinity }));
      }
    }
    if (choices.length === 0 && sawReasoning) {
      const reasoningRaw = extractMessageText(msg?.reasoning_content || msg?.reasoning || msg?.thought);
      if (reasoningRaw) ({ choices } = parseChoices(reasoningRaw, { maxChars: Infinity }));
    }
    return { choices, usage: data?.usage ?? null, request };
  }

  static #overflowReport(request, ledgerCondensed) {
    const { breakdown, contextWindow, inputTokens, outputTokens, overheadTokens = 0 } = request;
    const components = [
      { name: "static preset", tokens: breakdown.requiredStatic + breakdown.optionalStatic + breakdown.persona },
      { name: "continuity ledger", tokens: breakdown.ledger },
      { name: "writing guidance", tokens: breakdown.lore },
      ...(breakdown.history > 0 ? [{ name: "conversation history", tokens: breakdown.history }] : []),
      { name: "current message", tokens: breakdown.currentInput },
      ...(overheadTokens > 0 ? [{ name: "provider preamble", tokens: overheadTokens }] : []),
    ].sort((a, b) => b.tokens - a.tokens);
    const biggest = components[0];
    const ledgerNote = ledgerCondensed ? " (the ledger was condensed for this request; the stored transcript is unchanged)" : "";
    const detail = request.plan.overflow && request.plan.overflowWarning ? `${request.plan.overflowWarning} ` : "";
    const billedInput = inputTokens + overheadTokens;
    return `${detail}The required content (${components.map((c) => `${c.name} ~${c.tokens}`).join(", ")}) exceeds the configured prompt budget: ~${billedInput} input tokens plus a ${outputTokens}-token reply do not fit the ${contextWindow}-token window. The largest component is the ${biggest.name}; raise the context window or shrink it.${ledgerNote}`;
  }

  static async fetchAvailableModels(endpoint, apiKey) {
    return fetchAvailableModels(endpoint, apiKey);
  }
}

/** Manually folds or rebuilds the continuity ledger for `session` up to the recent live tail. */
export async function foldNow({ card, session, settings, persona, agentsContract, rebuild = false, signal, onNotice } = {}) {
  if (!session || !Array.isArray(session.messages)) {
    return { folded: false, ledger: session?.ledger || "", consumed: session?.consumed || 1, degraded: false, truncated: false };
  }
  const activePersona = hasPersonaContent(persona) ? persona : null;
  const activeSettings = agentsContract !== undefined ? { ...settings, agentsContract } : settings;
  const all = session.messages;
  const startIdx = rebuild || !session.ledger ? 1 : Math.max(1, Number(session.consumed) || 1);
  const endIdx = Math.max(startIdx, all.length - 2);
  const toFold = all.slice(startIdx, endIdx);
  if (!toFold.length) {
    return { folded: false, ledger: session.ledger || "", consumed: session.consumed || 1, degraded: false, truncated: false };
  }
  const result = await foldLedger({
    settings: activeSettings,
    messages: toFold,
    card,
    persona: activePersona,
    previousLedger: rebuild ? "" : (session.ledger || ""),
    signal,
    session,
  });
  const applied = applyFold(session, { ledger: result.ledger, consumedAfter: endIdx });
  if (applied) {
    if (result.degraded && onNotice) onNotice(`Continuity condensed without summarizer: ${result.error}`);
    if (result.truncated) {
      markLedgerTruncated(session);
      if (onNotice) onNotice("Continuity ledger reached its size limit and was compressed; some detail may be condensed.");
    }
  }
  return {
    folded: Boolean(applied),
    ledger: session.ledger || "",
    consumed: session.consumed || 1,
    degraded: Boolean(result.degraded),
    truncated: Boolean(result.truncated),
  };
}
