// Keyed, append-only message feed.
//
// Two jobs:
//   1. Reconcile the DOM by message id instead of rebuilding it, so an open
//      inline editor, a focused control, and scroll position all survive.
//   2. During streaming, format ONLY the newly settled tail. The whole reply
//      is re-parsed exactly once, when the turn settles. Re-parsing the full
//      accumulated text per chunk is quadratic and was the old hot path.
//
// The incremental rule: content is split at blank lines. Everything up to the
// last blank line is "settled" and is formatted once, then appended as DOM.
// Only the trailing partial paragraph is re-formatted on each chunk, and that
// is bounded by one paragraph regardless of how long the reply gets.

import { escapeHtml, escapeAttr } from "../../safe_html.js";
import { stripThoughtBlocks as stripThoughts, extractThoughtBlocks } from "../../text.js";
import { avatarInnerHtml } from "../character_card.js";
import { scrollIntoViewRespectingMotion } from "../dom.js";

const MAX_RENDERED = 60;
const RENDER_STEP = 40;

/**
 * How long the settled prose stays a live region after its announcement.
 *
 * It cannot be retired immediately: the deferred announcement is triggered by
 * `aria-busy` clearing, and removing the role in the same task races it. It
 * cannot stay forever either — search wraps matches in `<mark>` inside this same
 * element, and a live region there would announce the message on every keystroke.
 */
const LIVE_REGION_RETIRE_MS = 2000;

/** Retires the streaming live region once the announcement it exists for is made. */
function retireLiveRegion(element) {
  if (!element) return;
  setTimeout(() => {
    element.removeAttribute("role");
    element.removeAttribute("aria-live");
    element.removeAttribute("aria-busy");
  }, LIVE_REGION_RETIRE_MS);
}

