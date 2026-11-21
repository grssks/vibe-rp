import { utf8Decoder } from "./text.js";

// Character-card import parsing (JSON/JSONC + chub V2 PNG + legacy V1 WebP).
// No DOM/window/document references: pure byte/JSON parsing helpers.

export function stripJsonComments(src) {
  let noComments = "", inStr = false, esc = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      noComments += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; noComments += c; continue; }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      noComments += "\n";
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      noComments += " ";
      continue;
    }
    noComments += c;
  }

  // String-aware trailing comma removal: only drop commas outside of quoted strings
  // that precede a closing brace or bracket.
  let out = "";
  inStr = false;
  esc = false;
  for (let i = 0; i < noComments.length; i++) {
    const c = noComments[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < noComments.length && /\s/.test(noComments[j])) j++;
      if (j < noComments.length && (noComments[j] === "}" || noComments[j] === "]")) {
        continue;
      }
    }
    out += c;
  }
  return out;
}

// HTML in definition fields (source sites, exported cards) is inert junk here:
// the feed escapes it (literal tags on screen) and the model gets it verbatim.
// Converter below maps the common subset onto the app's lightweight markup.
const HTML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", mdash: "—", ndash: "–", hellip: "…", laquo: "«", raquo: "»", copy: "©", reg: "®" };
export function decodeHtmlEntities(str) {
  if (!str) return "";
  return String(str).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    const hit = HTML_ENTITIES[body.toLowerCase()];
    return hit === undefined ? whole : hit;
  });
}
function htmlHref(attrs) {
  const m = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs || "");
  return m ? decodeHtmlEntities(m[1] ?? m[2] ?? m[3] ?? "") : "";
}
function tagToMarkup(close, name) {
  switch (name) {
    case "p": return "\n\n";
    case "br": return "\n";
    case "hr": return "\n\n---\n\n";
    case "strong": case "b": return "**";
    case "em": case "i": return "*";
    case "h1": return close ? "\n\n" : "\n\n# ";
    case "h2": return close ? "\n\n" : "\n\n## ";
    case "h3": case "h4": case "h5": case "h6": return close ? "\n\n" : "\n\n### ";
    case "blockquote": return close ? "\n\u0000QE\u0000\n\n" : "\n\n\u0000QS\u0000\n";
    case "ul": case "ol": return "\n\n";
    case "li": return close ? "\n" : "\n- ";
    default: return "";
  }
}
// Card-format markers the app itself understands (index.html renders <START> as
// a sample divider). They are not HTML, so they are preserved verbatim instead
// of being stripped as an unknown tag.
const CARD_MARKER = /^(?:start|bot|end)$/;
export function htmlToAppMarkup(input) {
  if (input == null) return "";
  let s = String(input);
  if (!s) return "";
  // Fast path: already-clean text is returned byte-identical (idempotence).
  if (!/[<&\r]/.test(s) && !/\n{3}/.test(s)) return s;
  // Comments, and script/style elements with their content, are dropped outright:
  // neither is prose, and neither should ever reach the model or the feed.
  s = s.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  s = s.replace(/<a\b((?:"[^"]*"|'[^']*'|[^"'>])*)>([\s\S]*?)<\/a\s*>/gi, (_w, at, inner) => {
    const href = htmlHref(at);
    const tx = decodeHtmlEntities(inner.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
    if (!tx) return href;
    if (!href || tx === href) return tx;
    return tx + " (" + href + ")";
  });
  const markers = [];
  let out = "", last = 0, m;
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/g;
  while ((m = re.exec(s)) !== null) {
    out += decodeHtmlEntities(s.slice(last, m.index));
    const name = m[2].toLowerCase();
    if (CARD_MARKER.test(name) && !m[3]) out += "\u0000MK" + (markers.push(m[0]) - 1) + "\u0000";
    else out += tagToMarkup(m[1] === "/", name);
    last = re.lastIndex;
  }
  out += decodeHtmlEntities(s.slice(last));
  out = out.replace(/\u0000QS\u0000\n([\s\S]*?)\n\u0000QE\u0000/g, (_w, inner) => {
    const q = inner.split("\n").map((l) => (l.trim() ? "> " + l.trim() : ">")).join("\n");
    return "\n\n" + q + "\n\n";
  });
  out = out.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  // Final safety net: any tag-shaped sequence that survived (e.g. from a decoded
  // `&lt;em&gt;`) is neutralised, so the output can never be parsed as markup.
  out = out.replace(/<\/?[a-zA-Z][^<>]*>/g, (t) => "&lt;" + t.slice(1, -1) + "&gt;");
  out = out.replace(/\u0000MK(\d+)\u0000/g, (_w, i) => markers[+i]);
  return out;
}
export const CARD_HTML_FIELDS = ["description", "personality", "scenario", "first_mes", "mes_example", "system_prompt", "post_history_instructions", "creator_notes", "example_dialogs"];
function cleanCardData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const out = { ...data };
  for (const f of CARD_HTML_FIELDS) {
    if (typeof out[f] === "string" && out[f]) out[f] = htmlToAppMarkup(out[f]);
  }
  if (Array.isArray(out.alternate_greetings)) {
    out.alternate_greetings = out.alternate_greetings.map((g) => (typeof g === "string" && g ? htmlToAppMarkup(g) : g));
  }
  if (Array.isArray(out.group_only_greetings)) {
    out.group_only_greetings = out.group_only_greetings.map((g) => (typeof g === "string" && g ? htmlToAppMarkup(g) : g));
  }
  return out;
}
export function normalizeCard(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("card JSON is not an object");
  if (json.data && typeof json.data === "object" && !Array.isArray(json.data)) {
    return { spec: json.spec || "chara_card_v2", spec_version: json.spec_version || "2.0", data: cleanCardData(json.data) };
  }
  return { spec: "chara_card_v1", spec_version: "1.0", data: cleanCardData(json) };
}

