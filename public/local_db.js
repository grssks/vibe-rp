import { invalidateCapabilitiesCache } from "./model_capability.js";

// The default craft directive.
//
// Phrased outcome-first. The earlier version stated most rules as prohibitions
// ("Never...", "Do NOT...", "Non-Negotiable...") under absolutist headings; the
// current vendor guidance is the opposite — tell the model what to do rather
// than what not to do, and drop scaffolding that only older models needed.
//
// Each line covers several rules at once, joined by commas and dashes, because
// the same requirement written across three bulleted clauses costs three times
// the tokens and reads as three demands. Every rule the previous version
// carried is still here; only the voice, the framing, and the density changed.
//
// Where a rule lives is deliberate. The authority order is stated here, once,
// rather than again in a separate precedence section: one rule, one home. The
// reader's *role* is not here at all — it is the persona slot's line, which is
// the only place that can also carry the reader's name and perspective.
export const DEFAULT_AGENTS_CONTRACT = `# AGENTS.md — Author's Craft Directive

Write long-form interactive fiction with the reader, one turn at a time, holding continuity, physical causality, atmosphere, and dramatic momentum.

## 1. The Reader's Turn Is Theirs

- Agency & perception: {{user}}'s actions, dialogue, decisions, and inner life are theirs. Write {{char}}, the rest of the cast, and the world's response from what they witnessed, were told in-scene, or can observe at their location — posture, vocal tone, distance, hesitation — leaving unrevealed backstory and off-screen events unknown until shown on the page.
- Turn shape: continue directly from the last beat, carry {{char}}'s action or speech as far as it naturally goes, and land on the dramatic beat — not on a meta wrap-up question to the reader.
- Authority & language: the User Persona and System Directives govern language, register, and medium; the Character Preset supplies identity. Write narration and dialogue in the active language, vernacular, and script of the reader's turns, Persona, Directives, or scene, using natural spoken phrasing and idiomatic rhythm rather than stiff literal calques.
- Medium & frame: card directives, scenario, and scene prompts set the medium (prose, screenplay, or epistolary). Stay inside the narrative with emotional conflict, sensory realism, and unvarnished completeness; answer bracketed OOC notes — ((...)), [OOC: ...] — briefly in brackets and return to the scene.
- Core & state: {{char}}'s core holds under pressure to agree — disposition, pride, flaws, and competing motives stay anchored to the card — while their state shifts only as concrete events earn it, staying moved once altered.

## 2. Reading & Grounding the Scene

- Simulation & subtext: think from inside {{char}}'s physical position, immediate want, and friction; render the concrete action, timing, or spoken deflection and let the beat land uninterpreted, omitting narrator commentary on what a gesture means or what an emotion feels like in the abstract.
- Asymmetry & cadence: match the reader's density, sentence length, and register, varying clause and paragraph shape to the pulse of the exchange with one concrete, room-specific detail over balanced contrasts or stock idioms. Ease or tighten tension in proportion to their lead, letting scenes breathe before a pivot.
- Blocking & consequence: scale description to the world the reader built, grounding spaces in light, sound, sightlines, distances, and objects in hand while keeping each character's anatomy, sex, stature, and traits faithful to their sheet. Wounds, exhaustion, damaged gear, spent resources, time of day, and commitments persist across turns and shift leverage while side characters keep independent motives.`;

// Lean contract automatically substituted when the default contract is active
// inside a tight (<=4096 token) context window so cards + history still fit.
export const COMPACT_AGENTS_CONTRACT = `# Author's Craft Directive (Compact)

Write interactive fiction one turn at a time with continuity, causality, and momentum.
- Agency & perception: {{user}}'s actions, dialogue, decisions, and inner life are theirs. Write {{char}}, other characters, and the world solely from what they witnessed, were told, or can observe at their location. End on the dramatic beat — not on a meta wrap-up question to the reader.
- Authority & language: User Persona and System Directives govern language, register, and medium; the Character Preset supplies identity. Write narration and dialogue natively in the active language and script established by the reader, Persona, Directives, or scene. Answer bracketed OOC notes briefly in brackets and return.
- Fidelity & craft: {{char}}'s core holds while their state shifts only as events earn it. Think from {{char}}'s immediate want and friction, match the reader's density and register, and render concrete physical blocking, sensory detail, and persistent consequences so beats land uninterpreted.`;

// Universal directive export. In accordance with strictly universal localization,
// all interaction languages and regions are handled inherently at the model behavior
// and processing level without per-language templates.
export const DEFAULT_AGENTS_CONTRACT_ID = DEFAULT_AGENTS_CONTRACT;


