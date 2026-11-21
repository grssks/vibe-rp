// Browser data transfer: cookie serialization, backup download and file reading.
//
// Zero-backend client helpers for packaging and restoring the browser state.

const COOKIE_PREFIX = "vibe_rp_";
const MAX_BACKUP_BYTES = 100 * 1024 * 1024;

function secureSuffix() {
  return globalThis.location?.protocol === "https:" ? "; Secure" : "";
}

/**
 * Reads app-owned (`vibe_rp_`-prefixed) cookies from `document.cookie`.
 * Returns an array of `{ name, value }` objects.
 */
export function readBrowserCookies() {
  if (typeof document === "undefined" || !document.cookie) return [];
  const result = [];
  const pairs = document.cookie.split(";");
  for (const pair of pairs) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) {
      if (trimmed.startsWith(COOKIE_PREFIX)) result.push({ name: trimmed, value: "" });
    } else {
      const name = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (name && name.startsWith(COOKIE_PREFIX)) result.push({ name, value });
    }
  }
  return result;
}

/**
 * Restores an array of `{ name, value }` objects to `document.cookie`.
 */
export function restoreBrowserCookies(cookies = []) {
  if (typeof document === "undefined" || !Array.isArray(cookies)) return;
  const secure = secureSuffix();
  for (const c of cookies) {
    if (!c || !c.name) continue;
    const name = String(c.name).replace(/[\r\n;]/g, "").trim();
    if (!name.startsWith(COOKIE_PREFIX)) continue;
    const val = String(c.value ?? "").replace(/[\r\n;]/g, "").trim();
    document.cookie = `${name}=${val}; path=/; max-age=31536000; SameSite=Lax${secure}`;
  }
}

/**
 * Clears all readable app-owned (`vibe_rp_`-prefixed) cookies by setting their expiration in the past.
 */
export function clearBrowserCookies() {
  if (typeof document === "undefined" || !document.cookie) return;
  const secure = secureSuffix();
  const pairs = document.cookie.split(";");
  for (const pair of pairs) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    const name = eqIdx === -1 ? trimmed : trimmed.slice(0, eqIdx).trim();
    if (name && name.startsWith(COOKIE_PREFIX)) {
      document.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; max-age=0; SameSite=Lax${secure}`;
    }
  }
}

/**
 * Formats a timestamp into a filesystem-safe date string: YYYY-MM-DD-HHmm.
 */
function fileTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  return `${y}-${m}-${d}-${h}${min}`;
}

/**
 * Triggers a client-side download of the full backup document.
 * Returns the downloaded filename.
 */
export function downloadBackupFile(backupData, filename = null) {
  const name = filename || `vibe-rp-backup-${fileTimestamp()}.json`;
  const jsonText = JSON.stringify(backupData, null, 2);
  const blob = new Blob([jsonText], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}

/**
 * Reads a File or Blob and returns the parsed JSON document.
 * Throws a descriptive error if the file is not valid JSON.
 */
export async function readBackupFile(file) {
  if (!file) throw new Error("No file selected.");
  if (typeof file.size === "number" && file.size > MAX_BACKUP_BYTES) {
    throw new Error("Backup file exceeds the 100 MB safety limit.");
  }
  const text = await file.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    throw new Error("The selected file is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid backup: expected a JSON object.");
  }
  return parsed;
}

/**
 * Formats a chat session transcript as clean Markdown.
 */
export function formatTranscriptMarkdown(session, { charName = "Character", userName = "You" } = {}) {
  const title = session?.title || "Conversation";
  const lines = [`# ${title}\n`];
  if (session?.ledger) {
    lines.push(`> Continuity Ledger:\n> ${session.ledger.replace(/\n/g, "\n> ")}\n`);
  }
  for (const m of session?.messages || []) {
    if (!m || !m.content) continue;
    const speaker = m.role === "user" ? userName : charName;
    lines.push(`### ${speaker}\n\n${m.content.trim()}\n`);
  }
  return lines.join("\n");
}

/**
 * Triggers a client-side download of the conversation transcript as a Markdown file.
 * Returns the downloaded filename.
 */
export function downloadTranscriptFile(session, options = {}) {
  const title = String(session?.title || "chat").toLowerCase().replace(/[^a-z0-9_-]+/gi, "-").slice(0, 40);
  const filename = `${title}-${fileTimestamp()}.md`;
  const mdText = formatTranscriptMarkdown(session, options);
  const blob = new Blob([mdText], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}

/**
 * Triggers a client-side download of a single conversation as JSON.
 */
export function downloadSessionJsonFile(session, { cardName = "" } = {}) {
  const title = String(session?.title || "chat").toLowerCase().replace(/[^a-z0-9_-]+/gi, "-").slice(0, 40);
  const filename = `${title}-${fileTimestamp()}.json`;
  const payload = {
    format: "vibe-rp-conversation",
    version: 1,
    exportedAt: new Date().toISOString(),
    cardId: session?.cardId || "",
    cardName: cardName || "",
    title: session?.title || "Conversation",
    messages: Array.isArray(session?.messages) ? session.messages : [],
    ledger: session?.ledger || "",
    consumed: session?.consumed || 1,
    authorsNote: session?.authorsNote || "",
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}

