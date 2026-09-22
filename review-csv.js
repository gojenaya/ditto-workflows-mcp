// CSV round-trip for translator review sheets.
//
// Markdown sheets were readable in chat but not in the tool translators actually
// use. A reviewer working in Excel or Sheets had to hand-edit `\|` and `<br>`
// escapes in a text editor; most of them simply didn't. This module is the CSV
// half: writing a file those apps open cleanly, and reading back one they have
// sorted, filtered and re-saved.
//
// The hazards here are all silent ones — a BOM-less file turns Arabic into
// mojibake, a leading `=` makes Excel evaluate a translation as a formula, and a
// reviewer who sorts rows breaks any positional assumption. Hence: BOM always,
// formula guard always, dev_id as the only join key.

// RFC 4180 with the practical additions Excel needs.
export function toCsv(headers, rows) {
  const esc = (v) => {
    let s = v == null ? "" : String(v);
    // Excel/Sheets execute a cell starting with these. A translation beginning
    // with "-" or "+" is ordinary copy, so prefix rather than mangle the text:
    // the apostrophe is consumed by the spreadsheet and never reaches the parser.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    // Quote when the value could otherwise break the row.
    if (/["\n\r,;]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const body = [headers, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
  // UTF-8 BOM: without it Excel reads the file as the system codepage and every
  // Arabic, Hindi and Urdu cell arrives as mojibake.
  return "﻿" + body + "\r\n";
}

// Tolerant parser: handles quotes, embedded newlines, CRLF, a BOM, and the
// semicolon delimiter that Excel writes in several European locales.
export function fromCsv(text) {
  let s = text.replace(/^﻿/, "");
  // Sniff the delimiter on the header line rather than assuming a comma.
  const firstLine = s.slice(0, s.indexOf("\n") === -1 ? s.length : s.indexOf("\n"));
  const delim = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ";" : ",";

  const rows = [];
  let row = [], cell = "", inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === delim) { row.push(cell); cell = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];

  const headers = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1)
    .filter((r) => r.some((c) => (c || "").trim() !== ""))
    .map((r) => {
      const o = {};
      headers.forEach((h, i) => {
        // Undo the formula guard we added on export.
        let v = (r[i] ?? "");
        if (v.startsWith("'") && /^'[=+\-@]/.test(v)) v = v.slice(1);
        o[h] = v;
      });
      return o;
    });
}

// Short, stable fingerprint of the source string at export time. If the English
// changes while a sheet is out for review, applying the translation would attach
// it to copy that no longer exists — this is how we notice.
export function hashText(t) {
  let h = 0x811c9dc5;
  const s = String(t ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export function placeholdersOf(text) {
  return [...String(text ?? "").matchAll(PLACEHOLDER)].map((m) => m[1]);
}

// A translation must carry exactly the placeholders its source does. Order may
// differ — Arabic, Hindi and Urdu all reorder freely — but a dropped, renamed or
// duplicated token breaks at runtime, so it is rejected rather than written.
export function placeholderDiff(baseText, translation) {
  const a = placeholdersOf(baseText).sort();
  const b = placeholdersOf(translation).sort();
  const missing = a.filter((n) => !b.includes(n));
  const added = b.filter((n) => !a.includes(n));
  const countMismatch =
    a.length === b.length &&
    !missing.length && !added.length &&
    JSON.stringify(a) !== JSON.stringify(b);
  return { missing: [...new Set(missing)], added: [...new Set(added)], countMismatch };
}

// Fixed vocabulary so "this reason came up six times" is a count, not a guess.
// Free-text alone never clusters. `routesTo` is what turns a recurring reason
// into the right rule file rather than a generic note.
export const REASON_CATEGORIES = [
  { code: "TERM",   label: "Terminology",            routesTo: "glossary",          severity: "P0" },
  { code: "BRAND",  label: "Brand / untranslatable", routesTo: "glossary",          severity: "P0" },
  { code: "TONE",   label: "Tone & register",        routesTo: "voice-rules §4",    severity: "P1" },
  { code: "PERSON", label: "Person & address",       routesTo: "voice-rules §3",    severity: "P1" },
  { code: "GRAM",   label: "Grammar & syntax",       routesTo: "voice-rules §3",    severity: "P1" },
  { code: "NUM",    label: "Numbers/dates/currency", routesTo: "voice-rules §2/§5", severity: "P0" },
  { code: "PUNCT",  label: "Punctuation & script",   routesTo: "voice-rules §2",    severity: "P2" },
  { code: "VAR",    label: "Placeholder",            routesTo: "voice-rules §7.1",  severity: "P0" },
  { code: "MEAN",   label: "Meaning changed",        routesTo: "(defect — no rule)", severity: "P0" },
  { code: "LEN",    label: "Length / layout",        routesTo: "(design, not copy)", severity: "P2" },
  { code: "SRC",    label: "Source English unclear", routesTo: "(back to content design)", severity: "P1" },
  { code: "OTHER",  label: "Other",                  routesTo: "(triage manually)", severity: "P2" },
];

export const REASON_CODES = REASON_CATEGORIES.map((c) => c.code);
