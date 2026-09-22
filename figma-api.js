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

function walk(node, results, ctx) {
  if (!node) return;
  // Hidden layers: Figma marks only the hidden node itself, not its children —
  // pruning here excludes text under a hidden parent too.
  if (node.visible === false) return;
  const next = { ...ctx };
  if (node.type === "CANVAS") next.pageId = node.id;
  if (node.type === "FRAME" && !ctx.frameId) {
    next.frameId = node.id;
    next.frameName = node.name;
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
      layerName: node.name || null,
      ancestors: next.ancestors || [],
      componentName: next.componentName || null,
      fontSize: st.fontSize || null,
      fontWeight: st.fontWeight || null,
    });
  }
  for (const child of node.children || []) walk(child, results, next);
}
