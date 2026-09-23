// Minimal Figma REST client for the link-pass: pull the text nodes under one
// frame/section. Auth is a Figma personal access token (FIGMA_API_KEY env) —
// figma.com → Settings → Security → Personal access tokens (File content:read
// scope is enough).

const FIGMA_API = "https://api.figma.com";

export const FIGMA_KEY_HELP =
  "Set FIGMA_API_KEY: figma.com → Settings → Security → Personal access tokens → generate one with " +
  "'File content: read' scope, then add it to the server's env (plugin config, claude mcp add -e, or .env).";

function requireFigmaKey() {
  const key = process.env.FIGMA_API_KEY;
  if (!key) throw new Error(`FIGMA_API_KEY is not set. ${FIGMA_KEY_HELP}`);
  return key;
}

// Accepts figma.com/design|file|proto/{fileKey}/…?node-id={id}. A node-id is
// required — whole-file processing is deliberately blocked so a pasted link to
// a big file can't create thousands of stray items. Figma URL-encodes ':' in
// node IDs as '-'; restore it.
export function parseFigmaUrl(url) {
  const fileMatch = url.match(/figma\.com\/(?:design|file|proto)\/([a-zA-Z0-9]+)/);
  if (!fileMatch) throw new Error(`Not a Figma file URL: ${url}`);
  const nodeMatch = url.match(/node-id=([^&]+)/);
  if (!nodeMatch) {
    throw new Error(
      "The Figma URL must include a node-id — in Figma, right-click the frame or section and choose " +
        "'Copy link to selection'. (Whole-file links are blocked on purpose.)",
    );
  }
  return {
    fileKey: fileMatch[1],
    nodeId: decodeURIComponent(nodeMatch[1]).replace(/-/g, ":"),
  };
}