export function parseJsonLoose(text) {
  try { return JSON.parse(String(text).trim()); } catch { return null; }
}

const latin1Decoder = new TextDecoder("latin1");

export function decodeBase64Utf8(b64) {
  try {
    const bin = atob(b64);
    const u8 = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return utf8Decoder.decode(u8);
  } catch {
    return null;
  }
}

const MAX_INFLATE_BYTES = 16 * 1024 * 1024;

export async function inflateDecompress(u8, maxBytes = MAX_INFLATE_BYTES) {
  const ds = new DecompressionStream("deflate");
  const stream = new Blob([u8]).stream().pipeThrough(ds);
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.byteLength) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error("Compressed character chunk exceeds size limit.");
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return utf8Decoder.decode(merged);
}

function parseCharaText(rawText) {
  const clean = String(rawText || "").trim();
  const decoded = decodeBase64Utf8(clean);
  return (decoded && parseJsonLoose(decoded)) || parseJsonLoose(clean);
}

export async function parsePngChara(buf) {
  const view = new DataView(buf);
  if (view.byteLength < 8 || view.getUint32(0) !== 0x89504e47) return null;
  const bytes = new Uint8Array(buf);
  let chara = null;
  let ccv3 = null;
  let off = 8;
  while (off + 8 <= bytes.length) {
    const len = view.getUint32(off);
    const type = latin1Decoder.decode(bytes.subarray(off + 4, off + 8));
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (len > bytes.length || dataEnd > bytes.length || dataEnd < dataStart) break;
    if (type === "IEND") break;
    if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
      const data = bytes.subarray(dataStart, dataEnd);
      let k = 0;
      while (k < data.length && data[k] !== 0) k++;
      const keyword = latin1Decoder.decode(data.subarray(0, k)).toLowerCase();
      if (keyword === "chara" || keyword === "ccv3") {
        const rest = data.subarray(k + 1);
        let parsed = null;
        if (type === "tEXt") {
          parsed = parseCharaText(latin1Decoder.decode(rest));
        } else if (type === "zTXt") {
          try {
            parsed = parseCharaText(await inflateDecompress(rest.subarray(1)));
          } catch {
            parsed = null;
          }
        } else {
          // iTXt: compressionFlag(1) compressionMethod(1) lang\0 translated\0 [compressed] text
          const cflag = rest[0];
          let p = 2;
          while (p < rest.length && rest[p] !== 0) p++;
          if (p < rest.length) p++;
          while (p < rest.length && rest[p] !== 0) p++;
          if (p < rest.length) p++;
          const payload = rest.subarray(p);
          if (cflag) {
            try {
              parsed = parseCharaText(await inflateDecompress(payload));
            } catch {
              parsed = null;
            }
          } else {
            parsed = parseCharaText(utf8Decoder.decode(payload));
          }
        }
        if (parsed) {
          if (keyword === "ccv3") ccv3 = parsed;
          else if (!chara) chara = parsed;
        }
      }
    }
    off = dataEnd + 4; // skip CRC
  }
  return ccv3 || chara;
}

