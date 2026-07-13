# ditto-workflows-mcp

An MCP server for [Ditto](https://dittowords.com) — drive copy workflows from Claude: list projects, find untranslated strings, write glossary-aware translations (Claude translates — no DeepL), and update workflow statuses.

Works with any Ditto workspace — auth is your own workspace API key.

## Tools

| Tool | What it does |
|---|---|
| `list_projects` | Projects in the workspace (id + name) |
| `set_default_variant(variantId)` | Set the default variant once (e.g. `ar`, `fr`); saved to a gitignored `.ditto-config.json` |
| `list_untranslated(projectId, variantId?)` | Base items missing the variant |
| `write_translations(translations[], variantId?, status='WIP')` | Write variants back (creates if missing) |
| `list_for_review(projectId, variantId?, statuses=['WIP','REVIEW'])` | Pending translations joined with their base text — drive an approve/edit/skip review loop; edits go back via `write_translations` at FINAL, approvals via `update_status` |
| `update_status(projectId, status, ids?/fromStatus?, variantId?)` | Set status on base items or a variant; unknown IDs skipped |
| `update_text(projectId, updates[], status?)` | Rewrite base item text (copy edits, `{{variable}}` replacements); unknown IDs skipped |
| `list_variablisation_candidates(projectId)` | Base items with hardcoded dynamic values (dates, amounts, %, card last-4, emails) + the workspace's variables — Claude suggests `{{variable}}` replacements, applied via `update_text` |
| `list_components(folderId?)` | The workspace's component library (shared strings) — check before writing new copy |
| `search_text(query, projectId?, limit=50)` | Substring search over base items + components — find existing copy to reuse, or locate where a string lives |
| `refresh_translation_assets(variantId?)` | Pull all FINAL (expert-approved) base→variant pairs workspace-wide into a local translation-memory file — raw material for distilling a glossary |

### Unofficial backend tools (session login)

Some operations the public API can't do are covered by replaying the Ditto web app's *internal* API. Those endpoints are unversioned upstream and may break without notice — they live in a separate module so the official tools above are never affected. Auth is your browser session, not the API key:

| Tool | What it does |
|---|---|
| `login_to_ditto()` | Opens a browser window on app.dittowords.com — sign in like normal and the session token is captured automatically (no devtools). Login is remembered locally; the token lasts ~3 days and refreshes are hands-free. First ever run installs a small automation helper (~40 MB, one-time) and uses your own Chrome/Edge |
| `set_session_token(token)` | Manual alternative: paste the `Authorization` header from devtools (or set `DITTO_JWT` in the env). Validated immediately; expiry reported |
| `rename_developer_id(projectId, renames[])` | Rename developer IDs (`{from, to}` pairs) — not possible via the public API. Skips unknown/colliding IDs with reasons and verifies results via the public API afterwards |
| `figma_link_pass(projectId, figmaUrl)` | Wire a Figma frame's copy into a project: existing texts get connected, new ones created as WIP, matches to library components linked. Needs a "Copy link to selection" URL and `FIGMA_API_KEY` (personal access token, file-content read scope) |

Wherever `variantId` is omitted, the default variant applies (config file, or `DITTO_DEFAULT_VARIANT` in `.env`).

**Resource:** `ditto://glossary/{variantId}` — locked terminology + voice rules Claude applies when translating. Backed by `translation-assets/{variantId}-glossary.md` + `{variantId}-voice-rules.md`, or a `translation-assets/{variantId}/` folder of markdown files (gitignored — team-specific, never committed). Bootstrap yours from your own workspace: run `refresh_translation_assets`, then have Claude distill the pairs into glossary + voice-rule files. The translation-memory file itself is deliberately *not* served by the resource — it can be hundreds of KB.

## Skills

Two Claude Code skills ship in `.claude/skills/`, encoding the standard playbooks so a whole workflow is one command instead of a paragraph:

| Skill | What it does |
|---|---|
| `/ditto-handoff [figmaUrl] [projectId]` | Full Figma→Ditto handoff: paste a frame link → copy linked into the project → semantic developer IDs suggested and reviewed → optional promotion to FINAL |
| `/ditto-translate [projectId] [variantId]` | Full translation loop: refresh assets → read the glossary → translate in batches with self-review → write back as WIP → report written + skipped |
| `/ditto-review [projectId] [variantId]` | Reviewer loop: present pending translations against their base text in batches; approve/edit/skip; edits and approvals become FINAL; refreshes the translation memory afterwards |

They load automatically with the plugin install below (or when you open Claude Code in this repo). With the standalone MCP install, copy the skill folders to `~/.claude/skills/` to have them everywhere.

## Setup

**Prerequisites:** Node.js 18+, a Ditto workspace API key (Ditto → workspace settings → API).

### Claude Code plugin (recommended — tools + skills + guided key setup)

Installs the MCP server *and* both skills in one step, and prompts for your API key:

```
/plugin marketplace add gojenaya/ditto-workflows-mcp
/plugin install ditto-workflows@ditto-workflows-mcp
```

You'll be asked for your Ditto API key (and, optionally, a default variant) during install — no manual config editing. The server itself runs via `npx`, so it stays up to date.

### npx (MCP server only, no clone)

**Claude Code:**

```bash
claude mcp add ditto-workflows -s user \
  -e DITTO_API_KEY=<your key> \
  -e DITTO_DEFAULT_VARIANT=<variant> \
  -- npx -y ditto-workflows-mcp@latest
```

(`DITTO_DEFAULT_VARIANT` is optional — you can call `set_default_variant` once instead.)

**Other MCP clients** (Claude Desktop, Cursor, Windsurf, …) — add to the client's MCP config:

```json
{
  "mcpServers": {
    "ditto-workflows": {
      "command": "npx",
      "args": ["-y", "ditto-workflows-mcp@latest"],
      "env": {
        "DITTO_API_KEY": "<your key>",
        "DITTO_DEFAULT_VARIANT": "<variant>"
      }
    }
  }
}
```

### From a clone (development)

```bash
git clone https://github.com/gojenaya/ditto-workflows-mcp && cd ditto-workflows-mcp
npm install
echo 'DITTO_API_KEY=<your key>' > .env         # loaded by the server itself
echo 'DITTO_DEFAULT_VARIANT=<variant>' >> .env # optional
claude mcp add ditto-workflows -s user -- node "$PWD/mcp-server.js"
```

`npm test` runs a live smoke test (local-only, not committed; needs the API key).

### Where state lives

| What | Where |
|---|---|
| Default-variant config | `~/.ditto-workflows-mcp/config.json` |
| Glossary + translation-memory files | `~/.ditto-workflows-mcp/translation-assets/` — or a `translation-assets/` dir next to the server in clone installs, which takes precedence |
| Override the whole data dir | `DITTO_DATA_DIR` env (assets dir alone: `DITTO_ASSETS_DIR`) |

### First run

Restart your client, run `/mcp` — `ditto-workflows` should show connected. Then just ask:

> "List untranslated strings in *project*, translate them using the glossary, and write them back as WIP."

## Notes

- Every GET carries a cache-buster: Ditto's CDN caches responses by exact URL and ignores `no-cache` headers, serving stale data after writes.
- `{{variable}}` placeholders written via the API land as literal text — the public API can't link workspace variables to items (verified: `variableIds` in a PATCH is silently ignored). Linking, variable creation, and dev-ID renames happen in the Ditto web app.
- v1 is public-API only. Browser-session operations (Figma link-pass, dev-ID renames) live in the companion pipeline repo and may join later.