async function figmaFetch(path) {
  const res = await fetch(`${FIGMA_API}${path}`, { headers: { "X-Figma-Token": requireFigmaKey() } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 403) throw new Error(`Figma rejected the token (403). ${FIGMA_KEY_HELP}`);
    throw new Error(`Figma GET ${path} → ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

// Generic component placeholder strings that should never become copy items.
const FIGMA_PLACEHOLDERS = new Set([
  "button", "label", "description", "sample text", "sample text here",
  "section header text", "trailing label text", "trailing supporting text",
  "leading label text", "leading supporting text", "supporting text",
  "placeholder text", "body text", "9:41",
]);

export function normalizeText(t) {
  return (t || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Longest pure-digit run still treated as mock junk rather than copy. Stray
// single/double digits in a mock ("4", "12" — list indices, step counters,
// badge numbers) are noise; anything longer is real dynamic content.
const MAX_PLACEHOLDER_DIGITS = 2;

export function isPlaceholder(text) {
  if (!text?.trim()) return true;
  const t = normalizeText(text);
  if (t.length <= 1) return true;
  // Pure-digit texts USED to be discarded wholesale, which silently dropped
  // every bare numeric value in a design — order numbers, reference IDs,
  // account numbers, OTP codes — before they ever reached Ditto. Those are
  // exactly the strings that most need a variable, so they were invisible not
  // just to variablisation but to the whole handoff: no item, no linkage, no
  // translation. Only short runs are junk now. (Found 27 Aug 2026: a real
  // "Order no." row whose value "648476283017361" never became an item.)
  if (/^\d+$/.test(t) && t.length <= MAX_PLACEHOLDER_DIGITS) return true;
  return FIGMA_PLACEHOLDERS.has(t);
}

// Text nodes in the subtree under nodeId only (never the whole file).
// → [{ figmaNodeId, text, pageId, topLevelFrameId, frameName, position }]
export async function getFigmaTextNodes(fileKey, nodeId) {
  const data = await figmaFetch(`/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`);
  const nodes = [];
  for (const entry of Object.values(data.nodes || {})) {
    if (entry?.document) walk(entry.document, nodes, { pageId: null, frameId: null, frameName: null });
  }
  // A single-node fetch never includes the CANVAS ancestor, so `walk` can't learn
  // the real page and every node falls back to "0:1" — wrong for any frame not on
  // the first page, which breaks Ditto's frame grouping (it keys on figmaPageId).
  // Resolve the true page once (a selection lives on exactly one page) and stamp it.
  if (nodes.length) {
    const realPageId = await resolvePageId(fileKey, nodeId);
    if (realPageId) for (const n of nodes) n.pageId = realPageId;
  }
  return nodes;
}

// The page (CANVAS) a selection lives under. The file endpoint with `ids=` only
// expands the subtree that leads to the requested node, so among all canvases
// exactly one comes back with children — that's the page. Best-effort: on any
// failure we leave the walk's fallback pageId in place rather than throw.
async function resolvePageId(fileKey, nodeId) {
  try {
    const data = await figmaFetch(`/v1/files/${fileKey}?ids=${encodeURIComponent(nodeId)}&depth=2`);
    const canvases = (data.document?.children || []).filter((c) => c.type === "CANVAS");
    return canvases.find((c) => (c.children || []).length > 0)?.id || null;
  } catch {
    return null;
  }
}

// Any of these can be the top-level container of a screen.
const SCREEN_CONTAINERS = new Set(["FRAME", "INSTANCE", "COMPONENT", "COMPONENT_SET", "GROUP"]);

function walk(node, results, ctx) {
  if (!node) return;
  // Hidden layers: Figma marks only the hidden node itself, not its children —
  // pruning here excludes text under a hidden parent too.
  if (node.visible === false) return;
  const next = { ...ctx };
  if (node.type === "CANVAS") next.pageId = node.id;
  // The SCREEN is the outermost container below the selection root, whatever
  // its type. Recording it only for FRAME meant that on a file whose screens are
  // INSTANCEs (a common pattern — screens built from a template component), the
  // walk descended past the 393x852 screen and treated the first nested FRAME as
  // the screen instead. A "Learn more" label inside a 77px auto-layout button
  // then looked like it lived on a 77px screen and was rejected, while the rest
  // of the copy on that same screen imported fine.
  if (SCREEN_CONTAINERS.has(node.type) && !ctx.frameId) {
    const fb = node.absoluteBoundingBox || {};
    next.frameId = node.id;
    next.frameName = node.name;
    next.frameWidth = fb.width || 0;
    next.frameHeight = fb.height || 0;
    next.frameType = node.type;
  }
  // Ancestor container names are the raw material for a semantic developer ID:
  // "repayment-card__summary" says far more about a string's purpose than the
  // string itself does. Instances carry the component name, which is better
  // still — it names the ROLE ("Button", "Section header"). Kept shallow (the
  // nearest 4) because deeper ancestors describe the screen, not the element.
  if (node.name && node.type !== "TEXT") {
    next.ancestors = [...(ctx.ancestors || []), node.name].slice(-4);
  }
  if (node.type === "INSTANCE" && node.name) next.componentName = node.name;
  // A COMPONENT / COMPONENT_SET holds real product copy even though it sits
  // loose on the canvas rather than inside a phone frame — that is simply where
  // Figma keeps component definitions. Without this, every design-system
  // component's copy is misread as an annotation.
  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") next.inComponent = true;
  // Tracked separately from inComponent: a COMPONENT_SET is N variants of ONE
  // component, so its strings are duplicates by construction.
  if (node.type === "COMPONENT_SET") {
    next.componentSetId = node.id;
    next.componentSetName = node.name;
  }
  // Which variant within the set this text belongs to — Figma names variants
  // "Property 1=Value", and the FIRST child of the set is the default.
  if (node.type === "COMPONENT" && ctx.componentSetId && !ctx.variantId) {
    next.variantId = node.id;
    next.variantName = node.name;
  }
  if (node.type === "TEXT" && node.characters?.trim()) {
    const bbox = node.absoluteBoundingBox || {};
    const st = node.style || {};
    results.push({
      figmaNodeId: node.id,
      text: node.characters,
      pageId: next.pageId || "0:1",
      topLevelFrameId: next.frameId || node.id,
      frameName: next.frameName || "Unknown",
      position: { x: bbox.x || 0, y: bbox.y || 0, width: bbox.width || 0, height: bbox.height || 0 },
      // Naming signals. `layerName` is often junk (copy-paste debris like
      // "Sync Contacts" on an interest note) so it is offered, never trusted.
      // Dimensions of the enclosing top-level frame, so callers can tell a
      // product screen from a slide, a spec board or a loose annotation.
      frameWidth: next.frameWidth || 0,
      frameHeight: next.frameHeight || 0,
      inFrame: !!next.frameId,
      frameType: next.frameType || null,
      inComponent: !!next.inComponent,
      componentSetId: next.componentSetId || null,
      componentSetName: next.componentSetName || null,
      variantId: next.variantId || null,
      variantName: next.variantName || null,
      layerName: node.name || null,
      ancestors: next.ancestors || [],
      componentName: next.componentName || null,
      fontSize: st.fontSize || null,
      fontWeight: st.fontWeight || null,
    });
  }
  for (const child of node.children || []) walk(child, results, next);
}

// ---- product screen vs annotation ----------------------------------------
//
// A design file holds far more text than the product does: presentation slides,
// spec boards, sticky notes, "TO-BE" labels, and a designer's running commentary
// beside the screens. On the SNPL page, "For ditto integration only" and a
// paragraph about an upcoming layout change sat as loose TEXT nodes directly
// under the section, right next to six real 393x852 phone screens. All of it
// became Ditto items.
//
// The reliable signal is structural, not textual: product copy lives INSIDE a
// device-sized frame. Annotations are either loose on the canvas/section, or
// inside a frame that is obviously not a phone (a 1920x1080 slide).

// Generous enough for iPhone SE (320) through to a large Android (480), and for
// a tall scrolling artboard. Override per call when a project designs tablet.
// minHeight exists because width alone cannot separate a screen from a cropped
// detail: a 353x520 "installment 2-6" frame is phone-width but is an excerpt of
// a screen, not a screen. Real screens in the files seen so far are >=852px tall.
export const DEFAULT_SCREEN_BOUNDS = { minWidth: 280, maxWidth: 600, minHeight: 600 };

export function classifyTextNode(node, bounds = DEFAULT_SCREEN_BOUNDS) {
  const b = { ...DEFAULT_SCREEN_BOUNDS, ...bounds };

  // A COMPONENT_SET is N variants of ONE component: "Split in 5" / "Split in 6"
  // are the same string in different states, so importing the set produces
  // duplicates by construction that then have to be merged. Only the default
  // variant — Figma's first child of the set — carries the canonical copy.
  if (node.componentSetId && node.variantId && node.variantId !== node.defaultVariantId) {
    return {
      onScreen: false,
      reason:
        `non-default variant "${node.variantName || "?"}" of component set "${node.componentSetName || "?"}" — ` +
        "variants restate one component's copy, so only the default variant is imported " +
        "(pass includeComponentSets to import every variant)",
    };
  }

  // A single component definition is product copy wherever it sits on the canvas
  // — that is simply where Figma stores it.
  if (node.inComponent) return { onScreen: true };

  if (!node.inFrame) {
    return { onScreen: false, reason: "not inside any frame or component — loose text on the canvas or section" };
  }
  const w = node.frameWidth || 0;
  if (w && (w < b.minWidth || w > b.maxWidth)) {
    return {
      onScreen: false,
      reason: `screen is ${Math.round(w)}px wide — outside the ${b.minWidth}-${b.maxWidth}px device range ` +
        `(slide, spec board or documentation frame)`,
    };
  }
  const h = node.frameHeight || 0;
  if (h && h < b.minHeight) {
    return {
      onScreen: false,
      reason:
        `screen is only ${Math.round(h)}px tall (under ${b.minHeight}) — looks like a cropped detail or excerpt ` +
        "rather than a full screen. CHECK THIS ONE: a legitimate bottom-sheet or short modal frame would " +
        "also land here, and should be imported by lowering minHeight",
    };
  }
  return { onScreen: true };
}

// Split extracted nodes into the copy that belongs in Ditto and the rest.
// Returns both halves: what is skipped must be reported, never silently dropped
// — a designer whose annotation is excluded should be told, and a real screen
// wrongly excluded has to be visible to be fixable.
export function partitionByScreen(nodes, bounds = DEFAULT_SCREEN_BOUNDS, opts = {}) {
  // Figma returns a component set's children in document order, so its first
  // variant is the default. Resolve that once per set, then every text node in
  // the set knows whether it belongs to the default variant.
  const defaultVariantBySet = new Map();
  for (const n of nodes) {
    if (n.componentSetId && n.variantId && !defaultVariantBySet.has(n.componentSetId)) {
      defaultVariantBySet.set(n.componentSetId, n.variantId);
    }
  }
  // Which frames draw a keyboard. A lone "Search" is a button; a "Search" beside
  // "space" and "123" is the return key.
  const keyboardFrames = new Set();
  for (const n of nodes) {
    if (KEY_UNAMBIGUOUS.test(String(n.text ?? "").trim())) keyboardFrames.add(n.topLevelFrameId);
  }

  const onScreen = [], offScreen = [];
  for (const raw of nodes) {
    const n = raw.componentSetId
      ? { ...raw, defaultVariantId: defaultVariantBySet.get(raw.componentSetId) }
      : raw;
    let c = opts.includeComponentSets && n.componentSetId
      ? { onScreen: true }
      : classifyTextNode(n, bounds);
    // Content signals run even on text that passed the structural checks —
    // that is the whole point: this documentation sits inside a real 393px
    // frame and no size rule can see it.
    if (c.onScreen) {
      const content = classifyContent(n.text, {
        ...opts,
        frameHasKeyboard: keyboardFrames.has(n.topLevelFrameId),
      });
      if (content) c = { onScreen: false, reason: `${content.check} — ${content.reason}` };
    }
    (c.onScreen ? onScreen : offScreen).push(c.onScreen ? n : { ...n, skipReason: c.reason });
  }
  return { onScreen, offScreen };
}

// ---- content-level signals ----------------------------------------------
//
// The structural checks above cannot see design documentation that sits INSIDE
// a phone-sized frame. All of these were imported from one 393px frame and had
// to be deleted by hand: a "📌 Note:" annotation, a 1,000-character bilingual
// interaction spec, a designer's name, typed mock values ("abby", "toy") and a
// mocked-up iOS keyboard ("123", "space", "return", "a|").
//
// Each signal is separately named in the reason, and each is overridable,
// because every one of them can be wrong about a specific string. There is
// deliberately NO "looks like a person's name" heuristic: "Yue Sui" is
// structurally identical to a legitimate name label, and "abby"/"toy" are
// indistinguishable from real short copy. That judgement belongs to the agent.

const ANNOTATION_MARKER = /^\s*(?:[📌📍⚠️🚧✏️🔴🟡🔵]|note\s*:|todo\s*:|tbd\s*:|fyi\s*:|wip\s*:)/i;

// Keyboard chrome, split by how ambiguous the key is.
//
// UNAMBIGUOUS keys are never product copy: nothing in a payments app is labelled
// "space" or "#+=".
const KEY_UNAMBIGUOUS = /^(?:space|return|shift|abc|123|#\+=|[a-z]\|)$/i;
// AMBIGUOUS keys are also real button labels — "Search", "Go", "Done" and
// "Next" appear as genuine CTAs across this workspace, and "Search" alone is
// used in ten projects. Rejecting them on sight would delete real copy, so they
// only count as chrome when an unambiguous key sits in the SAME frame: a
// keyboard is drawn as a whole, never as a lone "Search".
const KEY_AMBIGUOUS = /^(?:go|done|next|search|delete|send)$/i;

const SCRIPTS = {
  latin: /[A-Za-z]/,
  arabic: /[\u0600-\u06FF\u0750-\u077F]/,
  devanagari: /[\u0900-\u097F]/,
  cjk: /[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/,
  cyrillic: /[\u0400-\u04FF]/,
  thai: /[\u0E00-\u0E7F]/,
};

// Which scripts a project legitimately contains. Configurable because it is
// workspace-specific: this one ships Arabic, Hindi and Urdu, so a
// Latin-only rule would reject real copy.
export const DEFAULT_ALLOWED_SCRIPTS = ["latin", "arabic", "devanagari"];

function foreignScripts(text, allowed) {
  const found = [];
  for (const [name, re] of Object.entries(SCRIPTS)) {
    if (allowed.includes(name)) continue;
    if (re.test(text)) found.push(name);
  }
  return found;
}

export function classifyContent(text, opts = {}) {
  const t = String(text ?? "");
  const trimmed = t.trim();
  if (!trimmed) return null;
  const allowedScripts = opts.allowedScripts || DEFAULT_ALLOWED_SCRIPTS;
  const specMinLength = opts.specMinLength ?? 200;
  const skip = new Set(opts.disableContentChecks || []);

  if (!skip.has("ANNOTATION_MARKER") && ANNOTATION_MARKER.test(trimmed)) {
    return { check: "ANNOTATION_MARKER", reason: "starts with an annotation marker (📌, ⚠️, 'Note:' …) — a designer's note, not product copy" };
  }
  if (!skip.has("KEYBOARD_CHROME")) {
    if (KEY_UNAMBIGUOUS.test(trimmed)) {
      return { check: "KEYBOARD_CHROME", reason: `the whole string is "${trimmed}" — a mocked-up keyboard key, not copy the product owns` };
    }
    if (opts.frameHasKeyboard && KEY_AMBIGUOUS.test(trimmed)) {
      return {
        check: "KEYBOARD_CHROME",
        reason: `"${trimmed}" is a keyboard key here — this frame also contains unambiguous keys ` +
          "(space/return/123). On a frame without them it would be treated as a real button label",
      };
    }
  }
  if (!skip.has("FOREIGN_SCRIPT")) {
    const foreign = foreignScripts(trimmed, allowedScripts);
    if (foreign.length) {
      return {
        check: "FOREIGN_SCRIPT",
        reason: `contains ${foreign.join(", ")} script, which this project does not ship ` +
          `(allowed: ${allowedScripts.join(", ")}) — usually a spec written in another language`,
      };
    }
  }
  if (!skip.has("SPEC_PROSE") && trimmed.length > specMinLength && /\n/.test(trimmed)) {
    return {
      check: "SPEC_PROSE",
      reason: `${trimmed.length} characters with line breaks inside one text node — real body copy is ` +
        "rarely both this long and this structured; reads as an interaction spec",
    };
  }
  return null;
}