export function tryExtractBase64Json(str) {
  const clean = String(str).replace(/\0/g, "").trim().replace(/^exif:\s*/i, "");
  if (!clean) return null;
  // Strategy 1: whole chunk is base64-encoded JSON (UTF-8 safe)
  const decoded1 = decodeBase64Utf8(clean);
  if (decoded1) {
    try {
      const json = JSON.parse(decoded1);
      if (json && typeof json === "object") return normalizeCard(json);
    } catch { /* fall through */ }
  }
  // Strategy 2: substring base64 scan (some encoders wrap with header bytes)
  const b64Match = clean.match(/[A-Za-z0-9+/]{40,}={0,2}/g);
  if (b64Match) {
    for (const seg of b64Match) {
      const segDecoded = decodeBase64Utf8(seg);
      if (segDecoded) {
        try {
          const json = JSON.parse(segDecoded);
          if (json && typeof json === "object" && (json.name || json.data?.name)) return normalizeCard(json);
        } catch { /* continue */ }
      }
    }
  }
  // Strategy 3: chunk is raw JSON
  try {
    const json = parseJsonLoose(clean);
    if (json && typeof json === "object") return normalizeCard(json);
  } catch { /* fall through */ }
  return null;
}

export function scanExifIfdForChara(bytes, view, ifdStart, littleEndian, exifStart = 0) {
  // Minimal EXIF IFD entry scanner: look for UserComment tag 0x9286
  try {
    if (ifdStart < 0 || ifdStart + 2 > view.byteLength) return null;
    const entryCount = view.getUint16(ifdStart, littleEndian);
    for (let i = 0; i < entryCount; i++) {
      const entryOff = ifdStart + 2 + i * 12;
      if (entryOff + 12 > view.byteLength) break;
      const tag = view.getUint16(entryOff, littleEndian);
      if (tag !== 0x9286) continue; // UserComment
      const count = view.getUint32(entryOff + 4, littleEndian);
      let dataOff;
      if (count > 4) {
        dataOff = view.getUint32(entryOff + 8, littleEndian);
      } else {
        dataOff = entryOff + 8;
      }
      const start = exifStart + dataOff + 8;
      const end = exifStart + dataOff + count;
      if (start < exifStart || start > end || end > bytes.length) break;
      // UserComment starts with 8-byte charset code (ASCII\0\0\0 or UNICODE\0 etc)
      const payload = bytes.subarray(start, end);
      const text = utf8Decoder.decode(payload).replace(/\0/g, "").trim();
      if (text) {
        const result = tryExtractBase64Json(text);
        if (result) return result;
      }
      break;
    }
  } catch { /* ignore */ }
  return null;
}

export function parseWebpChara(buf) {
  const view = new DataView(buf);
  if (view.byteLength < 12 || view.getUint32(0) !== 0x52494646 || view.getUint32(8) !== 0x57454250) return null;
  const bytes = new Uint8Array(buf);
  let off = 12;
  while (off + 8 <= bytes.length) {
    const type = latin1Decoder.decode(bytes.subarray(off, off + 4));
    const size = view.getUint32(off + 4, true);
    const dataStart = off + 8;
    const dataEnd = dataStart + size;
    if (size > bytes.length || dataEnd > bytes.length || dataEnd < dataStart) break;
    if (type === "EXIF" || type === "XMP ") {
      // Strategy A: treat chunk as text and try base64/JSON extraction
      const chunk = latin1Decoder.decode(bytes.subarray(dataStart, dataEnd));
      const found = tryExtractBase64Json(chunk);
      if (found) return found;

      // Strategy B: parse as binary EXIF to find UserComment IFD entry
      if (type === "EXIF") {
        try {
          // EXIF header: 6 bytes "Exif\0\0" then TIFF header
          const exifStart = dataStart + 6;
          if (exifStart + 8 < dataEnd) {
            const byteOrder = view.getUint16(exifStart, true);
            const le = byteOrder === 0x4949; // "II" = little-endian
            const ifd0Offset = view.getUint32(exifStart + 4, le);
            const ifd0Start = exifStart + ifd0Offset;
            if (ifd0Start < dataEnd) {
              const result = scanExifIfdForChara(bytes, new DataView(buf, exifStart), ifd0Offset, le, exifStart);
              if (result) return result;
            }
          }
        } catch { /* ignore */ }
      }
    }
    off = (dataEnd + 1) & ~1;
  }
  return null;
}

const utf8Encoder = new TextEncoder();