export const DEFAULT_SETTINGS = {
  // Inference Endpoint
  apiEndpoint: "",
  apiKey: "",
  model: "",
  availableModels: [], // Cached list from endpoint fetch

  // Core Generation Samplers (Optimized for creative RP prose)
  // Tuned for modern instruct-tuned chat models; adjust if targeting
  // base completions models or reasoning models instead.
  temperature: 0.95, // 0.8-1.1 creative-prose sweet spot; pairs with min_p (when set) as the tail control since top_p is left at provider default
  topP: 1, // omitted from request body (buildRequestBody skips >=1): standard guidance is temperature OR top_p, not both
  minP: 0, // omitted from request body (buildRequestBody skips <=0): some providers silently ignore min_p, so 0 = cross-provider "send provider default"
  frequencyPenalty: 0, // not sent: anti-slop is enforced by the AGENTS contract; penalties degrade instruct-tuned coherence and punish legitimately repeated story vocabulary (names, refrains)
  presencePenalty: 0, // not sent: same rationale as frequencyPenalty
  maxTokens: 1200, // <thought> blocks eat ~200-600 before visible prose; 1200 leaves 600-1000 visible tokens (typical RP reply 300-800) without truncating mid-scene
  // Total request window: input + requested output + a small estimator margin.
  // `maxTokens` is a ceiling, honoured in full whenever the input leaves room
  // for it; the only thing that can shrink it is the need to leave a minimum
  // input floor. There is no fixed-percentage reservation.
  //
  // This is a *guess* at the model's real window, and the app cannot do better
  // than a guess: no OpenAI-compatible endpoint exposes its context size. It is
  // deliberately generous, because a window that is too large keeps the verbatim
  // transcript — which is strictly better continuity than a folded ledger — and
  // costs nothing where the provider caches. The two failure modes are handled
  // elsewhere rather than by shrinking this number:
  //   - too large for the model in use: the provider rejects, the engine reads
  //     the real window out of the error and re-fits, and the value it learned
  //     is persisted, so the mistake happens once per model rather than per turn;
  //   - a provider that adds a hidden preamble: measured per endpoint and
  //     charged against the window, so the budget reflects what is really sent.
  maxContextTokens: 65536,
  // Directives & Block 0 contract
  agentsContract: DEFAULT_AGENTS_CONTRACT,

  // Turn mode: "normal" (freeform author input) or "choice" (interactive choice menu)
  choiceMode: "normal",
  choiceModel: "",
  // The model that performs folds ("" = same as the main model). A fold is
  // extraction over tokens already paid for once — read the transcript, merge it
  // into the ledger — and it writes none of the prose the reader sees. Measured
  // on a real endpoint, one fold generates ~2,200 tokens, ~72% of them invisible
  // reasoning, which makes it about as expensive as a full narrative turn while
  // being a far simpler task. Pointing it at a cheap tier is the largest
  // structural saving available, and empty keeps every existing setup unchanged.
  summaryModel: "",
  // Choice deliberation: "auto" (default) asks the choice model to think the
  // scene through silently only when no reasoning effort is configured, so a
  // reasoning model is not taxed with a manual chain-of-thought instruction.
  // "always" for a weak local model, "never" for the leanest possible request.
  choiceDeliberation: "auto",
  reasoningEffort: "", // optional: "low", "medium", "high", or "" (default/auto)
  apiProfiles: [],
  activeProfileId: "",
};

const DB_NAME = "vibe_rp";
// Every localStorage key this app owns carries this prefix. It is the namespace
// boundary: `snapshot()` exports exactly these, `clearAll()` removes exactly
// these, and `restore()` accepts exactly these. One prefix, one meaning, so the
// export and import paths cannot disagree about what belongs to the app.
const KEY_PREFIX = "vibe_rp_";
// v2 adds the sessions.cardId index (defect 6). The upgrade path below creates
// it in place, so existing databases keep every row.
const DB_VERSION = 2;

/**
 * Rejected when the browser refuses a write for lack of space. Surfacing a
 * typed error turns a silent data loss (or an unbounded hang) into something
 * the caller can catch, report, and recover from.
 */
export class LocalDbQuotaError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "QuotaExceededError";
    this.code = "QUOTA_EXCEEDED";
    this.cause = cause;
  }
}

/**
 * Rejected when an upgrade is blocked by another open connection. Without this,
 * `open()` would simply never settle.
 */
export class LocalDbBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = "LocalDbBlockedError";
    this.code = "BLOCKED";
  }
}
function isStorageQuotaError(err) {
  if (!err) return false;
  return (
    err.name === "QuotaExceededError" ||
    err.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    err.code === 22 ||
    err.code === 1014 ||
    err.number === -2147024882
  );
}

function safeSetLocalStorage(key, val) {
  try {
    localStorage.setItem(key, val);
  } catch (err) {
    if (isStorageQuotaError(err)) {
      throw new LocalDbQuotaError("localStorage quota exceeded", err);
    }
    throw err;
  }
}

function isValidSettingsObject(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  if (obj.apiEndpoint !== undefined && obj.apiEndpoint !== null && obj.apiEndpoint !== "") {
    if (typeof obj.apiEndpoint !== "string") return false;
    try {
      const url = new URL(obj.apiEndpoint);
      if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    } catch (_) {
      return false;
    }
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k in DEFAULT_SETTINGS) {
      const defaultVal = DEFAULT_SETTINGS[k];
      if (defaultVal === null || defaultVal === undefined) continue;
      if (Array.isArray(defaultVal)) {
        if (!Array.isArray(v)) return false;
      } else if (typeof defaultVal === "number") {
        if (typeof v !== "number" || !Number.isFinite(v)) return false;
      } else if (typeof defaultVal === "string") {
        if (typeof v !== "string") return false;
      } else if (typeof defaultVal === "boolean") {
        if (typeof v !== "boolean") return false;
      }
    }
  }
  return true;
}

function isStockPersona(p) {
  if (!p || typeof p !== "object") return false;
  if (p.id !== "persona_default" && p.id !== "default_persona") return false;
  if (p.userModified) return false;
  if (p.name || p.template || p.gender || p.pronouns) return false;
  if (p.avatar && p.avatar !== "U") return false;
  return true;
}

function isStockDirective(d) {
  if (!d || typeof d !== "object") return false;
  if (d.id !== "directive_default" && d.id !== "default_directive") return false;
  if (d.userModified) return false;
  if (d.name && d.name !== "Author's Craft Directive") return false;
  return true;
}

function presetMergeKey(item) {
  if (!item || typeof item !== "object") return "";
  if (item.id === "default_persona" || item.id === "persona_default") return "persona_default";
  if (item.id === "default_directive" || item.id === "directive_default") return "directive_default";
  return typeof item.id === "string" ? item.id : "";
}

