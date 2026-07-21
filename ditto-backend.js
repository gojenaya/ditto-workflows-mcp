// UNOFFICIAL client for Ditto's internal backend (backend.dittowords.com).
//
// These endpoints power the Ditto web app. They are unversioned and can change
// without notice — everything here is best-effort and clearly marked unofficial
// in the tools that use it. Public-API tools (ditto-api.js) never depend on
// this module, so a backend breakage stays diagnosable and contained.
//
// Auth is a browser-session JWT, not the workspace API key. The token expires
// after a while; expiry handling IS the feature — callers get a helpful
// "grab a fresh one" message instead of a raw 401. Sources, in order:
//   1. set_session_token tool (in-memory, survives until the server restarts)
//   2. DITTO_JWT env / .env
//
// Endpoints (captured from the web app, verified live 2026-07-01):
//   GET  /text-item?developerIds[]=anything
//     → whole-workspace dump (the filter is ignored); items carry
//       _id (mongo), doc_ID (project mongo id), developerId, text
//   PATCH /ditto-project/{projectMongoId}/text-item/{itemMongoId}/developerId
//     body {"developerId": "new-id"} → 200 {updatedTextItems:[…]}

import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";
import { DATA_DIR } from "./config.js";

const BACKEND = "https://backend.dittowords.com";
const TOKEN_CACHE = path.join(DATA_DIR, "session-token");

let sessionToken = null;

export const TOKEN_HELP =
  "Easiest fix: run the login_to_ditto tool — it opens a browser window, you sign in like normal, " +
  "and the token is captured automatically. Manual alternative: open app.dittowords.com (logged in) → " +
  "devtools → Network tab → any request to backend.dittowords.com → copy the 'Authorization' header " +
  "value → call set_session_token with it.";

export function setSessionToken(token) {
  sessionToken = normalize(token);
  // Cache so a still-valid token survives server restarts (0600 — it's a credential).
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_CACHE, sessionToken, { mode: 0o600 });
  } catch { /* cache is best-effort */ }
}

function normalize(token) {
  if (!token) return null;
  token = token.trim();
  return token.startsWith("Bearer ") ? token : `Bearer ${token}`;
}

function cachedToken() {
  try {
    const token = normalize(fs.readFileSync(TOKEN_CACHE, "utf8"));
    const exp = tokenExpiry(token);
    if (exp && exp < new Date()) return null; // stale — ignore
    return token;
  } catch {
    return null;
  }
}

export function getSessionToken() {
  return sessionToken || normalize(process.env.DITTO_JWT) || cachedToken();
}

// Decode the JWT payload (no verification — just to report expiry to the user).
export function tokenExpiry(token) {
  try {
    const payload = JSON.parse(
      Buffer.from(token.replace(/^Bearer /, "").split(".")[1], "base64url").toString(),
    );
    return payload.exp ? new Date(payload.exp * 1000) : null;
  } catch {
    return null;
  }
}

function requireToken() {
  const token = getSessionToken();
  if (!token) {
    throw new Error(`No session token set. ${TOKEN_HELP}`);
  }
  return token;
}

