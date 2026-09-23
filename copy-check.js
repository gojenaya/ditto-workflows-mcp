// Source-copy defect detection.
//
// Two defects shipped to a live project and were only noticed downstream: an
// item reading "Interes" (missing t) and "Processing fee (inclu. vat)" — a
// mistyped "incl." and a lowercase "vat". The Arabic translator silently
// corrected the first, so base and variant then disagreed about what the string
// even was.
//
// The checks here are deliberately WORKSPACE-RELATIVE rather than dictionary-
// driven. A dictionary does not know "botim", "SNPL", "AECB" or "Aani", so it
// flags brand vocabulary and buries the real findings. But a word that appears
// ONCE in a project while a near-identical word appears fifty times is a typo
// almost every time, and that signal needs no word list at all. The system
// dictionary is used only to raise or lower confidence afterwards.
//
// Nothing here auto-applies. These are copy decisions, and the fix belongs in
// Figma — see the note on variants in the handoff skill.

import * as fs from "fs";

// ---- helpers -------------------------------------------------------------

const WORD = /[A-Za-z][A-Za-z'’]*/g;

// Tokens inside an email address or URL are not prose and must never be
// spell-checked: "gmail" in "example@gmail.com" is one edit from "email", which
// is how the check came to propose renaming a domain. Brand and domain names
// are excluded for the same reason.
const EMAIL_OR_URL = /(\b[\w.+-]+@[\w.-]+\.\w+)|((?:https?:\/\/|www\.)\S+)|(\b[\w-]+\.(?:com|net|org|io|ae|co|app|dev)\b)/gi;

const KNOWN_DOMAINS = new Set([
  "gmail", "outlook", "hotmail", "yahoo", "icloud", "protonmail", "com", "net", "org",
]);

function words(text) {
  // Blank out addresses and URLs before tokenising.
  const cleaned = String(text ?? "").replace(EMAIL_OR_URL, " ");
  return (cleaned.match(WORD) || []).filter((w) => !KNOWN_DOMAINS.has(w.toLowerCase()));
}

// Levenshtein, bailing out as soon as it exceeds `max` — we only ever care
// about distance 1, so the full matrix is wasted work.
function withinDistance(a, b, max = 1) {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
}

// "settings" vs "settings'", "activation" vs "activations" — a one-edit
// difference that is only inflection.
function isInflection(a, b) {
  // A curly apostrophe against a straight one is a punctuation inconsistency,
  // not a spelling mistake — reporting it as "you'd -> you'd" reads as nonsense.
  const flat = (x) => x.replace(/[’']/g, "'");
  if (flat(a) === flat(b)) return true;
  const strip = (x) => flat(x).replace(/'s?$/, "").replace(/s$/, "");
  return strip(a) === strip(b) || a === b + "s" || b === a + "s";
}

// The system word list is Webster's 1934: it has "eye" but not "eyes", "arrive"
// but not "arrived". Checking the stem too stops the typo check from
// "correcting" every regular inflection in the corpus.
function knownWord(w) {
  const d = dictionary();
  if (!d.size) return false;
  if (d.has(w)) return true;
  const stems = [];
  // Plural rules are applied narrowly. Stripping "es" from anything at all lets
  // "interes" reduce to "inter" — a real word — so the typo that motivated this
  // whole module would be classified as known and never reported.
  if (/[^s]s$/.test(w)) stems.push(w.slice(0, -1));                 // eyes -> eye
  if (/(s|x|z|ch|sh)es$/.test(w)) stems.push(w.slice(0, -2));       // buses -> bus
  if (/ies$/.test(w)) stems.push(w.slice(0, -3) + "y");             // cities -> city
  if (/ed$/.test(w)) stems.push(w.slice(0, -2), w.slice(0, -1));    // arrived -> arrive
  if (/ing$/.test(w)) stems.push(w.slice(0, -3), w.slice(0, -3) + "e");
  if (/ly$/.test(w)) stems.push(w.slice(0, -2));
  if (/['’]s?$/.test(w)) stems.push(w.replace(/['’]s?$/, ""));
  for (const stem of stems) if (stem.length > 2 && d.has(stem)) return true;
  return false;
}

let DICT = null;
function dictionary() {
  if (DICT !== null) return DICT;
  try {
    DICT = new Set(
      fs.readFileSync("/usr/share/dict/words", "utf8").split("\n").map((w) => w.trim().toLowerCase()).filter(Boolean),
    );
  } catch {
    DICT = new Set(); // absent on many systems — the checks degrade, they don't fail
  }
  return DICT;
}

// ---- the checks ----------------------------------------------------------

// 1. Near-miss typos. A rare word one edit away from a common one.
function findTypos(items, { rareMax = 2, commonMin = 5 } = {}) {
  const freq = new Map();
  const seenIn = new Map();
  for (const it of items) {
    for (const w of words(it.text)) {
      const k = w.toLowerCase();
      freq.set(k, (freq.get(k) || 0) + 1);
      if (!seenIn.has(k)) seenIn.set(k, []);
      if (seenIn.get(k).length < 4 && !seenIn.get(k).some((x) => x.id === it.id)) seenIn.get(k).push(it);
    }
  }
  const common = [...freq.entries()].filter(([, n]) => n >= commonMin).map(([w]) => w);
  const dict = dictionary();
  // Names — "Saeed", "Nadd", "Aani" — are capitalised every time they appear.
  // A one-edit neighbour of a common word is a coincidence, not a typo.
  const alwaysCapitalised = new Set();
  const everLower = new Set();
  for (const it of items) {
    const raw = String(it.text ?? "");
    for (const m of raw.matchAll(WORD)) {
      const w = m[0];
      const k = w.toLowerCase();
      // Ignore sentence-initial capitals, which say nothing about the word.
      const prev = raw.slice(0, m.index).trimEnd();
      const sentenceStart = prev === "" || /[.!?:]$/.test(prev);
      if (w[0] === w[0].toUpperCase() && !sentenceStart) alwaysCapitalised.add(k);
      else if (w[0] === w[0].toLowerCase()) everLower.add(k);
    }
  }
  const out = [];
  for (const [w, n] of freq) {
    if (n > rareMax || w.length < 4) continue;
    // A rare word that is itself a real word is not a typo — it is a rarer
    // word. Without this the check "corrects" eyes→yes, sims→sms and
    // activations→activation, which buries the genuine findings.
    if (knownWord(w)) continue;
    const near = common.find((c) => c !== w && withinDistance(w, c, 1));
    if (!near) continue;
    // Plurals and possessives differ by one edit from their stem and are not
    // mistakes.
    if (isInflection(w, near) || isInflection(near, w)) continue;
    if (alwaysCapitalised.has(w) && !everLower.has(w)) continue;
    for (const it of seenIn.get(w) || []) {
      out.push({
        check: "TYPO",
        severity: "P1",
        confidence: "high",
        id: it.id,
        text: it.text,
        found: w,
        suggested: near,
        why: `"${w}" appears ${n}× in this project; "${near}" appears ${freq.get(near)}×, one edit away`,
      });
    }
  }
  return out;
}

// 2. Inconsistent abbreviations. "inclu." beside "incl." — one is a slip.
function findAbbreviations(items) {
  const abbrev = new Map(); // lowercased token (with dot) -> {count, items}
  for (const it of items) {
    for (const m of String(it.text ?? "").matchAll(/\b([A-Za-z]{2,10})\.(?!\s*$)/g)) {
      const k = m[1].toLowerCase();
      // "only." and "times." are sentences ending, not abbreviations. A real
      // abbreviation is a truncation, so it is NOT a dictionary word.
      if (dictionary().size && dictionary().has(k)) continue;
      if (!abbrev.has(k)) abbrev.set(k, { count: 0, items: [] });
      const e = abbrev.get(k);
      e.count++;
      if (e.items.length < 4) e.items.push(it);
    }
  }
  const keys = [...abbrev.keys()];
  const out = [];
  for (const k of keys) {
    const mine = abbrev.get(k);
    // Another abbreviation that is a prefix of this one (or vice versa) and is
    // used more often — "incl." vs "inclu.".
    const rival = keys.find(
      (o) =>
        o !== k &&
        (o.startsWith(k) || k.startsWith(o)) &&
        // A slip adds or drops a letter or two ("incl." / "inclu."). A gap of
        // three is two different abbreviations ("app." / "approx.").
        Math.abs(o.length - k.length) <= 2 &&
        abbrev.get(o).count > mine.count,
    );
    if (!rival) continue;
    for (const it of mine.items) {
      out.push({
        check: "ABBREV",
        severity: "P1",
        confidence: "high",
        id: it.id,
        text: it.text,
        found: `${k}.`,
        suggested: `${rival}.`,
        why: `"${k}." is used ${mine.count}× but "${rival}." is used ${abbrev.get(rival).count}× — pick one`,
      });
    }
  }
  return out;
}

// 3. Acronym casing. "vat" beside "VAT", "Faqs" beside "FAQs".
function findAcronymCasing(items) {
  const byLower = new Map(); // lowercased -> Map(exactForm -> {count, items})
  for (const it of items) {
    for (const w of words(it.text)) {
      const k = w.toLowerCase();
      if (k.length < 2 || k.length > 6) continue;
      if (!byLower.has(k)) byLower.set(k, new Map());
      const forms = byLower.get(k);
      if (!forms.has(w)) forms.set(w, { count: 0, items: [] });
      const e = forms.get(w);
      e.count++;
      if (e.items.length < 4) e.items.push(it);
    }
  }
  const out = [];
  for (const [, forms] of byLower) {
    if (forms.size < 2) continue;
    // Only interesting when one of the spellings is a genuine all-caps acronym.
    const entries = [...forms.entries()];
    const upper = entries.find(([f]) => f === f.toUpperCase() && f.length >= 2 && /[A-Z]{2,}/.test(f));
    if (!upper) continue;
    const [upperForm, upperData] = upper;
    // Only when ALL-CAPS is the established convention. Otherwise every
    // sentence-initial "All" beside a mid-sentence "all" becomes a finding.
    const rest = entries.filter(([f]) => f !== upperForm).reduce((n, [, d]) => n + d.count, 0);
    if (upperData.count < 2 || upperData.count <= rest) continue;
    for (const [form, data] of entries) {
      if (form === upperForm) continue;
      for (const it of data.items) {
        out.push({
          check: "ACRONYM",
          severity: "P2",
          confidence: "medium — check it is the acronym and not an ordinary word",
          id: it.id,
          text: it.text,
          found: form,
          suggested: upperForm,
          why: `"${form}" (${data.count}×) and "${upperForm}" (${upperData.count}×) both appear`,
        });
      }
    }
  }
  return out;
}

// Invisible characters Figma inserts or carries through. LINE SEPARATOR is what
// Shift+Enter produces — it looks like an ordinary line break in the canvas and
// is completely invisible in any report that calls it "whitespace".
const INVISIBLES = [
  ["\u2028", "U+2028 LINE SEPARATOR", "Figma writes this for a soft line break (Shift+Enter)"],
  ["\u2029", "U+2029 PARAGRAPH SEPARATOR", "breaks line wrapping unpredictably across renderers"],
  ["\u00A0", "U+00A0 NO-BREAK SPACE", "looks like a space but never wraps"],
  ["\u200B", "U+200B ZERO WIDTH SPACE", "invisible; splits words for search and matching"],
  ["\uFEFF", "U+FEFF BYTE ORDER MARK", "invisible; usually pasted in by accident"],
  ["\u200E", "U+200E LEFT-TO-RIGHT MARK", "bidi control — deliberate only in mixed-script copy"],
  ["\u200F", "U+200F RIGHT-TO-LEFT MARK", "bidi control — deliberate only in mixed-script copy"],
];

// 4. Whitespace and invisible characters. Both break exact-match joins; the
// invisible ones also break rendering, and no reviewer can see them.
function findWhitespace(items) {
  const out = [];
  for (const it of items) {
    const t = String(it.text ?? "");
    if (!t) continue;

    // Reported separately from "whitespace" and BY NAME, because a designer
    // told only that a string has "extra whitespace" has nothing to look for
    // in Figma — the character is invisible there too.
    const found = INVISIBLES.filter(([ch]) => t.includes(ch));
    if (found.length) {
      out.push({
        check: "INVISIBLE",
        severity: "P1",
        confidence: "high",
        id: it.id,
        text: t,
        found: found.map(([, name]) => name).join(", "),
        suggested: found.reduce((acc, [ch]) => acc.split(ch).join(" "), t).replace(/ {2,}/g, " ").trim(),
        why: found.map(([, name, why]) => `${name}: ${why}`).join("; ") +
          ". Invisible in Figma AND in any report that only says 'whitespace'.",
        codepoints: [...t].map((c, i) => (found.some(([ch]) => ch === c) ? `${i}:U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}` : null)).filter(Boolean),
      });
    }

    const problems = [];
    if (t !== t.trim()) problems.push("leading or trailing whitespace");
    if (/ {2,}/.test(t.trim())) problems.push("doubled space");
    if (/\t/.test(t)) problems.push("tab character");
    if (!problems.length) continue;
    out.push({
      check: "SPACING",
      severity: "P2",
      confidence: "high",
      id: it.id,
      text: t,
      found: problems.join(", "),
      suggested: t.replace(/\s+/g, " ").trim(),
      why: "invisible in Figma but breaks exact-text matching, dedupe and translation memory",
    });
  }
  return out;
}

// 5. Trailing punctuation that disagrees between siblings — one block where
//    most sentences end in a full stop and two do not.
function findPunctuation(items) {
  const groups = new Map();
  for (const it of items) {
    const t = String(it.text ?? "").trim();
    // Only sentence-like copy: a label ("Monthly income") legitimately has no
    // full stop, so comparing it against body copy would be noise.
    if (t.split(/\s+/).length < 5) continue;
    const g = it.blockName || "(no block)";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ ...it, trimmed: t });
  }
  const out = [];
  for (const [group, list] of groups) {
    if (list.length < 4) continue; // too few to call a convention
    const withDot = list.filter((x) => /[.!?]$/.test(x.trimmed));
    const without = list.filter((x) => !/[.!?]$/.test(x.trimmed));
    const minority = withDot.length > without.length ? without : withDot;
    const majority = withDot.length > without.length ? withDot : without;
    // Only flag a clear minority — a 50/50 split is a decision, not a slip.
    if (!minority.length || minority.length > list.length * 0.25) continue;
    const majorityEndsWithDot = majority === withDot;
    for (const it of minority.slice(0, 6)) {
      out.push({
        check: "PUNCT",
        severity: "P2",
        confidence: "low — confirm the convention for this block",
        id: it.id,
        text: it.text,
        found: majorityEndsWithDot ? "no trailing full stop" : "trailing full stop",
        suggested: majorityEndsWithDot ? it.trimmed + "." : it.trimmed.replace(/[.!?]+$/, ""),
        why: `${majority.length} of ${list.length} sentences in "${group}" ${majorityEndsWithDot ? "end" : "do not end"} with a full stop`,
      });
    }
  }
  return out;
}

// ---- entry point ---------------------------------------------------------

export function findCopyDefects(items, opts = {}) {
  const findings = [
    ...findTypos(items, opts),
    ...findAbbreviations(items),
    ...findAcronymCasing(items),
    ...findWhitespace(items),
    ...findPunctuation(items),
  ];
  // One row per item+check, most severe first.
  const seen = new Set();
  const rank = { P1: 0, P2: 1, P3: 2 };
  return findings
    .filter((f) => {
      const k = `${f.id}::${f.check}::${f.found}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) || a.id.localeCompare(b.id));
}

export const COPY_CHECKS = [
  { code: "TYPO",    what: "a rare word one edit from a common one" },
  { code: "ABBREV",  what: "the same abbreviation written two ways" },
  { code: "ACRONYM", what: "acronym casing that disagrees across items" },
  { code: "SPACING", what: "leading/trailing whitespace, doubled spaces, tabs" },
  { code: "PUNCT",   what: "trailing punctuation that disagrees between siblings" },
];