function mergePresetLists(existingList, incomingList, isStockFn) {
  const merged = existingList.map((item) => ({ ...item }));
  const existingDefault = existingList.find((item) => item?.isDefault);
  const existingHasNonStockDefault = Boolean(existingDefault && !isStockFn(existingDefault));
  const incomingDefault = incomingList.find((item) => item?.isDefault);
  const incomingDefaultIsStock = !incomingDefault || isStockFn(incomingDefault);

  for (const rawInc of incomingList) {
    if (!rawInc || typeof rawInc !== "object" || Array.isArray(rawInc)) continue;
    const inc = { ...rawInc };
    const incKey = presetMergeKey(inc);
    const idx = incKey ? merged.findIndex((item) => presetMergeKey(item) === incKey) : -1;
    if (idx < 0) {
      merged.push(inc);
      continue;
    }
    const cur = merged[idx];
    const curStock = isStockFn(cur);
    const incStock = isStockFn(inc);
    if (incStock && !curStock) continue;
    if (!incStock && curStock) {
      merged[idx] = inc;
      continue;
    }
    if ((cur.updatedAt || 0) > (inc.updatedAt || 0)) continue;
    merged[idx] = inc;
  }

  if (merged.length > 0) {
    const keepExistingDefaultId = existingHasNonStockDefault && incomingDefaultIsStock ? existingDefault.id : null;
    if (keepExistingDefaultId) {
      for (const item of merged) item.isDefault = item.id === keepExistingDefaultId;
    } else {
      let seenDefault = false;
      for (const item of merged) {
        if (item.isDefault && !seenDefault) {
          seenDefault = true;
        } else {
          item.isDefault = false;
        }
      }
      if (!seenDefault) merged[0].isDefault = true;
    }
  }
  return merged;
}

function mergeSettingsObjects(existing, incoming) {
  const merged = { ...existing };
  const existingProfiles = Array.isArray(existing.apiProfiles) ? existing.apiProfiles : [];
  const incomingProfiles = Array.isArray(incoming.apiProfiles) ? incoming.apiProfiles : [];

  for (const [k, incVal] of Object.entries(incoming)) {
    if (k === "apiProfiles") {
      if (incomingProfiles.length === 0 && existingProfiles.length > 0) continue;
      const byId = new Map();
      for (const p of existingProfiles) {
        if (p && typeof p === "object" && p.id) byId.set(p.id, { ...p });
      }
      for (const p of incomingProfiles) {
        if (p && typeof p === "object" && p.id) {
          byId.set(p.id, { ...(byId.get(p.id) || {}), ...p });
        }
      }
      merged.apiProfiles = Array.from(byId.values());
      continue;
    }
    if (k === "availableModels") {
      if ((!Array.isArray(incVal) || incVal.length === 0) && Array.isArray(existing.availableModels) && existing.availableModels.length > 0) {
        continue;
      }
      merged.availableModels = incVal;
      continue;
    }
    if (k === "activeProfileId") {
      if (!incVal && existing.activeProfileId) continue;
      merged.activeProfileId = incVal;
      continue;
    }
    const curVal = existing[k];
    const defVal = DEFAULT_SETTINGS[k];
    const incIsEmptyOrDefault = incVal === undefined || incVal === null || incVal === "" || incVal === defVal;
    const curIsCustom = curVal !== undefined && curVal !== null && curVal !== "" && curVal !== defVal;
    if (incIsEmptyOrDefault && curIsCustom) continue;
    merged[k] = incVal;
  }
  return merged;
}

function mergeImportSessionJson(existingRaw, incomingRaw) {
  let existing = null;
  let incoming = null;
  try { existing = JSON.parse(existingRaw); } catch (_) {}
  try { incoming = JSON.parse(incomingRaw); } catch (_) {}
  const existingToken = existing && typeof existing === "object" && typeof existing.accessToken === "string" ? existing.accessToken : "";
  const incomingToken = incoming && typeof incoming === "object" && typeof incoming.accessToken === "string" ? incoming.accessToken : "";
  if (existingToken && !incomingToken) return existingRaw;
  if (!existingToken) return incomingRaw;
  const existingExp = Number(existing.expiresAt) || 0;
  const incomingExp = Number(incoming.expiresAt) || 0;
  if (existingExp > incomingExp) return existingRaw;
  return incomingRaw;
}


// Generic presets store (personas and directives; sync via localStorage).
// The card→preset resolution rule (card root, then card.data, then default)
// lives in exactly one place: #presets().resolveForCard.
//
// The default persona is deliberately thin. The previous one restated the
// identity and perception rules the craft contract already states for every
// character — agency, observable demeanour, no access to unspoken thoughts —
// which put two versions of one rule in every request and made the weakest copy
// the one nearest the reader's own turn. What belongs here is only what no
// other slot can say: who the reader is, and the perspective their turn is
// written from. The absence of a name is carried by the empty string, which
// renders as the bare `[User Persona]` label rather than inventing one.
export const PERSONA_PRESETS = {
  key: "vibe_rp_personas",
  prefix: "persona",
  defaultFactory: () => ({
    id: "persona_default",
    name: "",
    avatar: "U",
    description:
      "The viewpoint protagonist: the reader's own character, present in the scene and perceiving it from their own narrative distance. Match the point of view, pronouns, language, and register established in the reader's turns, custom persona, and the scene.",
    isDefault: true,
  }),
  cardField: "userPersonaId",
  dataField: "userPersonaId",
};

// Built-in craft contract directive: strictly universal architecture with zero
// per-language templates. Adapts inherently to any language, dialect, or region
// at the model behavior level.
const DIRECTIVE_PRESETS = {
  key: "vibe_rp_directives",
  prefix: "directive",
  builtins: () => [
    {
      id: "directive_default",
      name: "Author's Craft Directive",
      description: "Canonical AGENTS.md contract with universal sensory grounding, momentum, and anti-cliche rules.",
      content: DEFAULT_AGENTS_CONTRACT,
      isDefault: true,
      builtin: true,
      updatedAt: Date.now(),
    },
  ],
  defaultFactory: () => ({
    id: "directive_default",
    name: "Author's Craft Directive",
    description: "Canonical AGENTS.md contract with universal sensory grounding, momentum, and anti-cliche rules.",
    content: DEFAULT_AGENTS_CONTRACT,
    isDefault: true,
    builtin: true,
    updatedAt: Date.now(),
  }),
  cardField: "directivePresetId",
  dataField: "directivePresetId",
};


// ---------------------------------------------------------------------------
// Backend: IndexedDB (cards and sessions)
// ---------------------------------------------------------------------------

