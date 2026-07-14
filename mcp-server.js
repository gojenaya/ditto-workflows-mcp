#!/usr/bin/env node
// ditto-workflows-mcp — an MCP server for Ditto (dittowords.com) so designers/PMs can
// drive copy workflows from Claude.
//
// v1 exposes the fully-headless (public-API-key) operations: the translation
// loop (Claude does the translation using the glossary served as a resource —
// no DeepL) plus project reads and status updates. Browser/JWT operations
// (Figma link-pass, dev-ID rename) are intentionally out of v1.
//
// Auth: DITTO_API_KEY env var, or a .env file next to this script.
// Run:  node mcp-server.js   (stdio transport; wire via .mcp.json / claude mcp add)
//
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { dittoFetch, dittoPatch } from "./ditto-api.js";
import { getDefaultVariant, setDefaultVariant, DATA_DIR, CONFIG_PATH } from "./config.js";
import {
  setSessionToken, getSessionToken, tokenExpiry, validateToken,
  fetchWorkspaceDump, renameDevId, projectMongoIdByDevId,
  createTextItem, connectTextItems, fetchLibraryComponents, linkComponent,
  newObjectId, toRichText, TOKEN_HELP,
} from "./ditto-backend.js";
import { parseFigmaUrl, getFigmaTextNodes, isPlaceholder, normalizeText, FIGMA_KEY_HELP } from "./figma-api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Glossary/TM files: an explicit env override, else a translation-assets/ dir
// next to the script (clone installs keep working), else the per-user data dir
// (the only stable location under npx — see config.js).
const ASSETS =
  process.env.DITTO_ASSETS_DIR ||
  (fs.existsSync(path.join(__dirname, "translation-assets"))
    ? path.join(__dirname, "translation-assets")
    : path.join(DATA_DIR, "translation-assets"));

// Load .env from this script's dir — Claude Code launches MCP servers without
// the shell env.
function loadDotEnv() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* no .env — rely on real env */ }
}
loadDotEnv();

if (!process.env.DITTO_API_KEY) {
  console.error("ditto-workflows-mcp: missing DITTO_API_KEY (env or .env)");
  process.exit(1);
}

// ─── HELPERS ───────────────────────────────────────────────────────────────────

// Base text items for a project (variantId === null), any status.
async function fetchBaseItems(projectId) {
  const filter = JSON.stringify({
    projects: [{ id: projectId }],
    statuses: ["NONE", "WIP", "REVIEW", "FINAL"],
  });
  const all = await dittoFetch(`/textItems?filter=${encodeURIComponent(filter)}`);
  return all.filter((i) => i.variantId === null && i.pluralForm === null);
}

// Dev IDs that already have the given variant.
async function fetchVariantIds(projectId, variantId) {
  const filter = JSON.stringify({
    projects: [{ id: projectId }],
    variants: [{ id: variantId }, { id: "base" }],
  });
  const all = await dittoFetch(`/textItems?filter=${encodeURIComponent(filter)}`);
  return new Set(all.filter((i) => i.variantId === variantId).map((i) => i.id));
}

// Resolve the variant for a call: explicit arg > configured default. No silent
// fallback — a wrong-variant write is worse than an error.
function requireVariant(variantId) {
  const v = variantId || getDefaultVariant();
  if (!v) {
    throw new Error(
      "No variantId given and no default variant configured. " +
        "Call set_default_variant once, or set DITTO_DEFAULT_VARIANT in .env.",
    );
  }
  return v;
}

// Glossary files for a variant: flat `{v}-*.md` files and/or everything in
// `translation-assets/{v}/` (where refresh_translation_assets will write).
function glossaryFiles(variantId) {
  const files = [];
  for (const f of [`${variantId}-glossary.md`, `${variantId}-voice-rules.md`]) {
    const p = path.join(ASSETS, f);
    if (fs.existsSync(p)) files.push(p);
  }
  const dir = path.join(ASSETS, variantId);
  if (fs.existsSync(dir)) {
    // translation-memory.md is raw distillation material, often hundreds of KB —
    // never serve it in the per-session glossary resource.
    for (const f of fs.readdirSync(dir)
      .filter((f) => f.endsWith(".md") && f !== "translation-memory.md")
      .sort()) {
      files.push(path.join(dir, f));
    }
  }
  return files;
}

// Variants that have glossary assets on disk (for resource listing).
function availableVariants() {
  const variants = new Set();
  let entries = [];
  try { entries = fs.readdirSync(ASSETS, { withFileTypes: true }); } catch { /* no assets dir */ }
  for (const e of entries) {
    const m = e.name.match(/^(.+)-(?:glossary|voice-rules)\.md$/);
    if (m) variants.add(m[1]);
    else if (e.isDirectory()) variants.add(e.name);
  }
  return [...variants].sort();
}

