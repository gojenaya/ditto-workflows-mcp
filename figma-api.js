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
  const onScreen = [], offScreen = [];
  for (const raw of nodes) {
    const n = raw.componentSetId
      ? { ...raw, defaultVariantId: defaultVariantBySet.get(raw.componentSetId) }
      : raw;
    const c = opts.includeComponentSets && n.componentSetId
      ? { onScreen: true }
      : classifyTextNode(n, bounds);
    (c.onScreen ? onScreen : offScreen).push(c.onScreen ? n : { ...n, skipReason: c.reason });
  }
  return { onScreen, offScreen };
}
