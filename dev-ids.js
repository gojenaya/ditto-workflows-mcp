// Semantic developer IDs.
//
// Ditto's backend names a new item by slugging its copy, which produces
// `enter-your-botim-pay-password-`, `abc-1` and `13`. Those are the IDs
// engineers then reference, and a rename pass afterwards only fixes them when
// someone remembers to run it. This module is the machinery for naming items
// from what the design actually says about them — the container they sit in,
// the component they belong to, their size and weight — and for refusing a bad
// ID at the point of writing rather than catching it later.
//
// Two things it deliberately does NOT do: trust a Figma layer name (they are
// frequently copy-paste debris — an interest note in SNPL sits on a layer called
// "Sync Contacts", a figure on one called "Info"), and name things itself when
// the structure is uninformative. That judgement belongs to the agent, which is
// why buildDigest exists.

import * as fs from "fs";
import * as path from "path";
import { DATA_DIR } from "./config.js";

const MEMORY_PATH = path.join(DATA_DIR, "dev-id-memory.json");

export function kebab(s) {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, " ")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase()
    .replace(/^-|-$/g, "");
}

// Names that describe where a layer sits rather than what it says. A generic
// Figma layer name is worse than no name: it looks deliberate in the ID.
const GENERIC = new Set([
  "title", "subtitle", "label", "text", "content", "container", "frame", "group",
  "body", "header", "footer", "item", "row", "column", "cell", "value", "main",
  "description", "caption", "heading", "placeholder", "info", "detail", "details",
  "leading", "trailing", "slot", "wrapper", "box", "element", "component",
  "leading-label-text", "trailing-label-text", "supporting-text", "page-header",
  "instruction-text", "step-number", "letter", "number",
]);

export function isGenericName(name) {
  const k = kebab(name);
  if (!k) return true;
  if (GENERIC.has(k)) return true;
  // "title-2", "label-copy-3"
  return GENERIC.has(k.replace(/-(?:\d+|copy)$/g, ""));
}

// Would this ID just be the copy again? That is what we are replacing, so an ID
// derived from the text is rejected however it was produced.
export function isCopyDerived(id, text) {
  const a = kebab(id);
  const b = kebab(text);
  if (!a || !b) return false;
  // Ditto's own pattern is slug-plus-counter when the slug is taken: "abc-1"
  // from "ABC", "home-2" from "Home". Compare with the counter stripped, or
  // those read as deliberate names.
  const bare = a.replace(/-\d+$/, "");
  if (a === b || bare === b) return true;
  // It also truncates long slugs: "set-up-auto-debit-for-automati".
  if (b.startsWith(a) && a.length >= 12) return true;
  if (a.startsWith(b) && b.length >= 12) return true;
  if (b.startsWith(bare) && bare.length >= 12) return true;
  return false;
}

const MAX_LEN = 30;

// One gate in front of every write. Returns [] when the ID is acceptable.
export function validateDevId(id, { text = "", taken = new Set() } = {}) {
  const problems = [];
  const k = kebab(id);
  if (!k) { return ["empty"]; }
  if (k !== id) problems.push(`not kebab-case (suggest '${k}')`);
  if (k.length > MAX_LEN) problems.push(`too long (${k.length} > ${MAX_LEN})`);
  if (/^\d+$/.test(k)) problems.push("all digits");
  if (/-\d+$/.test(k) && isGenericName(k.replace(/-\d+$/, ""))) problems.push("generic + counter");
  if (isGenericName(k)) problems.push("generic name — says nothing about purpose");
  if (isCopyDerived(k, text)) problems.push("derived from the copy — that is what we are replacing");
  if (taken.has(k)) problems.push("already used in this project");
  return problems;
}

// Deterministic naming for the cases where structure genuinely tells us the
// answer. Anything this returns null for is the agent's to name.
const ROLE_SUFFIX = [
  [/\bbutton\b|\bcta\b|\bbtn\b/i, "cta"],
  [/\bsection header\b|\bsectionheader\b/i, "section-title"],
  [/\btop navigation\b|\bnavbar\b|\bapp bar\b/i, "nav-title"],
  [/\btab\b/i, "tab"],
  [/\bbadge\b|\bchip\b|\bpill\b/i, "badge"],
  [/\btooltip\b/i, "tooltip"],
  [/\btoast\b|\bsnackbar\b/i, "toast"],
  [/\bplaceholder\b/i, "placeholder"],
  [/\berror\b/i, "error"],
];

