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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { dittoFetch, dittoPatch } from "./ditto-api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(__dirname, "translation-assets");

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

// Skip strings that shouldn't be translated (pure numbers/symbols/emoji).
function isTranslatable(text) {
  if (!text?.trim()) return false;
  if (/^[\p{Emoji}\p{S}\p{N}\p{P}\s]+$/u.test(text)) return false;
  return true;
}

// ─── SERVER ────────────────────────────────────────────────────────────────────

const server = new McpServer({ name: "ditto-workflows-mcp", version: "0.2.0" });

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
  "list_untranslated",
  {
    title: "List untranslated strings",
    description:
      "Return the base text items in a project that do NOT yet have the given variant (default 'ar'). " +
      "Each result is {id, text}. Translate these yourself using the glossary resource, then call write_translations.",
    inputSchema: {
      projectId: z.string().describe("Ditto project developer ID"),
      variantId: z.string().default("ar").describe("Variant to check for (default 'ar')"),
    },
  },
  async ({ projectId, variantId }) => {
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
      "item's developer ID. Creates the variant if missing. Defaults: variant 'ar', status 'WIP'.",
    inputSchema: {
      translations: z
        .array(z.object({ id: z.string(), text: z.string() }))
        .describe("Array of {id, text} — id is the base item developer ID"),
      variantId: z.string().default("ar").describe("Variant to write (default 'ar')"),
      status: z.enum(["NONE", "WIP", "REVIEW", "FINAL"]).default("WIP"),
    },
  },
  async ({ translations, variantId, status }) => {
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

    const body = {
      ...(variantId ? { variantId } : {}),
      updates: targetIds.map((id) => ({ developerId: id, status, projectId })),
    };

    // Partial-failure retry: drop IDs the API reports as not found — e.g. base
    // items with no variant yet — and patch the rest.
    let updated = 0;
    const skipped = [];
    try {
      await dittoPatch(body);
      updated = body.updates.length;
    } catch (err) {
      // Ditto phrases this singular ("developer ID x not found") or plural ("developer IDs x, y not found")
      const m = err.message.match(/developer IDs? (.+?) not found/);
      if (m) {
        m[1].split(",").map((s) => s.trim()).forEach((id) => skipped.push(id));
        const bad = new Set(skipped);
        const filtered = body.updates.filter((u) => !bad.has(u.developerId));
        if (filtered.length) await dittoPatch({ ...body, updates: filtered });
        updated = filtered.length;
      } else if (err.message.includes("No text items found")) {
        updated = 0;
      } else {
        throw err;
      }
    }

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

// Glossary + voice rules as a resource so Claude applies the locked terms.
// Swap the files in translation-assets/ to adapt to another team's glossary.
server.registerResource(
  "ar-glossary",
  "ditto://glossary/ar",
  {
    title: "Arabic glossary + voice rules",
    description: "Locked terminology and voice rules for Arabic translation.",
    mimeType: "text/markdown",
  },
  async (uri) => {
    const parts = [];
    for (const f of ["ar-glossary.md", "ar-voice-rules.md"]) {
      const p = path.join(ASSETS, f);
      if (fs.existsSync(p)) parts.push(`# ${f}\n\n` + fs.readFileSync(p, "utf8"));
    }
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: parts.join("\n\n---\n\n") || "(glossary files not found)",
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("ditto-workflows-mcp server running (stdio).");