// Skip strings that shouldn't be translated (pure numbers/symbols/emoji).
function isTranslatable(text) {
  if (!text?.trim()) return false;
  if (/^[\p{Emoji}\p{S}\p{N}\p{P}\s]+$/u.test(text)) return false;
  return true;
}

// PATCH with partial-failure retry: drop IDs the API reports as not found —
// e.g. base items with no variant yet — and patch the rest.
// Ditto phrases the error singular ("developer ID x not found") or plural
// ("developer IDs x, y not found").
async function patchSkippingUnknown(body) {
  const skipped = [];
  try {
    await dittoPatch(body);
    return { updated: body.updates.length, skipped };
  } catch (err) {
    const m = err.message.match(/developer IDs? (.+?) not found/);
    if (m) {
      m[1].split(",").map((s) => s.trim()).forEach((id) => skipped.push(id));
      const bad = new Set(skipped);
      const filtered = body.updates.filter((u) => !bad.has(u.developerId));
      if (filtered.length) await dittoPatch({ ...body, updates: filtered });
      return { updated: filtered.length, skipped };
    }
    if (err.message.includes("No text items found")) return { updated: 0, skipped };
    throw err;
  }
}

// Dynamic-content detection for variablise: hardcoded values that should be
// {{variable}} placeholders. Ported from the ditto-handoff pipeline's
// variablise.js — the suggestion step is Claude-side, only detection lives here.
const DYNAMIC_PATTERNS = [
  { pattern: /\b\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}\b/i, type: "date" },
  { pattern: /[$€£¥₹]\s*[\d,]+(\.\d{1,2})?/, type: "amount" },
  // Currency code before OR after the number: "AED 8.00" and "8.00 AED".
  { pattern: /\b(AED|USD|EUR|GBP|SAR|INR|PKR|PHP)\s*[\d,]+(\.\d{1,2})?/i, type: "amount" },
  { pattern: /\b[\d,]+(\.\d{1,2})?\s*(AED|USD|EUR|GBP|SAR|INR|PKR|PHP)\b/i, type: "amount" },
  { pattern: /\b\d+(\.\d+)?%/, type: "percentage" },
  { pattern: /[•*]{4}\s*\d{4}/, type: "card_last4" },
  { pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/, type: "email" },
];

// Design-mock status-bar times ("9:41") are dynamic-looking but never real copy.
function isStatusBarTime(text) {
  return /^\d{1,2}[:.]\d{2}(\s?(AM|PM))?$/i.test(text.trim());
}

function detectDynamicTypes(text) {
  const types = new Set();
  for (const { pattern, type } of DYNAMIC_PATTERNS) {
    if (pattern.test(text)) types.add(type);
  }
  return [...types];
}

// ─── SERVER ────────────────────────────────────────────────────────────────────

const server = new McpServer({ name: "ditto-workflows-mcp", version: "0.9.0" });

server.registerTool(
  "list_projects",
  {
    title: "List Ditto projects",
    description: "List the projects in the Ditto workspace (id + name).",
    inputSchema: {},
  },
  async () => {
    const projects = await dittoFetch("/projects");
    return {
      content: [{ type: "text", text: JSON.stringify(projects, null, 2) }],
    };
  },
);

server.registerTool(
  "list_components",
  {
    title: "List Ditto components",
    description:
      "List the workspace's component library (shared, reusable strings): {id, name, text, status, folderId}. " +
      "Check here before writing new copy for common strings (CTAs, errors, labels) — reusing a component " +
      "keeps copy consistent across projects. Optionally scope to one folder.",
    inputSchema: {
      folderId: z.string().optional().describe("Only components in this folder (default: all)"),
    },
  },
  async ({ folderId }) => {
    const filter = folderId
      ? `?filter=${encodeURIComponent(JSON.stringify({ folders: [{ id: folderId }] }))}`
      : "";
    const all = await dittoFetch(`/components${filter}`);
    const components = all
      .filter((c) => c.variantId === null && c.pluralForm === null)
      .map((c) => ({ id: c.id, name: c.name, text: c.text, status: c.status, folderId: c.folderId }));
    return {
      content: [
        { type: "text", text: JSON.stringify({ count: components.length, components }, null, 2) },
      ],
    };
  },
);