/**
 * Owns the IndexedDB connection cache and every card/session transaction. The
 * connection is cached on the instance, so an injected store carries its own
 * handle instead of sharing one global. Storage failures are normalised into
 * typed errors callers can branch on.
 */
class IdbStore {
  db = null;
  #openPromise = null;

  async open() {
    if (this.db) return this.db;
    if (this.#openPromise) return this.#openPromise;
    if (typeof indexedDB === "undefined") {
      throw new Error("IndexedDB is not supported in this environment");
    }
    this.#openPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("cards")) {
          db.createObjectStore("cards", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("sessions")) {
          db.createObjectStore("sessions", { keyPath: "id" });
        }
        // Index upgrade for existing v1 databases: create the cardId index in
        // place. IndexedDB runs this inside the version-change transaction, so
        // no existing session row is touched (defect 6, no data loss).
        const sessions = e.target.transaction.objectStore("sessions");
        if (!sessions.indexNames.contains("cardId")) {
          sessions.createIndex("cardId", "cardId", { unique: false });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          if (this.db === db) this.db = null;
        };
        db.onclose = () => {
          if (this.db === db) this.db = null;
        };
        this.db = db;
        this.#openPromise = null;
        if (typeof navigator !== "undefined" && navigator?.storage?.persist) {
          try { navigator.storage.persist().catch(() => {}); } catch {}
        }
        resolve(db);
      };
      req.onerror = () => {
        this.#openPromise = null;
        reject(IdbStore.#wrapStorageError(req.error, "open"));
      };
      // Another tab holds an older version open: without this handler the
      // promise would never settle. Surface it so the UI can ask the user to
      // close the other tab instead of hanging (defect 7).
      req.onblocked = () => {
        this.#openPromise = null;
        reject(new LocalDbBlockedError("Database upgrade blocked by another open tab or window."));
      };
    });
    return this.#openPromise;
  }

  /** Normalises IndexedDB failures into typed errors callers can branch on. */
  static #wrapStorageError(err, context) {
    const name = err && err.name;
    if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") {
      return new LocalDbQuotaError(`Storage quota exceeded during ${context}.`, err);
    }
    return err || new Error(`IndexedDB failure during ${context}.`);
  }

  async getAllCards() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("cards", "readonly");
      const req = tx.objectStore("cards").getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(IdbStore.#wrapStorageError(req.error, "getAllCards"));
    });
  }

  async saveCard(card) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("cards", "readwrite");
      tx.objectStore("cards").put(card);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(IdbStore.#wrapStorageError(tx.error, "saveCard"));
      tx.onabort = () => reject(IdbStore.#wrapStorageError(tx.error, "saveCard"));
    });
  }

  async saveSession(session) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readwrite");
      tx.objectStore("sessions").put(session);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(IdbStore.#wrapStorageError(tx.error, "saveSession"));
      tx.onabort = () => reject(IdbStore.#wrapStorageError(tx.error, "saveSession"));
    });
  }

  async getSessionsForCard(characterId) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readonly");
      // Served by the cardId index: one indexed lookup instead of a full-store
      // scan per card (defect 6).
      const req = tx.objectStore("sessions").index("cardId").getAll(characterId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(IdbStore.#wrapStorageError(req.error, "getSessionsForCard"));
    });
  }

  async getAllSessions() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readonly");
      const req = tx.objectStore("sessions").getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(IdbStore.#wrapStorageError(req.error, "getAllSessions"));
    });
  }

  async countSessions() {
    const db = await this.open();
    return new Promise((resolve) => {
      try {
        const tx = db.transaction("sessions", "readonly");
        const store = tx.objectStore("sessions");
        if (typeof store.count === "function") {
          const req = store.count();
          req.onsuccess = () => resolve(req.result || 0);
          req.onerror = () => resolve(0);
        } else {
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result?.length || 0);
          req.onerror = () => resolve(0);
        }
      } catch (_) {
        resolve(0);
      }
    });
  }

  async deleteSession(sessionId) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readwrite");
      tx.objectStore("sessions").delete(sessionId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(IdbStore.#wrapStorageError(tx.error, "deleteSession"));
      tx.onabort = () => reject(IdbStore.#wrapStorageError(tx.error, "deleteSession"));
    });
  }

  async deleteCard(cardId) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      // Card and its sessions share one transaction: the fan-out delete either
      // commits entirely or not at all, so no orphaned sessions survive a
      // failure (defect 6).
      const tx = db.transaction(["cards", "sessions"], "readwrite");
      tx.objectStore("cards").delete(cardId);
      const sessionStore = tx.objectStore("sessions");
      const req = sessionStore.index("cardId").getAllKeys(cardId);
      req.onsuccess = () => {
        for (const key of req.result || []) sessionStore.delete(key);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(IdbStore.#wrapStorageError(tx.error, "deleteCard"));
      tx.onabort = () => reject(IdbStore.#wrapStorageError(tx.error, "deleteCard"));
    });
  }

  async clearAllSessions() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readwrite");
      tx.objectStore("sessions").clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(IdbStore.#wrapStorageError(tx.error, "clearAllSessions"));
      tx.onabort = () => reject(IdbStore.#wrapStorageError(tx.error, "clearAllSessions"));
    });
  }

  async clearAllCards() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["cards", "sessions"], "readwrite");
      tx.objectStore("cards").clear();
      tx.objectStore("sessions").clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(IdbStore.#wrapStorageError(tx.error, "clearAllCards"));
      tx.onabort = () => reject(IdbStore.#wrapStorageError(tx.error, "clearAllCards"));
    });
  }

  /** Bulk write of a backup's rows; `replace` clears both stores first. */
  async importRows({ cards, sessions, mode = "merge" }) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["cards", "sessions"], "readwrite");
      const cardStore = tx.objectStore("cards");
      const sessionStore = tx.objectStore("sessions");

      if (mode === "replace") {
        cardStore.clear();
        sessionStore.clear();
        for (const card of cards) {
          if (card && card.id) cardStore.put(card);
        }
        for (const session of sessions) {
          if (session && session.id) sessionStore.put(session);
        }
      } else {
        const cardsReq = cardStore.getAll();
        const sessionsReq = sessionStore.getAll();
        let curCards = null;
        let curSessions = null;

        const applyMerge = () => {
          if (curCards === null || curSessions === null) return;
          const existingCards = new Map(curCards.map((c) => [c.id, c]));
          const existingSessions = new Map(curSessions.map((s) => [s.id, s]));

          for (const card of cards) {
            if (!card || !card.id) continue;
            const cur = existingCards.get(card.id);
            if (cur) {
              const incIsUnmodifiedSample = card.sample === true && !card.userModified;
              const curIsCustomized = !cur.sample || Boolean(cur.userModified) || Boolean(cur.favorite);
              if (incIsUnmodifiedSample && (curIsCustomized || (cur.updatedAt || 0) >= (card.updatedAt || 0))) {
                continue;
              }
              if ((cur.updatedAt || 0) > (card.updatedAt || 0)) {
                continue;
              }
            }
            cardStore.put(card);
          }

          for (const session of sessions) {
            if (!session || !session.id) continue;
            const cur = existingSessions.get(session.id);
            if (cur) {
              const curLen = Array.isArray(cur.messages) ? cur.messages.length : 0;
              const incLen = Array.isArray(session.messages) ? session.messages.length : 0;
              const curUpdated = cur.updatedAt || 0;
              const incUpdated = session.updatedAt || 0;
              if ((curLen > incLen && curUpdated >= incUpdated) || (curUpdated > incUpdated && curLen >= incLen)) {
                continue;
              }
            }
            sessionStore.put(session);
          }
        };

        cardsReq.onsuccess = () => {
          curCards = Array.isArray(cardsReq.result) ? cardsReq.result : [];
          applyMerge();
        };
        sessionsReq.onsuccess = () => {
          curSessions = Array.isArray(sessionsReq.result) ? sessionsReq.result : [];
          applyMerge();
        };
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(IdbStore.#wrapStorageError(tx.error, "importRows"));
      tx.onabort = () => reject(IdbStore.#wrapStorageError(tx.error, "importRows"));
    });
  }
}