async function backendFetch(path, init = {}) {
  const token = requireToken();
  const res = await fetch(`${BACKEND}${path}`, {
    ...init,
    headers: {
      Authorization: token,
      "x-ditto-app": "web_app",
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Session token rejected (${res.status}) — it has likely expired. ${TOKEN_HELP}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ditto backend ${init.method || "GET"} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

// Whole-workspace text-item dump with mongo IDs.
export async function fetchWorkspaceDump() {
  const raw = await backendFetch("/text-item?developerIds[]=anything");
  return Array.isArray(raw) ? raw : raw.textItems || raw.items || raw.data || [];
}

// Cheap authenticated call for validating a freshly pasted token.
export async function validateToken() {
  await backendFetch("/library-component-folder?fields=_id");
}

export async function renameDevId(projectMongoId, itemMongoId, developerId) {
  return backendFetch(`/ditto-project/${projectMongoId}/text-item/${itemMongoId}/developerId`, {
    method: "PATCH",
    body: JSON.stringify({ developerId }),
  });
}

// Map a project's public developer ID → mongo _id via the backend project
// list (works even for empty projects, unlike the dump-join fallback below).
export async function projectMongoIdByDevId(projectDevId) {
  const projects = await backendFetch("/ditto-project");
  const list = Array.isArray(projects) ? projects : projects.projects || [];
  const hit = list.find((p) => p.developerId === projectDevId);
  if (!hit?._id) {
    throw new Error(`Project '${projectDevId}' not found in the backend project list.`);
  }
  return hit._id;
}

// Fallback: locate a project's mongo id from the dump's doc_ID group whose
// developerIds overlap the project's public-API dev IDs. Needs ≥1 item.
export function resolveProjectMongoId(dump, projectDevIds) {
  const overlap = new Map();
  for (const it of dump) {
    if (it.doc_ID && it.developerId && projectDevIds.has(it.developerId)) {
      overlap.set(it.doc_ID, (overlap.get(it.doc_ID) || 0) + 1);
    }
  }
  const ranked = [...overlap.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) {
    throw new Error(
      "Could not locate the project in the backend (no dev-ID overlap). Note: this mapping needs the " +
        "project to contain at least one text item already.",
    );
  }
  if (ranked.length > 1 && ranked[1][1] === ranked[0][1]) {
    throw new Error("Ambiguous project mapping — two backend projects matched equally. Aborting to be safe.");
  }
  return ranked[0][0];
}

// ─── Link-pass endpoints (create / connect / component-link) ──────────────────

// Mongo-style ObjectId for instance records (timestamp + random, as the web app does).
export function newObjectId() {
  const ts = Math.floor(Date.now() / 1000).toString(16).padStart(8, "0");
  return ts + randomBytes(8).toString("hex");
}

export function toRichText(text) {
  return { type: "doc", content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }] };
}

// One POST per text — we need each created item's _id back.
export async function createTextItem(projectMongoId, text) {
  const result = await backendFetch(`/ditto-project/${projectMongoId}/text-items`, {
    method: "POST",
    body: JSON.stringify({
      textItems: [{ text, richText: toRichText(text), status: "WIP" }],
      source: "plugin_text_import",
    }),
  });
  const created = Array.isArray(result)
    ? result[0]
    : result.textItems?.[0] || result.textItem || result.items?.[0] || result;
  if (!created?._id) throw new Error(`create returned no _id: ${JSON.stringify(result).slice(0, 200)}`);
  return created;
}

// Single PATCH linking every Figma text-node instance to its item's mongo id.
export async function connectTextItems(projectMongoId, figmaTextNodeInstancesByTextItemId) {
  return backendFetch(`/ditto-project/${projectMongoId}/text-items/connect`, {
    method: "PATCH",
    body: JSON.stringify({
      figmaTextNodeInstancesByTextItemId,
      fromBlockSuggestion: false,
      source: "text-suggestion",
    }),
  });
}

// All library components with mongo _ids. The list endpoint takes a SINGULAR
// folderId (plural folderIds[] returns nothing) — enumerate folders first.
export async function fetchLibraryComponents() {
  const foldersResp = await backendFetch("/library-component-folder?fields=_id");
  const all = [];
  for (const f of foldersResp.folders || []) {
    const resp = await backendFetch(`/library-component?folderId=${f._id}`);
    if (Array.isArray(resp.components)) all.push(...resp.components);
  }
  return all;
}

export async function linkComponent(componentMongoId, projectMongoId, textItemIds) {
  return backendFetch(`/library-component/${componentMongoId}/link`, {
    method: "PATCH",
    body: JSON.stringify({ projectId: projectMongoId, textItemIds, wasSuggested: false }),
  });
}

// ─── Style-guide endpoints (rules read/write) ─────────────────────────────────
//
// The public API can READ style guides but has NO write path for rules — these
// backend routes (used by the web app's style-guide editor) are the only way to
// add rules programmatically. Rule shape (the web app's zod schema):
//   { _id, workspaceId, styleguideId,      // server-owned
//     sectionId,                            // which section the rule sits in
//     enabled: bool, name, description,
//     examples: [{ from, to }],             // wrong → right pairs
//     tags: [string] }
//   GET    /styleguide                       → workspace style guides (+ sections)
//   GET    /styleguide/rules?styleguideId=…  → that guide's rules
//   POST   /styleguide/rules  {styleguideId, rules:[…]}  → create rules
//   PUT    /styleguide/rules/{ruleId}  {…}   → update one rule
//   DELETE /styleguide/rules  {styleguideRuleIds:[…]}    → delete rules

// Workspace style guides with their section metadata (sectionId, name, kind:
// "wordlist" | "rules"). Rules themselves are fetched per-guide below.
export async function listStyleGuides() {
  const raw = await backendFetch("/styleguide");
  return Array.isArray(raw) ? raw : raw.styleguides || raw.data || [];
}

export async function listStyleGuideRules(styleguideId) {
  const raw = await backendFetch(`/styleguide/rules?styleguideId=${encodeURIComponent(styleguideId)}`);
  return Array.isArray(raw) ? raw : raw.rules || raw.data || [];
}

// Create one or more rules in a style guide. Each rule: {sectionId, name,
// description, examples?:[{from,to}], tags?:[], enabled?:true}. Returns the
// created rule objects (with their new _ids).
export async function addStyleGuideRules(styleguideId, rules) {
  const body = {
    styleguideId,
    rules: rules.map((r) => ({
      sectionId: r.sectionId,
      enabled: r.enabled !== false,
      name: r.name,
      description: r.description || "",
      examples: (r.examples || []).map((e) => ({ from: e.from, to: e.to })),
      tags: r.tags || [],
    })),
  };
  const raw = await backendFetch("/styleguide/rules", { method: "POST", body: JSON.stringify(body) });
  return Array.isArray(raw) ? raw : raw.rules || [raw];
}

export async function updateStyleGuideRule(ruleId, patch) {
  return backendFetch(`/styleguide/rules/${ruleId}`, { method: "PUT", body: JSON.stringify(patch) });
}

export async function deleteStyleGuideRules(ruleIds) {
  return backendFetch("/styleguide/rules", {
    method: "DELETE",
    body: JSON.stringify({ styleguideRuleIds: ruleIds }),
  });
}