server.registerTool(
  "search_text",
  {
    title: "Search workspace text",
    description:
      "Case-insensitive substring search over base text items (whole workspace, or one project) and the " +
      "component library. Reuse-oriented: before writing a new string, search for it — an existing item or " +
      "component may already cover it. Also handy for locating which project/block a string lives in. " +
      "Returns matches as {id, text, projectId, status} plus component matches; capped at `limit` each.",
    inputSchema: {
      query: z.string().min(1).describe("Substring to search for (case-insensitive)"),
      projectId: z.string().optional().describe("Limit to this project (default: whole workspace)"),
      limit: z.number().int().positive().max(200).default(50).describe("Max matches returned per list"),
    },
  },
  async ({ query, projectId, limit }) => {
    const filter = JSON.stringify({
      ...(projectId ? { projects: [{ id: projectId }] } : {}),
      statuses: ["NONE", "WIP", "REVIEW", "FINAL"],
    });
    const [items, comps] = await Promise.all([
      dittoFetch(`/textItems?filter=${encodeURIComponent(filter)}`),
      dittoFetch("/components"),
    ]);
    const q = query.toLowerCase();
    const matches = (list) =>
      list.filter(
        (i) => i.variantId === null && i.pluralForm === null && i.text?.toLowerCase().includes(q),
      );

    const textMatches = matches(items);
    const compMatches = matches(comps);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              query,
              textItems: {
                count: textMatches.length,
                ...(textMatches.length > limit ? { truncatedTo: limit } : {}),
                matches: textMatches
                  .slice(0, limit)
                  .map((i) => ({ id: i.id, text: i.text, projectId: i.projectId, status: i.status })),
              },
              components: {
                count: compMatches.length,
                ...(compMatches.length > limit ? { truncatedTo: limit } : {}),
                matches: compMatches
                  .slice(0, limit)
                  .map((c) => ({ id: c.id, name: c.name, text: c.text, folderId: c.folderId })),
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "list_untranslated",
  {
    title: "List untranslated strings",
    description:
      "Return the base text items in a project that do NOT yet have the given variant (defaults to the " +
      "configured default variant). Each result is {id, text}. Translate these yourself using the " +
      "ditto://glossary/{variantId} resource, then call write_translations.",
    inputSchema: {
      projectId: z.string().describe("Ditto project developer ID"),
      variantId: z.string().optional().describe("Variant to check for (default: configured default variant)"),
    },
  },
  async ({ projectId, variantId }) => {
    variantId = requireVariant(variantId);
    const [base, have] = await Promise.all([
      fetchBaseItems(projectId),
      fetchVariantIds(projectId, variantId),
    ]);
    const untranslated = base
      .filter((i) => !have.has(i.id) && isTranslatable(i.text))
      .map((i) => ({ id: i.id, text: i.text }));
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { projectId, variantId, count: untranslated.length, items: untranslated },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "write_translations",
  {
    title: "Write variant translations",
    description:
      "Write translated variants back to Ditto (public API). Each translation is {id, text} where id is the base " +
      "item's developer ID. Creates the variant if missing. Defaults: configured default variant, status 'WIP'.",
    inputSchema: {
      translations: z
        .array(z.object({ id: z.string(), text: z.string() }))
        .describe("Array of {id, text} — id is the base item developer ID"),
      variantId: z.string().optional().describe("Variant to write (default: configured default variant)"),
      status: z.enum(["NONE", "WIP", "REVIEW", "FINAL"]).default("WIP"),
    },
  },
  async ({ translations, variantId, status }) => {
    variantId = requireVariant(variantId);
    if (!translations.length) {
      return { content: [{ type: "text", text: "No translations provided." }] };
    }
    await dittoPatch({
      variantId,
      forceVariantCreation: true,
      updates: translations.map((t) => ({
        developerId: t.id,
        text: t.text,
        status,
      })),
    });
    return {
      content: [
        {
          type: "text",
          text: `Wrote ${translations.length} '${variantId}' variant(s) at status ${status}.`,
        },
      ],
    };
  },
);

server.registerTool(
  "list_variablisation_candidates",
  {
    title: "List variablisation candidates",
    description:
      "Find base text items in a project containing hardcoded dynamic values (dates, amounts, percentages, " +
      "card last-4, emails) that should be {{variable}} placeholders, plus the workspace's existing variables. " +
      "You suggest the replacements: prefer semantically specific names ({{installment_amount}}, not {{amount}}); " +
      "reuse an existing variable only when it genuinely fits; keep static text exactly as-is. Present the " +
      "suggestions for user approval, then apply via update_text. Placeholders are written as literal " +
      "{{name}} text — variables the workspace lacks must be created in the Ditto web app to resolve.",
    inputSchema: {
      projectId: z.string().describe("Ditto project developer ID"),
    },
  },
  async ({ projectId }) => {
    const [base, variables] = await Promise.all([
      fetchBaseItems(projectId),
      dittoFetch("/variables"),
    ]);
    const candidates = base
      .filter(
        (i) =>
          i.text?.trim() &&
          !i.text.includes("{{") &&
          !isStatusBarTime(i.text) &&
          detectDynamicTypes(i.text).length,
      )
      .map((i) => ({ id: i.id, text: i.text, types: detectDynamicTypes(i.text) }));
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              projectId,
              count: candidates.length,
              candidates,
              variables: variables.map((v) => ({
                id: v.id,
                type: v.type,
                example: v.data?.example ?? null,
              })),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "update_text",
  {
    title: "Update base text",
    description:
      "Rewrite the text of BASE items in a project (copy edits, {{variable}} replacements). Each update is " +
      "{id, text} where id is the item's developer ID; unknown IDs are skipped, not fatal. Status is left " +
      "unchanged unless given. Note: {{name}} placeholders land as literal text — the public API cannot link " +
      "workspace variables to items, and dev-ID renames aren't supported either; both happen in the Ditto web app.",
    inputSchema: {
      projectId: z.string().describe("Ditto project developer ID"),
      updates: z
        .array(z.object({ id: z.string(), text: z.string() }))
        .describe("Array of {id, text} — id is the base item developer ID"),
      status: z.enum(["NONE", "WIP", "REVIEW", "FINAL"]).optional()
        .describe("Also set this workflow status (default: leave unchanged)"),
    },
  },
  async ({ projectId, updates, status }) => {
    if (!updates.length) {
      return { content: [{ type: "text", text: "No updates provided." }] };
    }
    const { updated, skipped } = await patchSkippingUnknown({
      updates: updates.map((u) => ({
        developerId: u.id,
        text: u.text,
        projectId,
        ...(status ? { status } : {}),
      })),
    });
    return {
      content: [{
        type: "text",
        text: `Updated text on ${updated} base item(s).` +
          (status ? ` Status → ${status}.` : "") +
          (skipped.length ? ` Skipped ${skipped.length} unknown ID(s): ${skipped.join(", ")}` : ""),
      }],
    };
  },
);

server.registerTool(
  "list_for_review",
  {
    title: "List translations awaiting review",
    description:
      "Return a project's variant translations awaiting review (default: statuses WIP and REVIEW), each " +
      "joined with its base text: {id, base, translation, status}. Reviewer flow: present each translation " +
      "alongside its base text; the reviewer approves, edits, or skips. Push edits via write_translations " +
      "with status FINAL; promote untouched approvals via update_status with the variantId and status FINAL.",
    inputSchema: {
      projectId: z.string().describe("Ditto project developer ID"),
      variantId: z.string().optional().describe("Variant to review (default: configured default variant)"),
      statuses: z
        .array(z.enum(["NONE", "WIP", "REVIEW", "FINAL"]))
        .default(["WIP", "REVIEW"])
        .describe("Variant statuses to include (default: WIP + REVIEW)"),
    },
  },
  async ({ projectId, variantId, statuses }) => {
    variantId = requireVariant(variantId);
    // One call for base + variant; status is filtered client-side so base items
    // at other statuses still join.
    const filter = JSON.stringify({
      projects: [{ id: projectId }],
      variants: [{ id: variantId }, { id: "base" }],
    });
    const all = await dittoFetch(`/textItems?filter=${encodeURIComponent(filter)}`);

    const baseText = new Map();
    for (const i of all) {
      if (i.variantId === null && i.pluralForm === null) baseText.set(i.id, i.text);
    }
    const items = all
      .filter(
        (i) =>
          i.variantId === variantId &&
          i.pluralForm === null &&
          statuses.includes(i.status) &&
          baseText.has(i.id),
      )
      .map((i) => ({ id: i.id, base: baseText.get(i.id), translation: i.text, status: i.status }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { projectId, variantId, statuses, count: items.length, items },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "update_status",
  {
    title: "Update text item / variant status",
    description:
      "Set the workflow status of text items in a project. By default targets BASE items; pass variantId " +
      "(e.g. 'ar') to target that variant instead. Pass ids to scope to specific developer IDs, or omit ids " +
      "and pass fromStatus to move everything currently at that status (or any of a list of statuses) — e.g. " +
      "fromStatus ['NONE','WIP','REVIEW'] with status 'REVIEW' stages everything for review WITHOUT touching " +
      "FINAL items. fromStatus works for base items or a variant (with variantId). " +
      "IDs with no matching item/variant are skipped, not fatal.",
    inputSchema: {
      projectId: z.string().describe("Ditto project developer ID"),
      status: z.enum(["NONE", "WIP", "REVIEW", "FINAL"]).describe("Status to set"),
      ids: z.array(z.string()).optional().describe("Developer IDs to update (omit = derive from fromStatus)"),
      fromStatus: z.union([
        z.enum(["NONE", "WIP", "REVIEW", "FINAL"]),
        z.array(z.enum(["NONE", "WIP", "REVIEW", "FINAL"])),
      ]).optional()
        .describe("When ids omitted: update all items (base, or the variant if variantId is set) currently at this status or any status in this list"),
      variantId: z.string().optional().describe("Target this variant (e.g. 'ar') instead of base items"),
    },
  },
  async ({ projectId, status, ids, fromStatus, variantId }) => {
    let targetIds = ids;
    if (!targetIds) {
      if (!fromStatus) {
        return { content: [{ type: "text", text: "Provide either ids or fromStatus." }], isError: true };
      }
      const froms = Array.isArray(fromStatus) ? fromStatus : [fromStatus];
      // For a variant, fetch base+variant and pick variant rows at those statuses;
      // otherwise base rows at those statuses.
      const filter = variantId
        ? JSON.stringify({ projects: [{ id: projectId }], variants: [{ id: variantId }, { id: "base" }] })
        : JSON.stringify({ projects: [{ id: projectId }], statuses: froms });
      const items = await dittoFetch(`/textItems?filter=${encodeURIComponent(filter)}`);
      targetIds = items
        .filter((i) =>
          i.pluralForm === null &&
          (variantId ? i.variantId === variantId : i.variantId === null) &&
          froms.includes(i.status))
        .map((i) => i.id);
    }
    if (!targetIds.length) {
      return { content: [{ type: "text", text: "No matching items to update." }] };
    }

    const { updated, skipped } = await patchSkippingUnknown({
      ...(variantId ? { variantId } : {}),
      updates: targetIds.map((id) => ({ developerId: id, status, projectId })),
    });

    const target = variantId ? `'${variantId}' variant(s)` : "base item(s)";
    return {
      content: [{
        type: "text",
        text: `Set ${updated} ${target} → ${status}.` +
          (skipped.length ? ` Skipped ${skipped.length} unknown ID(s): ${skipped.join(", ")}` : ""),
      }],
    };
  },
);

server.registerTool(
  "refresh_translation_assets",
  {
    title: "Refresh translation assets",
    description:
      "Fetch every translation of the variant at status FINAL (= approved by the workspace's translation " +
      "expert) across the whole workspace, paired with its base text, and write a translation-memory file " +
      "into translation-assets/{variant}/. Returns the pair count, file path, and a sample; the file can be " +
      "hundreds of KB, so read it in chunks when distilling locked terms and tone patterns into glossary " +
      "files (which the ditto://glossary/{variantId} resource serves). Run when approved copy has changed " +
      "and the glossary needs re-distilling.",
    inputSchema: {
      variantId: z.string().optional().describe("Variant to refresh (default: configured default variant)"),
    },
  },
  async ({ variantId }) => {
    variantId = requireVariant(variantId);
    // No projects filter = whole workspace. Base + variant come back in one list.
    const filter = JSON.stringify({ variants: [{ id: variantId }, { id: "base" }] });
    const all = await dittoFetch(`/textItems?filter=${encodeURIComponent(filter)}`);

    const baseText = new Map();
    for (const i of all) {
      if (i.variantId === null && i.pluralForm === null) baseText.set(i.id, i.text);
    }
    const pairs = [];
    const seen = new Set();
    for (const i of all) {
      if (i.variantId !== variantId || i.status !== "FINAL" || i.pluralForm !== null) continue;
      if (seen.has(i.id) || !baseText.has(i.id)) continue;
      seen.add(i.id);
      pairs.push({ id: i.id, base: baseText.get(i.id), translation: i.text });
    }
    pairs.sort((a, b) => a.id.localeCompare(b.id)); // stable file diffs across refreshes

    const dir = path.join(ASSETS, variantId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "translation-memory.md");
    fs.writeFileSync(
      file,
      [
        `# Translation memory — '${variantId}' (auto-generated ${new Date().toISOString().slice(0, 10)})`,
        "",
        "FINAL-status (expert-approved) base → variant pairs from the Ditto workspace.",
        "Regenerated by refresh_translation_assets — do not hand-edit; put manual rules",
        "in other files served by the glossary resource.",
        "",
        ...pairs.map(
          (p) =>
            `- base: ${p.base.replace(/\n/g, "\n    ")}\n  ${variantId}: ${p.translation.replace(/\n/g, "\n    ")}`,
        ),
        "",
      ].join("\n"),
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              variantId,
              count: pairs.length,
              wrote: file,
              note: "Full pairs are in the file — read it in chunks to distill glossary/tone rules.",
              sample: pairs.slice(0, 30),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "set_default_variant",
  {
    title: "Set default variant",
    description:
      "Set the workspace's default variant (e.g. 'ar', 'fr'). Persisted locally, so it only needs setting " +
      "once; all tools use it whenever variantId is omitted.",
    inputSchema: {
      variantId: z.string().min(1).describe("Ditto variant ID to use as the default"),
    },
  },
  async ({ variantId }) => {
    setDefaultVariant(variantId);
    return {
      content: [{ type: "text", text: `Default variant set to '${variantId}' (saved to ${CONFIG_PATH}).` }],
    };
  },
);

// ─── UNOFFICIAL BACKEND TOOLS (session JWT, not the API key) ───────────────────
// These replay the Ditto web app's own internal API for operations the public
// API can't do. Unversioned — Ditto can break them silently. Kept apart from
// the public-API tools so a breakage stays diagnosable.

server.registerTool(
  "set_session_token",
  {
    title: "Set Ditto session token (unofficial)",
    description:
      "Store a Ditto browser-session JWT for this server session, enabling the UNOFFICIAL backend tools " +
      "(currently: rename_developer_id) that the public API can't cover. The token expires after a while — " +
      "when a backend tool reports it expired, paste a fresh one here (no server restart needed). " +
      TOKEN_HELP,
    inputSchema: {
      token: z.string().min(20).describe("The Authorization header value from a backend.dittowords.com request (with or without 'Bearer ')"),
    },
  },
  async ({ token }) => {
    setSessionToken(token);
    const exp = tokenExpiry(getSessionToken());
    try {
      await validateToken();
    } catch (err) {
      return { content: [{ type: "text", text: `Token stored but validation failed: ${err.message}` }], isError: true };
    }
    const expNote = exp
      ? exp > new Date()
        ? ` Expires ${exp.toISOString()} (~${Math.round((exp - Date.now()) / 60000)} min from now).`
        : ` NOTE: token claims to be already expired (${exp.toISOString()}) yet still validated — Ditto may not enforce exp strictly.`
      : "";
    return { content: [{ type: "text", text: `Session token set and validated against the backend.${expNote}` }] };
  },
);

server.registerTool(
  "login_to_ditto",
  {
    title: "Log in to Ditto in a browser (captures session token)",
    description:
      "Open a real browser window on app.dittowords.com so the user can sign in like normal — the session " +
      "token is captured automatically and stored (no devtools, no copy-pasting). Use this when a backend " +
      "tool reports a missing/expired session token. The login is remembered in a local browser profile, so " +
      "future refreshes usually complete hands-free in seconds. First ever run installs a small browser-" +
      "automation helper into the local data dir (~40 MB, one-time, may take a minute). Tell the user a " +
      "browser window is about to open before calling this.",
    inputSchema: {},
  },
  async () => {
    const loginScript = path.join(__dirname, "ditto-login.js");
    const helperDir = path.join(DATA_DIR, "login-helper");
    const env = { ...process.env, DITTO_DATA_DIR: DATA_DIR };

    const run = (cmd, args, timeoutMs) =>
      new Promise((resolve) => {
        const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "", stderr = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
        child.on("error", (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(err) }); });
      });

    const attempt = () => run(process.execPath, [loginScript], 6 * 60 * 1000);

    let result = await attempt();
    let parsed = null;
    try { parsed = JSON.parse(result.stdout.trim().split("\n").pop()); } catch { /* no JSON */ }

    // First run: playwright isn't installed anywhere — install it into our own
    // data dir (keeps it out of the npm package deps) and retry once.
    if (parsed?.needsPlaywright) {
      fs.mkdirSync(helperDir, { recursive: true });
      const install = await run(
        "npm",
        ["install", "playwright", "--prefix", helperDir, "--no-fund", "--no-audit"],
        3 * 60 * 1000,
      );
      if (install.code !== 0) {
        return {
          content: [{
            type: "text",
            text: `Could not install the browser-automation helper (npm exit ${install.code}): ` +
              `${install.stderr.slice(-300)}\nManual fallback: ${TOKEN_HELP}`,
          }],
          isError: true,
        };
      }
      result = await attempt();
      try { parsed = JSON.parse(result.stdout.trim().split("\n").pop()); } catch { parsed = null; }
    }

    if (!parsed?.ok || !parsed.token) {
      return {
        content: [{
          type: "text",
          text: `Browser login failed: ${parsed?.error || result.stderr.slice(-300) || "no output"}\n` +
            `Manual fallback: ${TOKEN_HELP}`,
        }],
        isError: true,
      };
    }

    setSessionToken(parsed.token);
    try {
      await validateToken();
    } catch (err) {
      return { content: [{ type: "text", text: `Token captured but validation failed: ${err.message}` }], isError: true };
    }
    const exp = tokenExpiry(getSessionToken());
    return {
      content: [{
        type: "text",
        text: "Logged in — session token captured, validated, and cached." +
          (exp ? ` Expires ${exp.toISOString()} (~${Math.round((exp - Date.now()) / 3600000)}h from now).` : ""),
      }],
    };
  },
);

server.registerTool(
  "figma_link_pass",
  {
    title: "Link a Figma frame's copy into Ditto (unofficial)",
    description:
      "Pull every text node under a Figma frame/section and wire it into a Ditto project: texts matching an " +
      "existing item are connected to it, new texts become WIP items (created + connected), and texts matching " +
      "a library component are additionally linked to that component. Returns created items with their " +
      "auto-generated developer IDs and screen (frame) names — use rename_developer_id afterwards to give the " +
      "new items semantic IDs. UNOFFICIAL: uses Ditto's internal backend (session token — login_to_ditto) plus " +
      "the Figma REST API (FIGMA_API_KEY env). The Figma URL must be a 'Copy link to selection' link with a " +
      "node-id; the target project must already contain at least one text item.",
    inputSchema: {
      projectId: z.string().describe("Ditto project developer ID (public API id, e.g. from list_projects)"),
      figmaUrl: z.string().describe("Figma 'Copy link to selection' URL (must contain node-id)"),
    },
  },
  async ({ projectId, figmaUrl }) => {
    const { fileKey, nodeId } = parseFigmaUrl(figmaUrl);

    // 1. Figma text nodes under the selection (placeholders + hidden pruned).
    const figmaNodes = await getFigmaTextNodes(fileKey, nodeId);
    const realNodes = figmaNodes.filter((n) => !isPlaceholder(n.text));
    if (!realNodes.length) {
      return {
        content: [{ type: "text", text: `No real copy found under that Figma node (${figmaNodes.length} text node(s), all placeholders/empty).` }],
      };
    }

    // 2. Project mongo id (direct backend lookup — works on empty projects) +
    //    existing items by normalised text from the workspace dump.
    const mongoProjectId = await projectMongoIdByDevId(projectId);
    const dump = await fetchWorkspaceDump();
    const projectItems = dump.filter((it) => it.doc_ID === mongoProjectId);
    const textToItems = new Map();
    for (const item of projectItems) {
      if (!item.text) continue;
      const key = normalizeText(item.text);
      if (!textToItems.has(key)) textToItems.set(key, []);
      textToItems.get(key).push(item);
    }

    // 3. Dedup Figma nodes by text (3× "Get started" → 1 item, 3 instances),
    //    then bucket: connect-to-existing / create / ambiguous.
    const byText = new Map();
    for (const node of realNodes) {
      const key = normalizeText(node.text);
      if (!byText.has(key)) byText.set(key, { text: node.text, instances: [] });
      byText.get(key).instances.push(node);
    }
    const toLink = [];
    const toCreate = [];
    const ambiguous = [];
    for (const { text, instances } of byText.values()) {
      const candidates = textToItems.get(normalizeText(text)) || [];
      if (candidates.length === 0) toCreate.push({ text, instances });
      else if (candidates.length === 1) toLink.push({ item: candidates[0], instances });
      else ambiguous.push({ text: text.slice(0, 80), candidates: candidates.length });
    }

    // 4. Create new WIP items (one POST each — we need the _ids back).
    const created = [];
    const createFailed = [];
    for (const { text, instances } of toCreate) {
      try {
        const item = await createTextItem(mongoProjectId, text);
        created.push({ item: { ...item, text }, instances });
      } catch (err) {
        createFailed.push({ text: text.slice(0, 80), error: err.message });
      }
    }

    // 5. One connect PATCH for everything.
    const instancesByItemId = {};
    for (const { item, instances } of [...toLink, ...created]) {
      if (!item._id) continue;
      instancesByItemId[item._id] = instances.map((node) => ({
        _id: newObjectId(),
        figmaNodeId: node.figmaNodeId,
        figmaPageId: node.pageId,
        figmaTopLevelFrameId: node.topLevelFrameId,
        lastReconciledRichText: toRichText(node.text),
        appliedVariantId: null,
        position: node.position,
      }));
    }
    const totalInstances = Object.values(instancesByItemId).reduce((a, arr) => a + arr.length, 0);
    if (totalInstances) await connectTextItems(mongoProjectId, instancesByItemId);

    // 6. Component links: texts that also exist as library components get
    //    linked to them (skipping items already linked — idempotent).
    const componentLinks = [];
    try {
      const compIndex = new Map();
      for (const c of await fetchLibraryComponents()) {
        const key = normalizeText(c.text);
        if (key && !compIndex.has(key)) compIndex.set(key, c);
      }
      const linkByComp = new Map();
      for (const { item } of [...toLink, ...created]) {
        const hit = compIndex.get(normalizeText(item.text));
        if (!hit || !item._id) continue;
        if (Array.isArray(hit.instances) && hit.instances.includes(item._id)) continue;
        if (!linkByComp.has(hit._id)) linkByComp.set(hit._id, { component: hit, itemIds: [] });
        linkByComp.get(hit._id).itemIds.push(item._id);
      }
      for (const [compId, { component, itemIds }] of linkByComp) {
        try {
          await linkComponent(compId, mongoProjectId, itemIds);
          componentLinks.push({ component: component.developerId || component.name, items: itemIds.length });
        } catch (err) {
          componentLinks.push({ component: component.developerId || component.name, error: err.message });
        }
      }
    } catch (err) {
      componentLinks.push({ error: `component pass skipped: ${err.message}` });
    }

    // 7. Re-fetch for the auto-assigned dev IDs of created items, and map each
    //    to its screen (frame name) — context for semantic rename suggestions.
    const after = await fetchWorkspaceDump();
    const byMongoId = new Map(after.filter((i) => i.doc_ID === mongoProjectId).map((i) => [i._id, i]));
    const createdReport = created.map(({ item, instances }) => ({
      devId: byMongoId.get(item._id)?.developerId || null,
      text: item.text,
      screen: instances[0]?.frameName || "Unknown",
      instances: instances.length,
    }));
    const linkedReport = toLink.map(({ item, instances }) => ({
      devId: item.developerId,
      text: item.text.slice(0, 80),
      screen: instances[0]?.frameName || "Unknown",
      instances: instances.length,
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              projectId,
              figma: { fileKey, nodeId },
              counts: {
                figmaTextNodes: figmaNodes.length,
                afterPlaceholderFilter: realNodes.length,
                uniqueTexts: byText.size,
                connectedToExisting: toLink.length,
                created: created.length,
                createFailed: createFailed.length,
                ambiguousSkipped: ambiguous.length,
                instancesConnected: totalInstances,
              },
              created: createdReport,
              connectedToExisting: linkedReport,
              ...(ambiguous.length ? { ambiguous } : {}),
              ...(createFailed.length ? { createFailed } : {}),
              ...(componentLinks.length ? { componentLinks } : {}),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "rename_developer_id",
  {
    title: "Rename developer IDs (unofficial)",
    description:
      "Rename text-item developer IDs in a project — an operation the public API does not support. " +
      "UNOFFICIAL: replays the Ditto web app's internal backend API (unversioned; may break without notice) " +
      "and needs a session token (set_session_token) rather than the API key. Each rename is {from, to}. " +
      "Skips (with reasons) unknown 'from' IDs and 'to' IDs that already exist. Verifies via the public API " +
      "afterwards. Keep new IDs kebab-case and reasonably short.",
    inputSchema: {
      projectId: z.string().describe("Ditto project developer ID (public API id, e.g. from list_projects)"),
      renames: z
        .array(z.object({ from: z.string().min(1), to: z.string().min(1) }))
        .min(1)
        .describe("Array of {from, to} developer-ID renames"),
    },
  },
  async ({ projectId, renames }) => {
    // 1. Project mongo id via direct backend lookup, then its items from the dump.
    const mongoProjectId = await projectMongoIdByDevId(projectId);
    const dump = await fetchWorkspaceDump();

    // devId → mongo _id within the project
    const idMap = new Map();
    const backendDevIds = new Set();
    for (const it of dump) {
      if (it.doc_ID !== mongoProjectId || !it.developerId) continue;
      idMap.set(it.developerId, it._id);
      backendDevIds.add(it.developerId);
    }

    // 3. Validate + apply sequentially.
    const results = [];
    const pendingTo = new Set();
    for (const { from, to } of renames) {
      if (from === to) {
        results.push({ from, to, status: "skipped", reason: "from and to are identical" });
      } else if (!idMap.has(from)) {
        results.push({ from, to, status: "skipped", reason: "no item with this developer ID in the project" });
      } else if (backendDevIds.has(to) || pendingTo.has(to)) {
        results.push({ from, to, status: "skipped", reason: "an item with the target ID already exists" });
      } else {
        try {
          await renameDevId(mongoProjectId, idMap.get(from), to);
          pendingTo.add(to);
          results.push({ from, to, status: "renamed" });
        } catch (err) {
          results.push({ from, to, status: "failed", reason: err.message });
        }
      }
    }

    // 4. Verify the successful ones via the public API (cache-busted read).
    const renamed = results.filter((r) => r.status === "renamed");
    if (renamed.length) {
      const after = new Set((await fetchBaseItems(projectId)).map((i) => i.id));
      for (const r of renamed) {
        r.verified = after.has(r.to) && !after.has(r.from);
      }
    }

    const counts = results.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ projectId, counts, results }, null, 2),
        },
      ],
    };
  },
);

// Glossary + voice rules as a resource so Claude applies the locked terms.
// Any variant with files in translation-assets/ works: flat `{v}-glossary.md` /
// `{v}-voice-rules.md`, or a `{v}/` folder of .md files.
server.registerResource(
  "glossary",
  new ResourceTemplate("ditto://glossary/{variantId}", {
    list: async () => ({
      resources: availableVariants().map((v) => ({
        uri: `ditto://glossary/${v}`,
        name: `'${v}' glossary + voice rules`,
        mimeType: "text/markdown",
      })),
    }),
  }),
  {
    title: "Variant glossary + voice rules",
    description:
      "Locked terminology and voice rules for translating into a variant. Read this before translating.",
    mimeType: "text/markdown",
  },
  async (uri, { variantId }) => {
    const parts = glossaryFiles(variantId).map(
      (p) => `# ${path.basename(p)}\n\n` + fs.readFileSync(p, "utf8"),
    );
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text:
            parts.join("\n\n---\n\n") ||
            `(no glossary files for variant '${variantId}' — add ${variantId}-glossary.md ` +
              `and ${variantId}-voice-rules.md, or a ${variantId}/ folder of .md files, under ${ASSETS})`,
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("ditto-workflows-mcp server running (stdio).");