export function createMessageFeed({
  mount,
  resolve = (t) => t,
  formatProse,
  estimateTokens = () => 0,
  onAction = () => {},
}) {
  if (!mount) throw new Error("createMessageFeed needs a mount element");
  if (typeof formatProse !== "function") throw new Error("createMessageFeed needs formatProse");

  const nodes = new Map(); // msg id -> element
  let context = { card: null, persona: null, charName: "Character", initialLetter: "C" };
  let windowSize = MAX_RENDERED;
  let lastMessages = [];

  // --- small helpers -------------------------------------------------------

  const safeId = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
  const strSig = (s) => {
    let h = 2166136261;
    const str = String(s || "");
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  };
  const timeText = (ts) =>
    ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

  function avatarHtml(isUser) {
    const persona = context.persona;
    const card = context.card;
    const url = isUser ? persona?.avatar : card?.avatar || card?.data?.avatar;
    const fallback = isUser ? (persona?.name ? persona.name.charAt(0) : "U") : context.initialLetter;
    return avatarInnerHtml(url, fallback);
  }

  function speakerName(isUser) {
    return isUser ? context.persona?.name || "You" : context.charName;
  }

  /** The token figure reads inline in the header, never behind a press. */
  function tokenMetaHtml(tokens) {
    if (typeof tokens !== "number") return "";
    return `<span class="rp-message__tokens rp-tnum" title="Estimated tokens">~${tokens.toLocaleString()} tokens</span>`;
  }

  /** Interactive `< 1 / N >` switcher for message drafts, rerolls, and alternate greetings. */
  function forkMetaHtml(msg, current = 1, total = 1) {
    if (!total || total <= 1) return "";
    return (
      `<span class="rp-message__forks rp-tnum" role="group" aria-label="Message revisions">` +
      `<button type="button" class="rp-btn rp-btn--ghost rp-btn--xs rp-fork-nav" data-action="fork-prev" data-msg-id="${escapeAttr(msg.id)}" aria-label="Previous draft">&lt;</button>` +
      `<span class="rp-fork-count">${current} / ${total}</span>` +
      `<button type="button" class="rp-btn rp-btn--ghost rp-btn--xs rp-fork-nav" data-action="fork-next" data-msg-id="${escapeAttr(msg.id)}" aria-label="Next draft">&gt;</button>` +
      `</span>`
    );
  }

  function thoughtHtml(msg) {
    const rawThought = msg?.thought || extractThoughtBlocks(msg?.content || "").thought;
    if (!rawThought || !String(rawThought).trim()) return "";
    return (
      `<details class="rp-message__thought">` +
      `<summary class="rp-message__thought-summary">Thought process</summary>` +
      `<div class="rp-message__thought-body">${formatProse(resolve(rawThought))}</div>` +
      `</details>`
    );
  }

  function trayHtml(msg, opts) {
    const showDelete = Boolean(opts.showDelete);
    const showReroll = Boolean(opts.showReroll);
    const showContinue = Boolean(opts.showContinue);
    const showRewind = Boolean(opts.showRewind);
    const showFork = Boolean(opts.showFork);
    const showRetry = Boolean(opts.showRetry);
    const btns = [];
    const id = safeId(msg.id);
    if (showRetry) btns.push(`<button type="button" class="rp-btn rp-btn--ghost rp-btn--sm" data-action="retry" data-msg-id="${escapeAttr(msg.id)}">Retry reply</button>`);
    if (showContinue) btns.push(`<button type="button" class="rp-btn rp-btn--ghost rp-btn--sm" data-action="continue" data-msg-id="${escapeAttr(msg.id)}">Continue</button>`);
    if (showReroll) btns.push(`<button type="button" class="rp-btn rp-btn--ghost rp-btn--sm" data-action="reroll" data-msg-id="${escapeAttr(msg.id)}">Reroll</button>`);
    btns.push(`<button type="button" class="rp-btn rp-btn--ghost rp-btn--sm" data-action="edit" data-msg-id="${escapeAttr(msg.id)}">Edit</button>`);
    btns.push(`<button type="button" class="rp-btn rp-btn--ghost rp-btn--sm" data-action="copy" data-msg-id="${escapeAttr(msg.id)}">Copy</button>`);
    if (showFork) btns.push(`<button type="button" class="rp-btn rp-btn--ghost rp-btn--sm" data-action="fork" data-msg-id="${escapeAttr(msg.id)}">Fork</button>`);
    if (showRewind) btns.push(`<button type="button" class="rp-btn rp-btn--ghost rp-btn--sm" data-action="rewind" data-msg-id="${escapeAttr(msg.id)}">Rewind here</button>`);
    if (showDelete) btns.push(`<button type="button" class="rp-btn rp-btn--danger-ghost rp-btn--sm" data-action="delete" data-msg-id="${escapeAttr(msg.id)}">Delete</button>`);
    return `
      <div class="rp-message__tray" id="tray-${id}" data-open="false" role="group" aria-label="Message actions">
        ${btns.join("")}
      </div>`;
  }

  // --- element construction ------------------------------------------------

  function buildMessage(msg, opts) {
    const isUser = msg.role === "user";
    const id = safeId(msg.id);
    const el = document.createElement("article");
    el.className = `rp-message ${isUser ? "rp-message--user" : "rp-message--assistant"}`;
    el.dataset.msgId = msg.id;

    const resolved = resolve(msg.content || "");
    const prose = stripThoughts(resolved);
    const forkControl = forkMetaHtml(msg, opts.forkCurrent || 1, opts.forkTotal || 1);

    el.innerHTML = `
      <div class="rp-message__rail">
        <div class="rp-avatar rp-avatar--md ${isUser ? "rp-avatar--user" : ""}">${avatarHtml(isUser)}</div>
      </div>
      <div class="rp-message__content">
        <div class="rp-message__head" data-controls="tray-${id}">
          <button type="button" class="rp-message__title" aria-expanded="false" aria-controls="tray-${id}" title="Message actions">
            <span class="rp-message__speaker">${escapeHtml(speakerName(isUser))}</span>
          </button>
          <span class="rp-message__meta"><span class="rp-message__time rp-tnum">${escapeHtml(timeText(msg.timestamp))}</span>${tokenMetaHtml(estimateTokens(msg.content || ""))}${forkControl}</span>
          <button type="button" class="rp-message__more-btn" aria-expanded="false" aria-controls="tray-${id}" aria-label="Message actions" title="Message actions">⋯</button>
        </div>
        ${thoughtHtml(msg)}
        <div class="rp-message__prose" id="prose-${id}">${formatProse(prose)}</div>
        ${trayHtml(msg, opts)}
      </div>`;
    return el;
  }

  // --- reconciliation ------------------------------------------------------

  function signatureOf(msg) {
    const content = msg.content || "";
    return `${content.length}:${strSig(content)}:${(msg.forks || []).length}:${(msg.thought || "").length}:${msg.timestamp || 0}`;
  }

  function forkInfoFor(msg) {
    if (typeof context.getForkInfo === "function") {
      return context.getForkInfo(msg) || { current: 1, total: 1 };
    }
    const forks = Array.isArray(msg?.forks) ? msg.forks : [];
    return { current: forks.length + 1, total: forks.length + 1 };
  }

  function renderSignature(msg, opts) {
    const p = context.persona;
    const cardAvatar = context.card?.avatar || context.card?.data?.avatar || "";
    const ctxSig = `${context.charName || ""}:${strSig(cardAvatar)}:${p?.id || ""}:${p?.name || ""}:${p?.gender || ""}:${strSig(p?.avatar || "")}:${strSig(p?.template || "")}:${strSig(p?.description || "")}`;
    return `${signatureOf(msg)}:${ctxSig}:${opts.forkCurrent || 1}/${opts.forkTotal || 1}:${opts.showRetry ? "r" : ""}${opts.showReroll ? "R" : ""}${opts.showContinue ? "C" : ""}${opts.showRewind ? "W" : ""}${opts.showDelete ? "d" : ""}${opts.showFork ? "f" : ""}`;
  }

  /**
   * Whether Reroll belongs on this message.
   *
   * Reroll re-runs a turn the player took, so it needs one: the newest message
   * must be the character's reply and the message before it must be the
   * player's. In a fresh chat the newest turn is the card's authored opening,
   * which answers nothing — offering Reroll there would trade the opening for a
   * request that carries no user turn at all. This mirrors the controller's own
   * predicate, so the control is never shown for a reroll that would be a
   * no-op.
   */
  function canReroll(messages, msg) {
    if (!msg || msg.role === "user") return false;
    const list = messages || [];
    const newest = list[list.length - 1];
    if (!newest || newest.id !== msg.id) return false;
    return list[list.length - 2]?.role === "user";
  }

  function reconcile(messages) {
    const total = messages.length;
    const start = Math.max(0, total - windowSize);
    const visible = messages.slice(start);

    // Drop nodes whose ids are gone, or that fell out of the rendered window.
    const keep = new Set(visible.map((m) => String(m.id)));
    for (const [id, el] of nodes) {
      if (!keep.has(id)) {
        el.remove();
        nodes.delete(id);
      }
    }

    // Build or reuse one element per visible message, in order. A fork or an
    // inline edit keeps the id but changes the text, so the cached node is
    // rebuilt when its signature moves.
    const ordered = visible.map((msg, i) => {
      const id = String(msg.id);
      const absIndex = start + i;
      const forkInfo = forkInfoFor(msg);
      const opts = {
        showDelete: total > 1,
        showReroll: canReroll(messages, msg),
        showContinue: msg.role === "assistant" && absIndex === total - 1,
        showRewind: absIndex < total - 1,
        showFork: total > 1,
        forkCurrent: forkInfo.current,
        forkTotal: forkInfo.total,
        // The newest turn is the player's and nothing has answered it: its
        // generation failed or was interrupted. This is the durable recovery
        // affordance for that state.
        showRetry: msg.role === "user" && start + i === total - 1,
      };
      let el = nodes.get(id);
      const sig = renderSignature(msg, opts);
      if (el && el.dataset.sig !== sig) {
        const fresh = buildMessage(msg, opts);
        el.replaceWith(fresh);
        el = fresh;
        nodes.set(id, el);
      } else if (!el) {
        el = buildMessage(msg, opts);
        nodes.set(id, el);
      }
      el.dataset.sig = sig;
      return el;
    });

    // The "show earlier" header exists only while the rendered window is capped.
    let more = mount.querySelector(".rp-feed-more");
    if (start > 0) {
      if (!more) {
        more = document.createElement("div");
        more.className = "rp-feed-more";
        more.innerHTML = `<button type="button" class="rp-btn rp-btn--ghost rp-btn--sm"></button>`;
        more.querySelector("button").addEventListener("click", () => {
          showMore(RENDER_STEP);
        });
      }
      more.querySelector("button").textContent =
        `Show ${start} earlier message${start === 1 ? "" : "s"}`;
    } else {
      more = null;
    }

    // Walk the mount once, moving each wanted node into place and deleting
    // whatever is left over. Nodes already in position are left alone.
    let cursor = mount.firstChild;
    const place = (el) => {
      if (cursor === el) {
        cursor = cursor.nextSibling;
        return;
      }
      mount.insertBefore(el, cursor);
    };
    if (more) place(more);
    for (const el of ordered) place(el);
    while (cursor) {
      const next = cursor.nextSibling;
      cursor.remove();
      cursor = next;
    }
  }

  // --- public API ----------------------------------------------------------

  function setContext(ctx) {
    context = { ...context, ...ctx };
  }

  function setMessages(messages, ctx = {}) {
    setContext(ctx);
    lastMessages = messages || [];
    if (!lastMessages.length) {
      clear();
      return;
    }
    reconcile(lastMessages);
  }

  function clear() {
    windowSize = MAX_RENDERED;
    nodes.clear();
    mount.textContent = "";
  }

  function renderEmpty({ title, body, actionLabel, onAction: cb }) {
    clear();
    const wrap = document.createElement("div");
    wrap.className = "rp-empty";
    wrap.innerHTML = `
      <h2 class="rp-empty__title">${escapeHtml(title)}</h2>
      <p class="rp-empty__body">${escapeHtml(body)}</p>
      ${actionLabel ? `<button type="button" class="rp-btn rp-btn--primary rp-btn--lg" data-action="empty-continue">${escapeHtml(actionLabel)}</button>` : ""}`;
    wrap.querySelector("[data-action='empty-continue']")?.addEventListener("click", () => cb?.());
    mount.appendChild(wrap);
  }

  // --- streaming -----------------------------------------------------------

  function beginStream(id) {
    const isUser = false;
    const sid = safeId(id);
    const el = document.createElement("article");
    el.className = "rp-message rp-message--assistant is-streaming";
    el.dataset.msgId = id;
    el.innerHTML = `
      <div class="rp-message__rail">
        <div class="rp-avatar rp-avatar--md">${avatarHtml(isUser)}</div>
      </div>
      <div class="rp-message__content">
        <div class="rp-message__head" data-controls="tray-${sid}">
          <button type="button" class="rp-message__title" aria-expanded="false" aria-controls="tray-${sid}" title="Message actions">
            <span class="rp-message__speaker">${escapeHtml(context.charName)}</span>
          </button>
          <span class="rp-message__meta"><span class="rp-stream-status">Writing</span></span>
          <button type="button" class="rp-message__more-btn" aria-expanded="false" aria-controls="tray-${sid}" aria-label="Message actions" title="Message actions" disabled hidden>⋯</button>
        </div>
        <div class="rp-message__prose is-streaming" id="prose-${sid}" role="status" aria-live="polite" aria-busy="true">
          <div class="rp-stream-settled"></div><div class="rp-stream-tail"></div>
        </div>
      </div>`;
    mount.appendChild(el);
    nodes.set(String(id), el);
    return { el, buffer: "", settledAt: 0, settledEl: el.querySelector(".rp-stream-settled"), tailEl: el.querySelector(".rp-stream-tail") };
  }

  /** Last blank-line paragraph split at/after `minPos` that is not inside an open fenced code block. */
  function findSafeParagraphBoundary(text, minPos) {
    let idx = text.lastIndexOf("\n\n");
    while (idx > minPos) {
      const prefix = text.slice(0, idx);
      const fences = (prefix.match(/^[ \t]*```/gm) || []).length;
      if (fences % 2 === 0) return idx;
      idx = idx > 0 ? text.lastIndexOf("\n\n", idx - 1) : -1;
    }
    return -1;
  }

  function setStreamThinking(stream, elapsedSec = 0) {
    const statusEl = stream?.el?.querySelector?.(".rp-stream-status");
    if (!statusEl) return;
    statusEl.textContent = elapsedSec > 0 ? `Thinking… (${elapsedSec}s)` : "Thinking…";
  }

  /**
   * Formats and appends only what has settled since the last call, then
   * re-formats the single trailing paragraph. Cost per chunk is bounded by the
   * tail length, not by the reply length.
   */
  function appendChunk(stream, chunk) {
    if (!stream || !chunk) return;
    stream.buffer += chunk;

    const extracted = extractThoughtBlocks(stream.buffer);
    const prose = stripThoughts(resolve(stream.buffer));
    const statusEl = stream.el?.querySelector?.(".rp-stream-status");
    if (statusEl) {
      if (extracted.isThinking && !prose.trim()) statusEl.textContent = "Thinking…";
      else if (prose.trim()) statusEl.textContent = "Writing";
    }
    if (prose.length < stream.settledAt) {
      stream.settledAt = 0;
      stream.settledEl.textContent = "";
    }

    const boundary = findSafeParagraphBoundary(prose, stream.settledAt);
    if (boundary > stream.settledAt) {
      const delta = prose.slice(stream.settledAt, boundary + 2);
      if (delta.trim()) stream.settledEl.insertAdjacentHTML("beforeend", formatProse(delta));
      stream.settledAt = boundary + 2;
    }
    const tail = prose.slice(stream.settledAt);
    stream.tailEl.innerHTML = tail.trim() ? formatProse(tail) : "";
  }

  /** One full parse at settle: the incremental tail is replaced by the truth. */
  function settleStream(stream, msg) {
    if (!stream) return;
    const el = stream.el;
    el.classList.remove("is-streaming");
    el.querySelector(".rp-stream-status")?.remove();

    const resolved = resolve(msg.content || "");
    const prose = stripThoughts(resolved);
    const proseEl = el.querySelector(".rp-message__prose");
    const thoughtMarkup = thoughtHtml(msg);
    if (thoughtMarkup) {
      proseEl.insertAdjacentHTML("beforebegin", thoughtMarkup);
    }
    // The order here is the whole point. The element is a live region with
    // `aria-busy="true"`, which tells assistive tech to hold its announcement
    // until the busy flag clears. Retiring the role and clearing the flag
    // *before* writing the text — which is what this used to do — meant the
    // settled content landed on an element that was no longer a live region, so
    // the reply was never announced: the reader heard "Writing a reply." and
    // then silence. Write the text first, clear the flag so the deferred
    // announcement fires against the settled content, then retire the
    // attributes once it has been made.
    proseEl.classList.remove("is-streaming");
    proseEl.innerHTML = formatProse(prose);
    proseEl.setAttribute("aria-busy", "false");
    retireLiveRegion(proseEl);

    const realSid = safeId(msg.id);
    proseEl.id = `prose-${realSid}`;

    const content = el.querySelector(".rp-message__content");
    const head = content.querySelector(".rp-message__head");
    head.dataset.controls = `tray-${realSid}`;
    head.querySelector(".rp-message__title")?.setAttribute("aria-controls", `tray-${realSid}`);
    const moreBtn = head.querySelector(".rp-message__more-btn");
    if (moreBtn) {
      moreBtn.setAttribute("aria-controls", `tray-${realSid}`);
      moreBtn.disabled = false;
      moreBtn.hidden = false;
    }

    const meta = head.querySelector(".rp-message__meta");
    const forkInfo = forkInfoFor(msg);
    if (meta) {
      meta.querySelector(".rp-message__tokens")?.remove();
      meta.querySelector(".rp-message__forks")?.remove();
      const timeStr = `<span class="rp-message__time rp-tnum">${escapeHtml(timeText(msg.timestamp))}</span>`;
      const tokens = tokenMetaHtml(estimateTokens(msg.content || "")) + forkMetaHtml(msg, forkInfo.current, forkInfo.total);
      meta.innerHTML = `${timeStr}${tokens}`;
    }
    const settledOpts = {
      showDelete: true,
      showReroll: true,
      showContinue: true,
      showRewind: false,
      showFork: true,
      showRetry: false,
      forkCurrent: forkInfo.current,
      forkTotal: forkInfo.total,
    };
    content.insertAdjacentHTML("beforeend", trayHtml(msg, settledOpts));
    // The provisional stream key is replaced by the real message id, so the
    // next reconcile reuses this node instead of rebuilding it.
    const oldKey = String(el.dataset.msgId);
    el.dataset.msgId = msg.id;
    el.dataset.sig = renderSignature(msg, settledOpts);
    nodes.delete(oldKey);
    nodes.set(String(msg.id), el);
  }

  function failStream(stream) {
    if (!stream) return;
    nodes.delete(String(stream.el.dataset.msgId));
    stream.el.remove();
  }

  function updateMessage(msg) {
    const id = String(msg.id);
    const existing = nodes.get(id);
    const idx = lastMessages.findIndex((m) => m.id === msg.id);
    const forkInfo = forkInfoFor(msg);
    const opts = {
      showDelete: lastMessages.length > 1,
      showReroll: canReroll(lastMessages, msg),
      showContinue: msg.role === "assistant" && idx === lastMessages.length - 1,
      showRewind: idx >= 0 && idx < lastMessages.length - 1,
      showFork: lastMessages.length > 1,
      showRetry: msg.role === "user" && lastMessages[lastMessages.length - 1]?.id === msg.id,
      forkCurrent: forkInfo.current,
      forkTotal: forkInfo.total,
    };
    const fresh = buildMessage(msg, opts);
    fresh.dataset.sig = renderSignature(msg, opts);
    if (existing) {
      existing.replaceWith(fresh);
    } else {
      mount.appendChild(fresh);
    }
    nodes.set(id, fresh);
  }

  function removeMessage(id) {
    const el = nodes.get(String(id));
    el?.remove();
    nodes.delete(String(id));
  }

  function getElement(id) {
    return nodes.get(String(id)) || null;
  }

  function getProse(id) {
    return nodes.get(String(id))?.querySelector(".rp-message__prose") || null;
  }

  function scrollToMessage(id, { behavior = "smooth" } = {}) {
    const el = nodes.get(String(id));
    if (!el) return false;
    return scrollIntoViewRespectingMotion(el, { block: "start", behavior });
  }

  /**
   * Renders one more slice of the transcript. Returns false when the whole
   * transcript is already in the DOM, so a caller walking backwards through
   * matches can tell "there is more" from "that was all".
   */
  function showMore(step = RENDER_STEP) {
    if (windowSize >= lastMessages.length) return false;
    const scroller = mount.parentElement;
    const prevHeight = scroller ? scroller.scrollHeight : 0;
    const prevTop = scroller ? scroller.scrollTop : 0;
    windowSize = Math.min(lastMessages.length, windowSize + step);
    reconcile(lastMessages);
    if (scroller && scroller.scrollHeight > prevHeight) {
      scroller.scrollTop = prevTop + (scroller.scrollHeight - prevHeight);
    }
    return true;
  }

  // --- one delegated listener ---------------------------------------------

  mount.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (btn) {
      const action = btn.dataset.action;
      const msgId = btn.dataset.msgId;
      const el = btn.closest(".rp-message");
      onAction(action, msgId, { button: btn, element: el });
      return;
    }

    const toggleBtn = e.target.closest(".rp-message__title, .rp-message__more-btn");
    // Do not toggle if clicking an interactive control or selecting text
    if (!toggleBtn && e.target.closest("button, a, input, textarea, select")) return;
    if (toggleBtn?.disabled) return;
    if (!toggleBtn) {
      const sel = typeof window.getSelection === "function" ? window.getSelection()?.toString() : "";
      if (sel && sel.trim().length > 0) return;
    }

    const card = e.target.closest(".rp-message");
    if (card) {
      const tray = card.querySelector(".rp-message__tray");
      if (tray) {
        const open = tray.getAttribute("data-open") !== "true";
        tray.setAttribute("data-open", open ? "true" : "false");
        card.querySelector(".rp-message__title")?.setAttribute("aria-expanded", open ? "true" : "false");
        card.querySelector(".rp-message__more-btn")?.setAttribute("aria-expanded", open ? "true" : "false");
        if (open) {
          mount.querySelectorAll('.rp-message__tray[data-open="true"]').forEach((other) => {
            if (other !== tray) {
              other.setAttribute("data-open", "false");
              const otherCard = other.closest(".rp-message");
              otherCard?.querySelector(".rp-message__title")?.setAttribute("aria-expanded", "false");
              otherCard?.querySelector(".rp-message__more-btn")?.setAttribute("aria-expanded", "false");
            }
          });
        }
      }
    }
  });

  return {
    setContext,
    setMessages,
    renderEmpty,
    clear,
    beginStream,
    setStreamThinking,
    appendChunk,
    settleStream,
    failStream,
    updateMessage,
    removeMessage,
    getElement,
    getProse,
    scrollToMessage,
    showMore,
    get count() { return nodes.size; },
    /** How much of the transcript is currently rendered. */
    get rendered() { return Math.min(windowSize, lastMessages.length); },
  };
}