// ---------------------------------------------------------------------------
// Backend: localStorage (presets, settings, import-session cache)
// ---------------------------------------------------------------------------

/**
 * Owns every synchronous key-value concern: the persona/directive preset
 * stores (seeded on first read) and the settings blob. Kept apart from
 * IdbStore because the two have nothing in common but a name — one is async
 * and transactional, the other is a synchronous string map.
 */
class LocalStore {
  #presetStores = new Map();

  /**
   * A preset store over one localStorage key. `cardField`/`dataField` name the
   * card fields that point at a preset id; the resolution rule (card root,
   * then card.data, then default) lives here and only here.
   */
  presets(spec) {
    const existing = this.#presetStores.get(spec.key);
    if (existing) return existing;
    const { key, prefix, defaultFactory, cardField, dataField, builtins } = spec;
    // A store may ship more than one built-in. `defaultFactory()` stays the
    // single-object answer everywhere else; `seed()` is the only place that
    // needs the plural, so the plural lives here and nowhere else.
    const seed = () => (builtins ? builtins() : [defaultFactory()]);
    const read = () => {
      try {
        const raw = localStorage.getItem(key);
        if (raw) {
          const list = JSON.parse(raw);
          if (Array.isArray(list) && list.length > 0) {
            const def = defaultFactory();
            let synced = false;
            for (const item of list) {
              if (item && item.id === def.id && !item.userModified) {
                if (typeof def.content === "string" && item.content !== def.content) {
                  item.content = def.content;
                  synced = true;
                }
                if (typeof def.description === "string" && !item.name && item.description !== def.description) {
                  item.description = def.description;
                  synced = true;
                }
              }
            }
            if (synced) safeSetLocalStorage(key, JSON.stringify(list));
            return list;
          }
        }
      } catch (_) {}
      const fresh = seed();
      safeSetLocalStorage(key, JSON.stringify(fresh));
      return fresh;
    };
    const store = {
      async list() {
        return read();
      },
      async get(id) {
        if (!id) return null;
        return read().find((p) => p.id === id) || null;
      },
      async save(preset) {
        const items = read();
        if (!preset.id) preset.id = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        preset.updatedAt = Date.now();
        preset.userModified = true;
        const idx = items.findIndex((p) => p.id === preset.id);
        if (idx >= 0) items[idx] = preset;
        else items.push(preset);
        safeSetLocalStorage(key, JSON.stringify(items));
        return preset;
      },
      async remove(id) {
        const remaining = read().filter((p) => p.id !== id);
        if (remaining.length > 0 && !remaining.some((p) => p.isDefault === true)) {
          remaining[0].isDefault = true;
        }
        safeSetLocalStorage(key, JSON.stringify(remaining));
      },
      async setDefault(id) {
        const items = read();
        for (const p of items) p.isDefault = p.id === id;
        safeSetLocalStorage(key, JSON.stringify(items));
      },
      async getDefault() {
        const items = read();
        return items.find((p) => p.isDefault) || items[0] || defaultFactory();
      },
      async resolveForCard(card, session = null) {
        const sessionId = session?.[cardField];
        if (sessionId) {
          const preset = await this.get(sessionId);
          if (preset) return preset;
        }
        const id = card?.[cardField] || card?.data?.[dataField];
        if (id) {
          const preset = await this.get(id);
          if (preset) return preset;
        }
        return this.getDefault();
      },
    };
    this.#presetStores.set(key, store);
    return store;
  }

  getSettings() {
    try {
      const raw = localStorage.getItem("vibe_rp_settings");
      if (raw) {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
      }
    } catch (_) {}
    return { ...DEFAULT_SETTINGS };
  }

  saveSettings(settings) {
    safeSetLocalStorage("vibe_rp_settings", JSON.stringify(settings));
  }

  resetSettings() {
    localStorage.removeItem("vibe_rp_settings");
    return { ...DEFAULT_SETTINGS };
  }

