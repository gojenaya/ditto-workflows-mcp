// CLDR plural categories, and detection of strings that should have them.
//
// Every tool in this server used to filter `pluralForm === null`, so plural
// forms were invisible: they could be neither read nor written. The cost is
// concrete — `{{installment_count}} installments` shipped to Arabic with one
// form only, which is wrong for five of Arabic's six categories.
//
// Ditto's own API does NOT validate categories against the locale: writing a
// `few` form onto English returns 200 and creates a form the language has no
// rule for, which no runtime will ever select. Validation therefore has to
// happen here.

// Which categories a locale actually uses, per CLDR. Only the languages this
// workspace plausibly ships are listed; anything unknown falls back to the
// safe minimum rather than guessing wrong.
const CLDR = {
  ar: ["zero", "one", "two", "few", "many", "other"],
  he: ["one", "two", "many", "other"],
  ru: ["one", "few", "many", "other"],
  uk: ["one", "few", "many", "other"],
  pl: ["one", "few", "many", "other"],
  cs: ["few", "many", "one", "other"],
  sk: ["few", "many", "one", "other"],
  lt: ["one", "few", "many", "other"],
  lv: ["zero", "one", "other"],
  ro: ["one", "few", "other"],
  ga: ["one", "two", "few", "many", "other"],
  cy: ["zero", "one", "two", "few", "many", "other"],
  fr: ["one", "many", "other"],
  pt: ["one", "many", "other"],
  es: ["one", "many", "other"],
  it: ["one", "many", "other"],
  // one/other — the large majority
  en: ["one", "other"], de: ["one", "other"], nl: ["one", "other"],
  hi: ["one", "other"], ur: ["one", "other"], bn: ["one", "other"],
  tr: ["one", "other"], el: ["one", "other"], sv: ["one", "other"],
  da: ["one", "other"], fi: ["one", "other"], no: ["one", "other"],
  // no grammatical plural at all
  id: ["other"], ms: ["other"], ja: ["other"], ko: ["other"],
  zh: ["other"], th: ["other"], vi: ["other"],
};

export const ALL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"];

// A Ditto variant id is not always a bare language code ("indonesian",
// "pt-BR"), so normalise before looking up.
const ALIASES = { indonesian: "id", bahasa: "id", arabic: "ar", hindi: "hi", urdu: "ur", english: "en" };

export function localeOf(variantId) {
  if (!variantId || variantId === "base") return "en";
  const v = String(variantId).toLowerCase();
  if (ALIASES[v]) return ALIASES[v];
  return v.split(/[-_]/)[0];
}

export function categoriesFor(variantId) {
  const lang = localeOf(variantId);
  // Unknown language: assume one/other. Over-restricting is safer than
  // silently accepting a category the runtime will never select.
  return CLDR[lang] || ["one", "other"];
}

export function knownLocale(variantId) {
  return Boolean(CLDR[localeOf(variantId)]);
}

// Validate a set of plural forms against the target locale.
// Returns { valid, invalid: [{form, why}], missing: [...] }.
export function validatePluralForms(variantId, forms) {
  const allowed = categoriesFor(variantId);
  const lang = localeOf(variantId);
  const given = Object.keys(forms || {});
  const invalid = [];
  for (const f of given) {
    if (!ALL_CATEGORIES.includes(f)) {
      invalid.push({ form: f, why: `not a CLDR category (expected one of ${ALL_CATEGORIES.join(", ")})` });
    } else if (!allowed.includes(f)) {
      invalid.push({
        form: f,
        why: `'${lang}' has no '${f}' category — its categories are ${allowed.join(", ")}. ` +
          "Ditto accepts the write, but no runtime will ever select this form.",
      });
    }
  }
  const missing = allowed.filter((a) => !given.includes(a));
  return { valid: invalid.length === 0, invalid, missing, allowed };
}

// ---- plural-candidate detection -----------------------------------------

// A number-bearing placeholder: the name says it counts something.
const COUNT_PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]*(?:count|num|number|qty|quantity|total|days?|months?|years?|weeks?|hours?|minutes?|times?|items?|payments?|installments?)[A-Za-z0-9_]*)\s*\}\}/i;

