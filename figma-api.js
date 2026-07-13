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

export function isPlaceholder(text) {
  if (!text?.trim()) return true;
  const t = normalizeText(text);
  if (t.length <= 1) return true;
  if (/^\d+$/.test(t)) return true;
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
  return nodes;
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
  if (node.type === "TEXT" && node.characters?.trim()) {
    const bbox = node.absoluteBoundingBox || {};
    results.push({
      figmaNodeId: node.id,
      text: node.characters,
      pageId: next.pageId || "0:1",
      topLevelFrameId: next.frameId || node.id,
      frameName: next.frameName || "Unknown",
      position: { x: bbox.x || 0, y: bbox.y || 0, width: bbox.width || 0, height: bbox.height || 0 },
    });
  }
  for (const child of node.children || []) walk(child, results, next);
}