// Visual-variant vocabulary — describes how a control LOOKS, never what it does.
const VARIANT_WORDS = /^(primary|secondary|tertiary|ghost|outline|filled|text|link|small|medium|large|default|active|inactive|disabled|selected)(-|$)/;

export function proposeFromStructure(node, { componentNameByText } = {}) {
  const text = (node.text || "").trim();

  // Tier 1 — the component library already names this string.
  const comp = componentNameByText?.get(text.toLowerCase());
  if (comp) return { id: kebab(comp).slice(0, MAX_LEN), tier: "component", confidence: "high" };

  // Tier 2 — an ancestor names the UI role. Combine with the nearest meaningful
  // container so two buttons on one screen don't collide.
  const chain = [node.componentName, ...(node.ancestors || [])].filter(Boolean);
  for (const [re, suffix] of ROLE_SUFFIX) {
    const hit = chain.find((c) => re.test(c));
    if (!hit) continue;
    // Strip the role word out of the container name to avoid "button-cta".
    let base = kebab(hit).replace(/-?(button|cta|btn|section-header|tab|badge|chip|tooltip|toast)-?/g, "").replace(/^-|-$/g, "");
    // A container named for the button's VISUAL VARIANT tells us nothing about
    // purpose, and every screen has a primary one — "primary-cta" would collide
    // across the project and mean nothing when it did. Fall back to the copy.
    if (VARIANT_WORDS.test(base)) base = "";
    const qualifier = base && !isGenericName(base) ? base : kebab(text).split("-").slice(0, 2).join("-");
    const id = kebab(`${qualifier}-${suffix}`).slice(0, MAX_LEN);
    if (id && !isGenericName(id) && !VARIANT_WORDS.test(id)) return { id, tier: "role", confidence: "medium" };
  }
  return null;
}

// ---- naming memory -------------------------------------------------------
// Re-running a link pass must not churn IDs under engineers. A decision is
// keyed by Figma node, so the same node keeps its name across runs; text is
// stored alongside only to detect when the copy has since changed.

function readMemory() {
  try { return JSON.parse(fs.readFileSync(MEMORY_PATH, "utf8")); } catch { return {}; }
}

export function recallDevIds(fileKey, nodeIds) {
  const mem = readMemory()[fileKey] || {};
  const out = new Map();
  for (const n of nodeIds) if (mem[n]) out.set(n, mem[n]);
  return out;
}

export function rememberDevIds(fileKey, entries) {
  const mem = readMemory();
  const f = (mem[fileKey] ||= {});
  for (const { figmaNodeId, devId, text } of entries) {
    if (!figmaNodeId || !devId) continue;
    f[figmaNodeId] = { devId, text: text ?? "" };
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(mem, null, 2) + "\n");
  return MEMORY_PATH;
}

// ---- digest --------------------------------------------------------------
// What the agent reads to name the rest. One line per string, carrying the
// hierarchy signals (size, weight, container) that a flat text list loses — and
// costing roughly a tenth of what a screenshot per frame would.

export function buildDigest(nodes) {
  const byFrame = new Map();
  for (const n of nodes) {
    const k = n.frameName || "Unknown";
    if (!byFrame.has(k)) byFrame.set(k, []);
    byFrame.get(k).push(n);
  }
  const lines = [];
  for (const [frame, items] of byFrame) {
    lines.push(`## ${frame}`);
    items.sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0) || (a.position?.x ?? 0) - (b.position?.x ?? 0));
    for (const n of items) {
      const sz = n.fontSize ? String(Math.round(n.fontSize)) : "--";
      const w = n.fontWeight >= 600 ? "B" : " ";
      const container = (n.ancestors || []).filter((a) => !isGenericName(a)).slice(-1)[0] || "";
      const text = (n.text || "").replace(/\s+/g, " ").trim().slice(0, 46);
      lines.push(`${sz.padStart(3)}${w} ${JSON.stringify(text).padEnd(48)} ${container}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