// Nouns that pluralise and commonly follow a count in this product.
const COUNTABLE = /\b(installments?|payments?|days?|months?|years?|weeks?|hours?|minutes?|items?|transactions?|cards?|accounts?|users?|people|times?|attempts?|steps?|bills?|orders?|repayments?|contacts?|messages?|files?|photos?|options?)\b/i;

// Placeholder names that are emphatically NOT counts, however countable the
// word beside them is. "{{card_last4}} card" is one card with a number on it.
const NOT_A_COUNT = /(last_?4|amount|balance|price|fee|rate|date|time|name|email|phone|url|link|code|_id$|^id$|currency|address)/i;

// Does this string look like it needs plural forms?
// Deliberately conservative: a false positive costs a reviewer ten seconds, a
// false negative ships a grammatically wrong translation.
export function isPluralCandidate(text) {
  const t = String(text ?? "");

  // Strongest signal, and it does not depend on the placeholder's NAME: a
  // placeholder sitting immediately before a countable noun is a count,
  // whatever it is called. "Confirm {{tenor}} payments" is the live example —
  // `tenor` reads as a duration, but it substitutes 3 or 6 and the noun after
  // it inflects. This case already has plural forms in SNPL, so a detector
  // that missed it would be missing the very thing it is for.
  const adjacent = t.match(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}\s*([A-Za-z]+)/);
  if (adjacent && COUNTABLE.test(adjacent[2]) && !NOT_A_COUNT.test(adjacent[1])) {
    return {
      placeholder: adjacent[1],
      noun: adjacent[2],
      why: `"${adjacent[2]}" directly follows {{${adjacent[1]}}}, so it inflects with whatever that substitutes`,
    };
  }

  const ph = t.match(COUNT_PLACEHOLDER);
  if (!ph) return null;
  // The NOT_A_COUNT guard has to apply here too, not only to the positional
  // rule: "{{installment_amount}}" contains "installment" and
  // "{{total_repayment_amount}}" contains "repayment", but both are money.
  if (NOT_A_COUNT.test(ph[1])) return null;

  // A string that is ONLY a placeholder has no word to inflect, so it cannot
  // need plural forms however its placeholder is named.
  if (!t.replace(/\{\{[^}]*\}\}/g, " ").match(/[A-Za-z]{2,}/)) return null;

  // The countable noun must be NEAR the placeholder — "{{days}} days" and
  // "Split in {{installment_count}}" both qualify, but a count at one end of a
  // paragraph and an unrelated noun at the other does not.
  const at = t.indexOf(ph[0]);
  const window = t.slice(Math.max(0, at - 24), at + ph[0].length + 24);
  const noun = window.match(COUNTABLE);

  // A count placeholder whose NAME carries the noun still qualifies even with
  // no noun in the text — "Split in {{installment_count}}" is the live case.
  const nameCarriesNoun = COUNTABLE.test(ph[1].replace(/_/g, " "));
  if (!noun && !nameCarriesNoun) return null;

  return {
    placeholder: ph[1],
    noun: noun ? noun[0] : `(implied by the placeholder name "${ph[1]}")`,
    why: noun
      ? `"${ph[1]}" counts, and "${noun[0]}" next to it inflects with the count`
      : `"${ph[1]}" names a count, so the surrounding phrase inflects with it`,
  };
}

// Scan items and report which need plural forms in a given variant, and which
// already have them.
export function findPluralCandidates(items, variantId, { existingForms = new Map() } = {}) {
  const allowed = categoriesFor(variantId);
  const out = [];
  for (const it of items) {
    const hit = isPluralCandidate(it.text);
    if (!hit) continue;
    const have = existingForms.get(it.id) || [];
    // A locale with a single category cannot be "missing" plural forms.
    if (allowed.length <= 1) continue;
    const missing = allowed.filter((a) => !have.includes(a));
    if (!missing.length) continue;
    out.push({
      id: it.id,
      text: it.text,
      ...hit,
      variantId,
      locale: localeOf(variantId),
      requiredCategories: allowed,
      existingForms: have,
      missingForms: missing,
    });
  }
  return out;
}