  clearImportSession() {
    try {
      localStorage.removeItem("vibe_rp_import_session");
      localStorage.removeItem("vibe_rp_import_session_refresh_lock");
    } catch (_) {}
  }

  /** Re-seeds a preset store from its default factory (or its built-in set). */
  resetPresets({ key, defaultFactory, builtins }) {
    const fresh = builtins ? builtins() : [defaultFactory()];
    safeSetLocalStorage(key, JSON.stringify(fresh));
    return fresh;
  }

  /** Every vibe_rp* key currently stored, for export and replace-import. */
  snapshot() {
    const out = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(KEY_PREFIX)) out[k] = localStorage.getItem(k);
      }
    } catch (_) {}
    return out;
  }

  /** Removes every vibe_rp* key. */
  clearAll() {
    try {
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(KEY_PREFIX)) keysToRemove.push(k);
      }
      for (const k of keysToRemove) localStorage.removeItem(k);
    } catch (_) {}
  }

  /**
   * Writes a backup's key/value map back, returning how many keys landed.
   *
   * Only this app's own namespace is accepted, mirroring `snapshot()`. A backup
   * file is untrusted input (the reader was handed it, or downloaded it from a
   * stranger), and without the filter a crafted one writes ARBITRARY keys into
   * the origin's localStorage — including keys belonging to whatever else is
   * served from the same origin. `snapshot()` already decides what this app
   * owns; the restore path has to agree with it, or the two disagree about the
   * same namespace.
   *
   * The values stay raw: a backup legitimately carries an opaque settings blob
   * and preset lists, and re-validating their shapes here would duplicate rules
   * the readers of those keys already own. The key set is the boundary.
   */
  restore(map, { mode = "merge" } = {}) {
    let count = 0;
    if (map && typeof map === "object") {
      try {
        for (const [k, v] of Object.entries(map)) {
          if (typeof k !== "string" || !k.startsWith(KEY_PREFIX)) continue;
          if (typeof v !== "string") continue;
          let valueToWrite = v;

          if (k === "vibe_rp_settings") {
            try {
              const parsed = JSON.parse(v);
              if (!isValidSettingsObject(parsed)) continue;
              if (mode === "merge") {
                const curRaw = localStorage.getItem(k);
                if (curRaw) {
                  try {
                    const curParsed = JSON.parse(curRaw);
                    if (isValidSettingsObject(curParsed)) {
                      valueToWrite = JSON.stringify(mergeSettingsObjects(curParsed, parsed));
                    }
                  } catch (_) {}
                }
              }
            } catch (_) {
              continue;
            }
          } else if (k === "vibe_rp_personas" || k === "vibe_rp_directives") {
            try {
              const parsed = JSON.parse(v);
              if (!Array.isArray(parsed) || !parsed.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
                continue;
              }
              if (mode === "merge") {
                const curRaw = localStorage.getItem(k);
                if (curRaw) {
                  try {
                    const curParsed = JSON.parse(curRaw);
                    if (Array.isArray(curParsed) && curParsed.length > 0) {
                      const isStockFn = k === "vibe_rp_personas" ? isStockPersona : isStockDirective;
                      valueToWrite = JSON.stringify(mergePresetLists(curParsed, parsed, isStockFn));
                    }
                  } catch (_) {}
                }
              }
            } catch (_) {
              continue;
            }
          } else if (k === "vibe_rp_model_caps_v1" && mode === "merge") {
            const curRaw = localStorage.getItem(k);
            if (curRaw) {
              try {
                const curParsed = JSON.parse(curRaw);
                const incParsed = JSON.parse(v);
                if (curParsed && typeof curParsed === "object" && !Array.isArray(curParsed) && incParsed && typeof incParsed === "object" && !Array.isArray(incParsed)) {
                  valueToWrite = JSON.stringify({ ...curParsed, ...incParsed });
                }
              } catch (_) {}
            }
          } else if (k === "vibe_rp_import_session" && mode === "merge") {
            const curRaw = localStorage.getItem(k);
            if (curRaw) {
              valueToWrite = mergeImportSessionJson(curRaw, v);
            }
          } else if (mode === "merge" && (k === "vibe_rp_theme" || k.startsWith("vibe_rp_draft_"))) {
            const curRaw = localStorage.getItem(k);
            if (curRaw) {
              valueToWrite = curRaw;
            }
          }

          try {
            localStorage.setItem(k, valueToWrite);
            count++;
          } catch (err) {
            if (isStorageQuotaError(err)) {
              throw new LocalDbQuotaError("localStorage quota exceeded during restore", err);
            }
            throw err;
          }
        }
      } catch (err) {
        if (err instanceof LocalDbQuotaError) throw err;
      }
    }
    if (count > 0) invalidateCapabilitiesCache();
    return count;
  }
}

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

/**
 * The storage seam. An instance holds the two backends it talks to, so a
 * caller can construct one with injected stores (a fake IndexedDB, an
 * in-memory key-value map) instead of reaching for module globals. The static
 * surface delegates to a shared default instance, so every existing call site
 * keeps working unchanged while the migration to instances is incremental.
 */
export class LocalDb {
  static #defaultInstance = new LocalDb();

  constructor({ idb = new IdbStore(), local = new LocalStore() } = {}) {
    this.idb = idb;
    this.local = local;
  }

  // --- instance surface (the injectable seam) ---

  get db() {
    return this.idb.db;
  }

  set db(value) {
    this.idb.db = value;
  }

  open() {
    return this.idb.open();
  }

  getAllCards() { return this.idb.getAllCards(); }
  saveCard(card) { return this.idb.saveCard(card); }
  saveSession(session) { return this.idb.saveSession(session); }
  getSessionsForCard(characterId) { return this.idb.getSessionsForCard(characterId); }
  getAllSessions() { return this.idb.getAllSessions(); }
  deleteSession(sessionId) { return this.idb.deleteSession(sessionId); }
  deleteCard(cardId) { return this.idb.deleteCard(cardId); }
  clearAllSessions() { return this.idb.clearAllSessions(); }
  clearAllCards() { return this.idb.clearAllCards(); }

