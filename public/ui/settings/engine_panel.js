// Engine panel: inference endpoint, model list and session import.
//
// Contract
//   - `mountEnginePanel(root, options)` owns the Engine tab. Every query is
//     scoped to `root`, which must contain the field markup the panel looks
//     for by id. No globals, no document-level listeners.
//   - Options:
//       getSettings()          -> the current settings object
//       saveSettings(patch)    -> persist a partial settings object
//       fetchModels({endpoint, key}) -> Promise<string[]> of model ids
//       saveSession(rawText)   -> handle the pasted session JSON
//       host                   -> a toast host from createToastHost (optional)
//   - "Forget learned model limits" clears the per-endpoint record the engine
//     builds from what a provider tells it. That record is a set of
//     measurements, and a measurement can be wrong, so the reader needs a way
//     to drop it without clearing storage or changing endpoint.
//   - Returns `{ refresh, destroy }`. `refresh` reloads the fields from
//     `getSettings`; `destroy` removes every listener it added.
//   - Async results are announced through `#popup-engine-status`, which the
//     page marks `role="status"`.
//
// Exports
//   mountEnginePanel(root, options) -> { refresh, destroy }

import { qs, scrollIntoViewRespectingMotion } from "../dom.js";
import { clearModelCapabilities } from "../../browser_engine.js";
import { refreshSession, SESSION_STORAGE_KEY } from "../../session_refresh.js";

const CAPS_STORAGE_KEY = "vibe_rp_model_caps_v1";

const MODEL_PLACEHOLDER = "Select a model after fetching models";
const SAME_AS_MAIN = "Same as main model";

/** Rebuilds a `<select>` from a model list, keeping `selected` if present. */
function fillModels(select, models, selected, { placeholder = MODEL_PLACEHOLDER } = {}) {
  if (!select) return;
  select.innerHTML = "";
  const set = new Set();
  if (selected) set.add(selected);
  for (const m of models || []) {
    const id = typeof m === "string" ? m : m?.id;
    if (id) set.add(id);
  }
  const placeholderOption = document.createElement("option");
  placeholderOption.value = "";
  placeholderOption.textContent = placeholder;
  placeholderOption.selected = !selected;
  select.appendChild(placeholderOption);
  for (const model of set) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    option.selected = model === selected;
    select.appendChild(option);
  }
}

