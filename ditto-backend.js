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