  getAllPersonas() { return this.local.presets(PERSONA_PRESETS).list(); }
  getPersona(id) { return this.local.presets(PERSONA_PRESETS).get(id); }
  savePersona(p) { return this.local.presets(PERSONA_PRESETS).save(p); }
  deletePersona(id) { return this.local.presets(PERSONA_PRESETS).remove(id); }
  getDefaultPersona() { return this.local.presets(PERSONA_PRESETS).getDefault(); }
  setDefaultPersona(id) { return this.local.presets(PERSONA_PRESETS).setDefault(id); }
  resolvePersonaForCard(card, session = null) { return this.local.presets(PERSONA_PRESETS).resolveForCard(card, session); }

  getAllDirectives() { return this.local.presets(DIRECTIVE_PRESETS).list(); }
  getDirective(id) { return this.local.presets(DIRECTIVE_PRESETS).get(id); }
  saveDirective(d) { return this.local.presets(DIRECTIVE_PRESETS).save(d); }
  deleteDirective(id) { return this.local.presets(DIRECTIVE_PRESETS).remove(id); }
  getDefaultDirective() { return this.local.presets(DIRECTIVE_PRESETS).getDefault(); }
  setDefaultDirective(id) { return this.local.presets(DIRECTIVE_PRESETS).setDefault(id); }
  resolveDirectiveForCard(card, session = null) { return this.local.presets(DIRECTIVE_PRESETS).resolveForCard(card, session); }

  getSettings() { return this.local.getSettings(); }
  saveSettings(settings) { return this.local.saveSettings(settings); }
  resetSettings() { return this.local.resetSettings(); }

  resetPersonas() { return this.local.resetPresets(PERSONA_PRESETS); }
  resetDirectives() { return this.local.resetPresets(DIRECTIVE_PRESETS); }
  clearImportSession() { return this.local.clearImportSession(); }

  async wipeAllData({ resetCache = false } = {}) {
    await this.idb.clearAllCards();
    this.local.clearAll();
    this.local.resetPresets(PERSONA_PRESETS);
    this.local.resetPresets(DIRECTIVE_PRESETS);
    this.local.resetSettings();
    invalidateCapabilitiesCache();

    if (typeof sessionStorage !== "undefined") {
      try {
        const ssKeys = [];
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          if (k && k.startsWith(KEY_PREFIX)) ssKeys.push(k);
        }
        for (const k of ssKeys) sessionStorage.removeItem(k);
      } catch (_) {}
    }

