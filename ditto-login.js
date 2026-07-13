#!/usr/bin/env node
// Interactive Ditto login helper — opens a real browser window on
// app.dittowords.com, lets the user sign in like normal, and captures the
// session JWT the web app sends on its own API calls (same fetch-hook trick as
// the original ditto-handoff pipeline). No devtools needed.
//
// Run by the login_to_ditto MCP tool as a child process; can also be run by
// hand: node ditto-login.js
//
// stdout: a single JSON line {ok, token?, error?, needsPlaywright?}
// stderr: human-readable progress.
//
// Playwright resolution order:
//   1. normal import (clone installs with playwright present)
//   2. the private helper install at {DATA_DIR}/login-helper/node_modules
//      (created on demand by the login_to_ditto tool — keeps playwright out of
//      the npm package's dependencies)
// Browser: the user's own Chrome (channel 'chrome'), falling back to Edge,
// then Playwright's bundled chromium. A persistent profile in DATA_DIR means
// the login survives between runs — later refreshes are hands-free.
import * as path from "path";
import * as os from "os";
import { createRequire } from "module";

const DATA_DIR = process.env.DITTO_DATA_DIR || path.join(os.homedir(), ".ditto-workflows-mcp");
const HELPER_DIR = path.join(DATA_DIR, "login-helper");
const PROFILE_DIR = path.join(DATA_DIR, "browser-profile");
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // long enough for a login with MFA

const out = (obj) => console.log(JSON.stringify(obj));
const log = (msg) => console.error(`[ditto-login] ${msg}`);

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch { /* not resolvable normally */ }
  try {
    const req = createRequire(path.join(HELPER_DIR, "noop.js"));
    return req("playwright");
  } catch { /* helper install missing too */ }
  return null;
}

const pw = await loadPlaywright();
if (!pw) {
  out({ ok: false, needsPlaywright: true, error: `playwright not found (looked in normal resolution and ${HELPER_DIR})` });
  process.exit(0);
}

// Prefer the user's own browser — no 130MB chromium download.
async function launch() {
  const attempts = [{ channel: "chrome" }, { channel: "msedge" }, {}];
  let lastErr;
  for (const opts of attempts) {
    try {
      const ctx = await pw.chromium.launchPersistentContext(PROFILE_DIR, {
        headless: false,
        viewport: { width: 1280, height: 850 },
        ...opts,
      });
      log(`browser launched (${opts.channel || "bundled chromium"})`);
      return ctx;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Could not launch a browser (tried Chrome, Edge, bundled chromium): ${lastErr?.message?.split("\n")[0]}. ` +
      `If no browser is installed, run: ${path.join(HELPER_DIR, "node_modules", ".bin", "playwright")} install chromium`,
  );
}

let context;
try {
  context = await launch();
  const page = context.pages()[0] || (await context.newPage());

  // Capture the Authorization header off the app's own API calls.
  await page.addInitScript(() => {
    const orig = window.fetch;
    window._dittoJwt = null;
    window.fetch = function (url, opts) {
      const auth = opts?.headers?.Authorization || opts?.headers?.authorization;
      if (auth?.startsWith("Bearer ") && !window._dittoJwt) window._dittoJwt = auth;
      return orig.apply(this, arguments);
    };
  });

  log("opening app.dittowords.com — log in in the browser window if asked…");
  await page.goto("https://app.dittowords.com", { timeout: 60_000 });
  // NB: options are the THIRD arg (second is `arg` for the page function) —
  // passing them second silently leaves the default 30s timeout.
  await page.waitForFunction(() => !!window._dittoJwt, undefined, { timeout: LOGIN_TIMEOUT_MS });
  const token = await page.evaluate(() => window._dittoJwt);
  log("session token captured.");
  out({ ok: true, token });
} catch (err) {
  out({ ok: false, error: err.message?.split("\n")[0] || String(err) });
} finally {
  await context?.close().catch(() => {});
}