export function mountEnginePanel(root, options = {}) {
  const { getSettings, saveSettings, fetchModels, saveSession, host } = options;
  if (!root) return { refresh: () => {}, destroy: () => {} };

  const endpoint = qs(root, "#popup-api-endpoint");
  const apiKey = qs(root, "#popup-api-key");
  const profileSelect = qs(root, "#popup-profile-select");
  const saveProfileBtn = qs(root, "#popup-save-profile-btn");
  const deleteProfileBtn = qs(root, "#popup-delete-profile-btn");
  const testConnBtn = qs(root, "#popup-test-conn-btn");
  const modelSelect = qs(root, "#popup-model-select");
  const modelInput = qs(root, "#popup-model-input");
  const customModelBtn = qs(root, "#popup-custom-model-btn");
  const choiceSelect = qs(root, "#popup-choice-model-select");
  const choiceInput = qs(root, "#popup-choice-model-input");
  const customChoiceBtn = qs(root, "#popup-custom-choice-model-btn");
  const summarySelect = qs(root, "#popup-summary-model-select");
  const summaryInput = qs(root, "#popup-summary-model-input");
  const customSummaryBtn = qs(root, "#popup-custom-summary-model-btn");
  const reasoningSelect = qs(root, "#popup-reasoning-effort");
  const deliberationSelect = qs(root, "#popup-choice-deliberation");
  const fetchBtn = qs(root, "#popup-fetch-models-btn");
  const saveBtn = qs(root, "#popup-save-engine-btn");
  const forgetLimitsBtn = qs(root, "#popup-forget-limits-btn");
  const learnedLimitsList = qs(root, "#popup-learned-limits-list");
  const sessionWrap = qs(root, "#popup-import-session-wrap");
  const sessionStatus = qs(root, "#popup-session-status");
  const sessionInput = qs(root, "#popup-import-session-input");
  const saveSessionBtn = qs(root, "#popup-save-import-session-btn");
  const refreshSessionBtn = qs(root, "#popup-refresh-session-btn");
  const secretTrigger = qs(root, "#popup-secret-session-trigger");
  const status = qs(root, "#popup-engine-status");

  let destroyed = false;
  const cleanups = [];
  const on = (node, type, handler) => {
    if (!node) return;
    node.addEventListener(type, handler);
    cleanups.push(() => node.removeEventListener(type, handler));
  };

  function announce(message, tone) {
    if (status) status.textContent = message;
    if (tone === "danger") host?.toast?.(message, { tone: "danger" });
  }

  function renderProfiles(settings) {
    if (!profileSelect) return;
    const profiles = Array.isArray(settings.apiProfiles) ? settings.apiProfiles : [];
    const activeId = settings.activeProfileId || "";
    profileSelect.innerHTML = "";
    const defOpt = document.createElement("option");
    defOpt.value = "";
    defOpt.textContent = profiles.length ? "Select saved profile..." : "No saved profiles";
    profileSelect.appendChild(defOpt);
    for (const p of profiles) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name || p.apiEndpoint || p.id;
      opt.selected = p.id === activeId;
      profileSelect.appendChild(opt);
    }
    if (deleteProfileBtn) deleteProfileBtn.disabled = !activeId;
  }

  function renderLearnedCaps() {
    if (!learnedLimitsList) return;
    learnedLimitsList.innerHTML = "";
    try {
      const raw = localStorage.getItem(CAPS_STORAGE_KEY);
      const map = raw ? JSON.parse(raw) : {};
      const entries = Object.entries(map || {});
      if (!entries.length) {
        const empty = document.createElement("p");
        empty.className = "rp-help";
        empty.textContent = "No learned model limits stored yet.";
        learnedLimitsList.appendChild(empty);
        return;
      }
      for (const [key, cap] of entries) {
        const row = document.createElement("p");
        row.className = "rp-help rp-tnum";
        const parts = [key];
        if (cap?.contextWindow) parts.push(`window ${cap.contextWindow}`);
        if (cap?.promptOverheadTokens) parts.push(`overhead ${cap.promptOverheadTokens}`);
        if (cap?.ignoresMaxTokens) parts.push("ignores max_tokens");
        row.textContent = parts.join(" · ");
        learnedLimitsList.appendChild(row);
      }
    } catch { /* ignore invalid JSON */ }
  }

  function renderSessionStatus() {
    if (!sessionStatus) return;
    try {
      const raw = localStorage.getItem(SESSION_STORAGE_KEY);
      if (!raw) {
        sessionStatus.textContent = "No JanitorAI session imported.";
        return;
      }
      const parsed = JSON.parse(raw);
      const exp = parsed?.expiresAt ? new Date(parsed.expiresAt * 1000).toLocaleString() : "unknown expiry";
      const expired = parsed?.expiresAt && parsed.expiresAt * 1000 <= Date.now();
      sessionStatus.textContent = expired ? `JanitorAI session expired (${exp}).` : `JanitorAI session active (expires ${exp}).`;
    } catch {
      sessionStatus.textContent = "Stored JanitorAI session could not be read.";
    }
  }

  function refresh() {
    const settings = getSettings?.() || {};
    if (endpoint) endpoint.value = settings.apiEndpoint || "";
    if (apiKey) apiKey.value = settings.apiKey || "";
    renderProfiles(settings);
    fillModels(modelSelect, settings.availableModels || [], settings.model || "");
    if (modelInput) modelInput.value = settings.model || "";
    fillModels(choiceSelect, settings.availableModels || [], settings.choiceModel || "", {
      placeholder: SAME_AS_MAIN,
    });
    if (choiceInput) choiceInput.value = settings.choiceModel || "";
    fillModels(summarySelect, settings.availableModels || [], settings.summaryModel || "", {
      placeholder: SAME_AS_MAIN,
    });
    if (summaryInput) summaryInput.value = settings.summaryModel || "";
    if (reasoningSelect) reasoningSelect.value = settings.reasoningEffort || "";
    if (deliberationSelect) deliberationSelect.value = settings.choiceDeliberation || "auto";
    renderLearnedCaps();
    renderSessionStatus();
  }

  function bindCustomModelToggle(btn, input, select) {
    if (!btn || !input || !select) return;
    on(btn, "click", () => {
      const isInputActive = !input.hidden;
      if (isInputActive) {
        input.hidden = true;
        select.hidden = false;
        btn.textContent = "Type model";
      } else {
        input.value = select.value || "";
        input.hidden = false;
        select.hidden = true;
        btn.textContent = "Select from list";
        input.focus();
      }
    });

    on(input, "input", () => {
      const val = input.value.trim();
      if (val && select.options) {
        let opt = Array.from(select.options).find((o) => o.value === val);
        if (!opt) {
          opt = document.createElement("option");
          opt.value = val;
          opt.textContent = val;
          select.appendChild(opt);
        }
        select.value = val;
      }
    });
  }

  bindCustomModelToggle(customModelBtn, modelInput, modelSelect);
  bindCustomModelToggle(customChoiceBtn, choiceInput, choiceSelect);
  bindCustomModelToggle(customSummaryBtn, summaryInput, summarySelect);

  on(fetchBtn, "click", async () => {
    if (!fetchBtn) return;
    const original = fetchBtn.textContent;
    fetchBtn.classList.add("is-loading");
    fetchBtn.disabled = true;
    announce("Fetching models.");
    try {
      const models = await fetchModels?.({
        endpoint: endpoint?.value.trim() || undefined,
        key: apiKey?.value.trim() || undefined,
      });
      if (destroyed) return;
      const list = Array.isArray(models) ? models : [];
      saveSettings?.({ availableModels: list });
      const settings = getSettings?.() || {};
      fillModels(modelSelect, list, settings.model || "");
      fillModels(choiceSelect, list, settings.choiceModel || "", {
        placeholder: SAME_AS_MAIN,
      });
      fillModels(summarySelect, list, settings.summaryModel || "", {
        placeholder: SAME_AS_MAIN,
      });
      announce(`Fetched ${list.length} ${list.length === 1 ? "model" : "models"}.`);
    } catch (error) {
      if (destroyed) return;
      announce(`Could not fetch models: ${error.message}`, "danger");
    } finally {
      if (!destroyed) {
        fetchBtn.classList.remove("is-loading");
        fetchBtn.textContent = original;
        fetchBtn.disabled = false;
      }
    }
  });

  on(saveBtn, "click", () => {
    const rawModel = (modelInput && !modelInput.hidden && modelInput.value?.trim())
      ? modelInput.value.trim()
      : (modelSelect?.value ?? "");
    const rawChoice = (choiceInput && !choiceInput.hidden && choiceInput.value?.trim())
      ? choiceInput.value.trim()
      : (choiceSelect?.value ?? "");
    const rawSummary = (summaryInput && !summaryInput.hidden && summaryInput.value?.trim())
      ? summaryInput.value.trim()
      : (summarySelect?.value ?? "");
    saveSettings?.({
      apiEndpoint: endpoint?.value.trim() ?? "",
      apiKey: apiKey?.value.trim() ?? "",
      model: rawModel,
      choiceModel: rawChoice,
      summaryModel: rawSummary,
      reasoningEffort: reasoningSelect?.value ?? "",
      choiceDeliberation: deliberationSelect?.value || "auto",
    });
    announce("Engine settings saved.");
  });

  on(profileSelect, "change", () => {
    const id = profileSelect?.value || "";
    const settings = getSettings?.() || {};
    const profile = (settings.apiProfiles || []).find((p) => p.id === id);
    if (!profile) {
      saveSettings?.({ activeProfileId: "" });
      refresh();
      return;
    }
    saveSettings?.({
      activeProfileId: profile.id,
      apiEndpoint: profile.apiEndpoint || "",
      apiKey: profile.apiKey || "",
      model: profile.model || "",
      choiceModel: profile.choiceModel || "",
      summaryModel: profile.summaryModel || "",
    });
    refresh();
    announce(`Loaded profile "${profile.name || profile.apiEndpoint}".`);
  });

  on(saveProfileBtn, "click", () => {
    const ep = endpoint?.value.trim() || "";
    if (!ep) {
      announce("Enter an API base URL before saving a profile.", "danger");
      return;
    }
    const rawModel = (modelInput && !modelInput.hidden && modelInput.value?.trim())
      ? modelInput.value.trim()
      : (modelSelect?.value ?? "");
    const rawChoice = choiceInput?.value?.trim() || choiceSelect?.value || "";
    const rawSummary = summaryInput?.value?.trim() || summarySelect?.value || "";
    const settings = getSettings?.() || {};
    const profiles = Array.isArray(settings.apiProfiles) ? [...settings.apiProfiles] : [];
    const currentId = profileSelect?.value || "";
    let hostLabel = ep;
    try { hostLabel = new URL(ep).host; } catch { /* keep raw */ }
    const name = rawModel ? `${hostLabel} (${rawModel})` : hostLabel;
    const existingIdx = currentId ? profiles.findIndex((p) => p.id === currentId) : -1;
    const id = existingIdx >= 0 ? currentId : `prof_${Date.now()}`;
    const entry = {
      id,
      name,
      apiEndpoint: ep,
      apiKey: apiKey?.value.trim() ?? "",
      model: rawModel,
      choiceModel: rawChoice,
      summaryModel: rawSummary,
    };
    if (existingIdx >= 0) profiles[existingIdx] = entry;
    else profiles.push(entry);
    saveSettings?.({ apiProfiles: profiles, activeProfileId: id });
    refresh();
    announce(`Saved profile "${name}".`);
  });

  on(deleteProfileBtn, "click", () => {
    const id = profileSelect?.value || "";
    if (!id) return;
    const settings = getSettings?.() || {};
    const profiles = (settings.apiProfiles || []).filter((p) => p.id !== id);
    saveSettings?.({ apiProfiles: profiles, activeProfileId: "" });
    refresh();
    announce("Profile deleted.");
  });

  on(testConnBtn, "click", async () => {
    if (!testConnBtn) return;
    testConnBtn.disabled = true;
    announce("Testing connection...");
    try {
      const models = await fetchModels?.({
        endpoint: endpoint?.value.trim() || undefined,
        key: apiKey?.value.trim() || undefined,
      });
      if (destroyed) return;
      const list = Array.isArray(models) ? models : [];
      announce(`Connection OK — ${list.length} ${list.length === 1 ? "model" : "models"} reachable.`);
    } catch (error) {
      if (destroyed) return;
      announce(`Connection failed: ${error.message}`, "danger");
    } finally {
      if (!destroyed) testConnBtn.disabled = false;
    }
  });

  // Every fact the app learns about an endpoint is a measurement, and a
  // measurement can be wrong: a gateway that answers for several models, a
  // window named in an error that was really about the prompt, a preamble
  // sampled from a response that was not a plain completion. Without a way to
  // drop them, one bad observation would quietly shrink every later request
  // forever, so the record is clearable from where it is created.
  on(forgetLimitsBtn, "click", () => {
    clearModelCapabilities();
    renderLearnedCaps();
    announce("Learned model limits cleared. The next turn measures them again.");
  });

  on(saveSessionBtn, "click", async () => {
    const raw = sessionInput?.value ?? "";
    const result = await saveSession?.(raw);
    if (result?.ok) {
      if (sessionInput) sessionInput.value = "";
      renderSessionStatus();
      announce(result.message || "Session saved.");
    } else if (result?.message) {
      announce(result.message, "danger");
    }
  });

  on(refreshSessionBtn, "click", async () => {
    if (!refreshSessionBtn) return;
    refreshSessionBtn.disabled = true;
    announce("Refreshing session token...");
    try {
      const raw = localStorage.getItem(SESSION_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      const token = parsed ? await refreshSession(parsed, { storageKey: SESSION_STORAGE_KEY }) : null;
      if (destroyed) return;
      renderSessionStatus();
      announce(token ? "Session token refreshed." : "Could not refresh session token.", token ? undefined : "danger");
    } catch (error) {
      if (destroyed) return;
      announce(`Refresh failed: ${error.message}`, "danger");
    } finally {
      if (!destroyed) refreshSessionBtn.disabled = false;
    }
  });

  let secretClicks = 0;
  let lastSecretClick = 0;
  const SECRET_THRESHOLD = 5;
  const RESET_TIMEOUT_MS = 2500;

  function handleSecretTap() {
    if (!sessionWrap || !sessionWrap.hidden) return;
    const now = Date.now();
    if (now - lastSecretClick > RESET_TIMEOUT_MS) {
      secretClicks = 0;
    }
    lastSecretClick = now;
    secretClicks++;
    if (secretClicks >= SECRET_THRESHOLD) {
      sessionWrap.hidden = false;
      scrollIntoViewRespectingMotion(sessionWrap, { behavior: "smooth", block: "nearest" });
      announce("Session import unlocked.");
      secretClicks = 0;
    }
  }

  on(secretTrigger, "click", handleSecretTap);
  on(qs(root, ".rp-settings__footer"), "click", (e) => {
    if (e.target !== saveBtn) {
      handleSecretTap();
    }
  });

  return {
    refresh,
    destroy() {
      destroyed = true;
      for (const off of cleanups) off();
    },
  };
}