    if (resetCache && typeof globalThis.caches !== "undefined") {
      try {
        const names = await globalThis.caches.keys();
        for (const name of names) {
          if (name.startsWith("vibe-rp")) await globalThis.caches.delete(name);
        }
      } catch (_) {}
    }
  }

  async getStorageStats() {
    if (typeof indexedDB === "undefined") {
      const personas = (await this.local.presets(PERSONA_PRESETS).list()) || [];
      const directives = (await this.local.presets(DIRECTIVE_PRESETS).list()) || [];
      return {
        cardCount: 0,
        sessionCount: 0,
        personaCount: personas.length,
        directiveCount: directives.length,
        usage: 0,
        quota: 0,
      };
    }
    const cards = await this.idb.getAllCards();
    const sessionCount = await this.idb.countSessions();

    const personas = await this.local.presets(PERSONA_PRESETS).list();
    const directives = await this.local.presets(DIRECTIVE_PRESETS).list();

    let storageEstimate = null;
    if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
      try {
        storageEstimate = await navigator.storage.estimate();
      } catch (_) {}
    }
    let isPersisted = null;
    if (typeof navigator !== "undefined" && navigator.storage?.persisted) {
      try {
        isPersisted = Boolean(await navigator.storage.persisted());
      } catch (_) {}
    }

    return {
      cardCount: cards.length,
      sessionCount,
      personaCount: personas.length,
      directiveCount: directives.length,
      usage: storageEstimate?.usage || 0,
      quota: storageEstimate?.quota || 0,
      persisted: isPersisted,
    };
  }

  async exportAllData({ cookies = [], excludeSecrets = false } = {}) {
    const cards = await this.idb.getAllCards();
    const sessions = await this.idb.getAllSessions();
    const localData = this.local.snapshot();

    const sessionData = {};
    if (typeof sessionStorage !== "undefined") {
      try {
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          if (k && k.startsWith(KEY_PREFIX)) {
            sessionData[k] = sessionStorage.getItem(k);
          }
        }
      } catch (_) {}
    }

    let exportedCookies = Array.isArray(cookies) ? cookies : [];
    if (excludeSecrets) {
      exportedCookies = [];
      delete localData.vibe_rp_import_session;
      delete localData.vibe_rp_import_session_refresh_lock;
      if (typeof localData.vibe_rp_settings === "string") {
        try {
          const parsed = JSON.parse(localData.vibe_rp_settings);
          if (parsed && typeof parsed === "object") {
            if ("apiKey" in parsed) parsed.apiKey = "";
            if (Array.isArray(parsed.apiProfiles)) {
              parsed.apiProfiles = parsed.apiProfiles.map((p) => (p && typeof p === "object" ? { ...p, apiKey: "" } : p));
            }
            localData.vibe_rp_settings = JSON.stringify(parsed);
          }
        } catch (_) {}
      }
    }

    return {
      format: "vibe-rp-full-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      data: {
        indexedDb: {
          cards,
          sessions,
        },
        localStorage: localData,
        sessionStorage: sessionData,
        cookies: exportedCookies,
      },
    };
  }

  async importAllData(payload, { mode = "merge" } = {}) {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid backup: data is empty or not an object.");
    }

    if (payload.format === "vibe-rp-conversation") {
      if (!Array.isArray(payload.messages) || !payload.messages.length) {
        throw new Error("Legacy conversation export has no messages.");
      }
      const legacySession = {
        id: `sess_import_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        title: payload.title || "Restored chat",
        cardId: payload.cardId || "imported",
        messages: payload.messages,
        ledger: payload.ledger || "",
        consumed: payload.consumed || 0,
        updatedAt: Date.now(),
      };
      await this.idb.saveSession(legacySession);
      return {
        ok: true,
        cardsImported: 0,
        sessionsImported: 1,
        localStorageKeysImported: 0,
        cookies: [],
      };
    }

    const payloadData = payload.data || payload;
    if (payload.format !== "vibe-rp-full-backup" || !payloadData) {
      throw new Error("Invalid backup format: expected vibe-rp-full-backup.");
    }

    const { indexedDb: idbData = {}, localStorage: lsData = {}, sessionStorage: ssData = {}, cookies = [] } = payloadData;
    const isValidRow = (row) => row && typeof row === "object" && !Array.isArray(row) && typeof row.id === "string" && row.id.length > 0;
    const cards = (Array.isArray(idbData.cards) ? idbData.cards : []).filter(isValidRow);
    const sessions = (Array.isArray(idbData.sessions) ? idbData.sessions : []).filter(isValidRow);

    await this.idb.importRows({ cards, sessions, mode });

    if (mode === "replace") this.local.clearAll();

    const lsCount = this.local.restore(lsData, { mode });

    if (ssData && typeof ssData === "object" && typeof sessionStorage !== "undefined") {
      try {
        for (const [k, v] of Object.entries(ssData)) {
          // Same namespace boundary as LocalStore.restore(): a backup is
          // untrusted input, so only this app's own prefix may land.
          if (typeof k !== "string" || !k.startsWith(KEY_PREFIX)) continue;
          if (typeof v !== "string") continue;
          try {
            sessionStorage.setItem(k, v);
          } catch (err) {
            if (isStorageQuotaError(err)) {
              throw new LocalDbQuotaError("sessionStorage quota exceeded during import", err);
            }
            throw err;
          }
        }
      } catch (err) {
        if (err instanceof LocalDbQuotaError) throw err;
      }
    }

    return {
      ok: true,
      cardsImported: cards.length,
      sessionsImported: sessions.length,
      localStorageKeysImported: lsCount,
      cookies: Array.isArray(cookies) ? cookies : [],
    };
  }

  // --- connection (proxied so `LocalDb.db = null` still resets the cache) ---

  static get db() {
    return this.#defaultInstance.idb.db;
  }

  static set db(value) {
    this.#defaultInstance.idb.db = value;
  }

  static open() {
    return this.#defaultInstance.idb.open();
  }

  // --- cards and sessions ---

  static getAllCards() { return this.#defaultInstance.idb.getAllCards(); }
  static saveCard(card) { return this.#defaultInstance.idb.saveCard(card); }
  static saveSession(session) { return this.#defaultInstance.idb.saveSession(session); }
  static getSessionsForCard(characterId) { return this.#defaultInstance.idb.getSessionsForCard(characterId); }
  static getAllSessions() { return this.#defaultInstance.idb.getAllSessions(); }
  static deleteSession(sessionId) { return this.#defaultInstance.idb.deleteSession(sessionId); }
  static deleteCard(cardId) { return this.#defaultInstance.idb.deleteCard(cardId); }
  static clearAllSessions() { return this.#defaultInstance.idb.clearAllSessions(); }
  static clearAllCards() { return this.#defaultInstance.idb.clearAllCards(); }

  // --- presets (personas and directives) ---

  static getAllPersonas() { return this.#defaultInstance.local.presets(PERSONA_PRESETS).list(); }
  static getPersona(id) { return this.#defaultInstance.local.presets(PERSONA_PRESETS).get(id); }
  static savePersona(p) { return this.#defaultInstance.local.presets(PERSONA_PRESETS).save(p); }
  static deletePersona(id) { return this.#defaultInstance.local.presets(PERSONA_PRESETS).remove(id); }
  static getDefaultPersona() { return this.#defaultInstance.local.presets(PERSONA_PRESETS).getDefault(); }
  static setDefaultPersona(id) { return this.#defaultInstance.local.presets(PERSONA_PRESETS).setDefault(id); }
  static resolvePersonaForCard(card, session = null) { return this.#defaultInstance.local.presets(PERSONA_PRESETS).resolveForCard(card, session); }

  static getAllDirectives() { return this.#defaultInstance.local.presets(DIRECTIVE_PRESETS).list(); }
  static getDirective(id) { return this.#defaultInstance.local.presets(DIRECTIVE_PRESETS).get(id); }
  static saveDirective(d) { return this.#defaultInstance.local.presets(DIRECTIVE_PRESETS).save(d); }
  static deleteDirective(id) { return this.#defaultInstance.local.presets(DIRECTIVE_PRESETS).remove(id); }
  static getDefaultDirective() { return this.#defaultInstance.local.presets(DIRECTIVE_PRESETS).getDefault(); }
  static setDefaultDirective(id) { return this.#defaultInstance.local.presets(DIRECTIVE_PRESETS).setDefault(id); }
  static resolveDirectiveForCard(card, session = null) { return this.#defaultInstance.local.presets(DIRECTIVE_PRESETS).resolveForCard(card, session); }

  // --- settings ---

  static getSettings() { return this.#defaultInstance.local.getSettings(); }
  static saveSettings(settings) { return this.#defaultInstance.local.saveSettings(settings); }
  static resetSettings() { return this.#defaultInstance.local.resetSettings(); }

  // --- reset and import cache ---

  static resetPersonas() { return this.#defaultInstance.local.resetPresets(PERSONA_PRESETS); }
  static resetDirectives() { return this.#defaultInstance.local.resetPresets(DIRECTIVE_PRESETS); }
  static clearImportSession() { return this.#defaultInstance.local.clearImportSession(); }

  static wipeAllData(options) { return this.#defaultInstance.wipeAllData(options); }

  // --- stats and backup ---

  static getStorageStats() { return this.#defaultInstance.getStorageStats(); }

  static exportAllData(options) { return this.#defaultInstance.exportAllData(options); }

  static importAllData(payload, options) { return this.#defaultInstance.importAllData(payload, options); }
}
