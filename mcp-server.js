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
import { fileURLToPath } from "url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { dittoFetch, dittoPatch } from "./ditto-api.js";
import { getDefaultVariant, setDefaultVariant, DATA_DIR, CONFIG_PATH } from "./config.js";

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
  { pattern: /\b(AED|USD|EUR|GBP|SAR|INR)\s*[\d,]+(\.\d{1,2})?/i, type: "amount" },
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

const server = new McpServer({ name: "ditto-workflows-mcp", version: "0.6.0" });

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
      "and pass fromStatus to move everything at that status (e.g. all WIP → REVIEW). " +
      "IDs with no matching item/variant are skipped, not fatal.",
    inputSchema: {
      projectId: z.string().describe("Ditto project developer ID"),
      status: z.enum(["NONE", "WIP", "REVIEW", "FINAL"]).describe("Status to set"),
      ids: z.array(z.string()).optional().describe("Developer IDs to update (omit = derive from fromStatus)"),
      fromStatus: z.enum(["NONE", "WIP", "REVIEW", "FINAL"]).optional()
        .describe("When ids omitted: update all base items currently at this status"),
      variantId: z.string().optional().describe("Target this variant (e.g. 'ar') instead of base items"),
    },
  },
  async ({ projectId, status, ids, fromStatus, variantId }) => {
    let targetIds = ids;
    if (!targetIds) {
      if (!fromStatus) {
        return { content: [{ type: "text", text: "Provide either ids or fromStatus." }], isError: true };
      }
      const filter = JSON.stringify({ projects: [{ id: projectId }], statuses: [fromStatus] });
      const items = await dittoFetch(`/textItems?filter=${encodeURIComponent(filter)}`);
      targetIds = items.filter((i) => i.variantId === null && i.pluralForm === null).map((i) => i.id);
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