function encodeBase64Utf8(str) {
  const bytes = utf8Encoder.encode(String(str));
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type, data) {
  const payload = data instanceof Uint8Array ? data : new Uint8Array(0);
  const out = new Uint8Array(12 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  view.setUint32(8 + payload.length, crc32(out.subarray(4, 8 + payload.length)));
  return out;
}

function minimalPngBytes() {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  const idatData = new Uint8Array([0x78, 0x01, 0x01, 0x05, 0x00, 0xfa, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x06, 0x00, 0x01]);
  const chunks = [sig, makePngChunk("IHDR", ihdrData), makePngChunk("IDAT", idatData), makePngChunk("IEND", new Uint8Array(0))];
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/** Serializes a stored or normalized card record to a clean CCv2 JSON object. */
export function serializeCardV2(card) {
  const src = card && typeof card === "object" ? card : {};
  const d = src.data && typeof src.data === "object" ? src.data : src;
  return {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: String(d.name ?? src.name ?? "").trim() || "Character",
      description: String(d.description ?? ""),
      personality: String(d.personality ?? ""),
      scenario: String(d.scenario ?? ""),
      first_mes: String(d.first_mes ?? ""),
      mes_example: String(d.mes_example ?? d.example_dialogs ?? ""),
      creator_notes: String(d.creator_notes ?? ""),
      system_prompt: String(d.system_prompt ?? ""),
      post_history_instructions: String(d.post_history_instructions ?? ""),
      alternate_greetings: Array.isArray(d.alternate_greetings) ? d.alternate_greetings.slice() : [],
      group_only_greetings: Array.isArray(d.group_only_greetings) ? d.group_only_greetings.slice() : [],
      tags: Array.isArray(d.tags) ? d.tags.slice() : [],
      creator: String(d.creator ?? ""),
      character_version: String(d.character_version ?? d.char_version ?? "1.0"),
      character_book: d.character_book ?? null,
      extensions: d.extensions && typeof d.extensions === "object" ? { ...d.extensions } : {},
    },
  };
}

/** Embeds a CCv2 `chara` tEXt chunk into `pngBytes` (or card's PNG avatar / 1x1 fallback). */
export function buildPngWithChara(card, pngBytes = null) {
  let baseBytes = null;
  if (pngBytes instanceof Uint8Array) baseBytes = pngBytes;
  else if (pngBytes instanceof ArrayBuffer) baseBytes = new Uint8Array(pngBytes);
  else {
    const avatar = String(card?.avatar || card?.data?.avatar || "");
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/i.exec(avatar.trim());
    if (m) {
      try {
        const bin = atob(m[1]);
        baseBytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      } catch {
        baseBytes = null;
      }
    }
  }
  if (!baseBytes || baseBytes.length < 8 ||
      baseBytes[0] !== 0x89 || baseBytes[1] !== 0x50 || baseBytes[2] !== 0x4e || baseBytes[3] !== 0x47) {
    baseBytes = minimalPngBytes();
  }

  const view = new DataView(baseBytes.buffer, baseBytes.byteOffset, baseBytes.byteLength);
  const kept = [baseBytes.subarray(0, 8)];
  let off = 8;
  while (off + 12 <= baseBytes.length) {
    const len = view.getUint32(off);
    const type = latin1Decoder.decode(baseBytes.subarray(off + 4, off + 8));
    const end = off + 12 + len;
    if (end > baseBytes.length || end < off + 12) break;
    if (type === "IEND") break;
    let skip = false;
    if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
      const data = baseBytes.subarray(off + 8, off + 8 + len);
      let k = 0;
      while (k < data.length && data[k] !== 0) k++;
      const kw = latin1Decoder.decode(data.subarray(0, k)).toLowerCase();
      if (kw === "chara" || kw === "ccv3") skip = true;
    }
    if (!skip) kept.push(baseBytes.subarray(off, end));
    off = end;
  }

  const b64 = encodeBase64Utf8(JSON.stringify(serializeCardV2(card)));
  const chunkPayload = new Uint8Array(6 + b64.length);
  const prefix = "chara\0";
  for (let i = 0; i < 6; i++) chunkPayload[i] = prefix.charCodeAt(i);
  for (let i = 0; i < b64.length; i++) chunkPayload[6 + i] = b64.charCodeAt(i);

  const charaChunk = makePngChunk("tEXt", chunkPayload);
  const iendChunk = makePngChunk("IEND", new Uint8Array(0));
  const outParts = [...kept, charaChunk, iendChunk];
  const total = outParts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of outParts) { out.set(part, pos); pos += part.length; }
  return out;
}
