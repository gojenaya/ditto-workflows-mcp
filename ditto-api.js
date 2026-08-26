// Thin client for the Ditto public API (api.dittowords.com/v2).
// Reads DITTO_API_KEY lazily so callers can load .env before first use.
// Uses the global fetch (Node 18+).

const BASE = "https://api.dittowords.com/v2";

export async function dittoFetch(path) {
  // Cache-buster: Ditto's CDN caches GET responses keyed on the exact URL
  // (including the compact JSON filter string) and serves STALE data after
  // writes — e.g. old dev IDs after a rename. A unique param forces a fresh
  // response from origin. (no-cache headers are ignored by the CDN.)
  const bust = `${path.includes("?") ? "&" : "?"}_=${Date.now()}`;
  const res = await fetch(`${BASE}${path}${bust}`, {
    headers: { Authorization: process.env.DITTO_API_KEY },
  });
  if (!res.ok) throw new Error(`Ditto GET ${path} failed: ${res.status}`);
  return res.json();
}

export async function dittoPatch(body) {
  const res = await fetch(`${BASE}/textItems`, {
    method: "PATCH",
    headers: {
      Authorization: process.env.DITTO_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ditto PATCH failed: ${res.status} ${text}`);
  }
  return res.json();
}

// Variable creation/deletion via the public API — this half genuinely works
// (verified 24 Aug 2026: POST returns 200 and the variable appears).
// LINKING a variable to an item does NOT work here — see
// ditto-backend.js → toRichTextWithVariables / updateTextItemsRich.
export async function createVariables(variables) {
  const res = await fetch(`${BASE}/variables`, {
    method: "POST",
    headers: {
      Authorization: process.env.DITTO_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ variables }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ditto POST /variables failed: ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

export async function deleteVariables(names) {
  const res = await fetch(`${BASE}/variables`, {
    method: "DELETE",
    headers: {
      Authorization: process.env.DITTO_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ names }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ditto DELETE /variables failed: ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

// Delete text items by developer ID. Public API, verified 24 Aug 2026 — the
// body field is `developerIds` (a plain `ids` array is rejected with a zod
// error naming the right field). Irreversible: the item's variants and Figma
// instances go with it.
export async function deleteTextItems(projectId, developerIds) {
  const res = await fetch(`${BASE}/textItems`, {
    method: "DELETE",
    headers: {
      Authorization: process.env.DITTO_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ projectId, developerIds }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ditto DELETE /textItems failed: ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}
