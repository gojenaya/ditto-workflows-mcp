# Testing ditto-workflows-mcp

A quick guide to try the MCP server against your own Ditto workspace. ~10 minutes.

## What you need

- **Node.js 18+** — check with `node --version`.
- **A Ditto workspace API key** — Ditto → workspace settings → Developer/API → create a key.
- **A Chromium-based browser** (Chrome or Edge) — used by the browser login for the "unofficial" tools. Most machines already have one.
- *(Optional)* **A Figma personal access token** — only for the Figma→Ditto handoff. figma.com → Settings → Security → Personal access tokens, scope **File content: Read**.

Everything runs against **your own** workspace with **your own** key. Nothing is shared.

## 1. Install (npm package, no clone)

### Claude Code (easiest — tools + skills together)

```
/plugin marketplace add gojenaya/ditto-workflows-mcp
/plugin install ditto-workflows@ditto-workflows-mcp
```

It prompts for your Ditto API key (and, optionally, a default variant like `ar` and a Figma token). Restart, run `/mcp` — `ditto-workflows` should show **connected**.

### Any other MCP client (Claude Desktop, Cursor, Windsurf…)

Add to the client's MCP config (e.g. Claude Desktop → `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ditto-workflows": {
      "command": "npx",
      "args": ["-y", "ditto-workflows-mcp@latest"],
      "env": {
        "DITTO_API_KEY": "<your key>",
        "DITTO_DEFAULT_VARIANT": "ar",
        "FIGMA_API_KEY": "<optional figma token>"
      }
    }
  }
}
```

Restart the client. (The `@latest` npx pull auto-downloads the package the first time.)

## 2. Install Playwright (for the browser-based tools)

The tools that use Ditto's internal API — `login_to_ditto`, `figma_link_pass`, `rename_developer_id` — need a browser to capture your Ditto session.

**Automatic (default):** the first time you run `login_to_ditto`, the server installs Playwright for you into `~/.ditto-workflows-mcp/login-helper/` (~40 MB, one-time, ~1 min) and opens your own Chrome/Edge. Nothing to do — just expect that first call to take a minute.

**If you don't have Chrome or Edge**, pre-install a browser so the login has something to open:

```bash
npx playwright install chromium
```

(Optional: to skip the first-run wait entirely, pre-install the package too — `npm i -g playwright && npx playwright install chromium`.)

## 3. Smoke test — the read-only, API-key-only path

In your MCP client, just ask in plain language:

- *"List my Ditto projects."* → `list_projects`
- *"Find untranslated strings in `<project>` for `ar`."* → `list_untranslated`
- *"Search Ditto for 'continue'."* → `search_text`
- *"Translate the untranslated `ar` strings in `<project>` using the glossary and write them as WIP."* → the `/ditto-translate` loop

None of these need the browser — just your API key.

## 4. Full test — the browser tools + end-to-end handoff

1. **Log in once:** *"Log in to Ditto."* → `login_to_ditto` opens a browser; sign in as normal; the token is captured and cached (~3 days).
2. **Handoff a Figma frame** (needs the Figma token): in Figma, right-click a frame → **Copy link to selection**. Then:

   > `/ditto-handoff <paste figma link> <project> and add Hindi`

   It runs end-to-end without stopping — links the copy in, names the items, variablises hardcoded values, translates to Hindi, and stages everything at **REVIEW**. Nothing is set to FINAL automatically.
3. **Review the translations:** `/ditto-review <project> hi` (or `export_review_sheet`) → you get a Markdown sheet; set each row's Verdict to `A` (approve) or `N` (edit the Suggested cell) → *"apply the review sheet"*.

## Where things live

| What | Path |
|---|---|
| Config (default variant, excluded projects) | `~/.ditto-workflows-mcp/config.json` |
| Glossary + translation memory | `~/.ditto-workflows-mcp/translation-assets/<variant>/` |
| Review sheets | `~/.ditto-workflows-mcp/review-sheets/` |
| Browser login helper (Playwright) + cached token | `~/.ditto-workflows-mcp/login-helper/`, `~/.ditto-workflows-mcp/session-token` |

## Good to know

- **Nothing goes FINAL on its own.** Translations and handoffs land at WIP/REVIEW; a human promotes to FINAL via the review flow.
- The **glossary/translation memory is yours** — built from your workspace's FINAL translations (`refresh_translation_assets`), not inherited.
- `{{variable}}` placeholders write as literal text; *linking* them to real Ditto variables is still done in the Ditto web app.
- The browser tools replay Ditto's internal API (unversioned) — if one breaks, the API-key tools are unaffected.

## If something's off

- **`/mcp` shows not connected** → check `node --version` (needs 18+) and that the API key is set.
- **"No session token" / expired** → run `login_to_ditto` again (or paste one via `set_session_token`).
- **`FIGMA_API_KEY is not set`** → add the Figma token to the config/env; only the handoff needs it.
- **Browser won't open** → install Chrome/Edge, or run `npx playwright install chromium`.

Questions? Ping Nayanika.
