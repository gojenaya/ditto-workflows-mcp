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

Wherever `variantId` is omitted, the default variant applies (config file, or `DITTO_DEFAULT_VARIANT` in `.env`).

**Resource:** `ditto://glossary/{variantId}` — locked terminology + voice rules Claude applies when translating. Backed by `translation-assets/{variantId}-glossary.md` + `{variantId}-voice-rules.md`, or a `translation-assets/{variantId}/` folder of markdown files (gitignored — team-specific, never committed). Bootstrap yours from your own workspace: run `refresh_translation_assets`, then have Claude distill the pairs into glossary + voice-rule files. The translation-memory file itself is deliberately *not* served by the resource — it can be hundreds of KB.

## Setup

```bash
git clone <this repo> && cd ditto-workflows-mcp
npm install
echo 'DITTO_API_KEY=<your key>' > .env         # Ditto → workspace settings → API
echo 'DITTO_DEFAULT_VARIANT=<variant>' >> .env # optional — or use set_default_variant later
claude mcp add ditto-workflows-mcp -s user -- node "$PWD/mcp-server.js"
```

Restart Claude Code, run `/mcp` — `ditto-workflows-mcp` should show connected. Then just ask:

> "List untranslated strings in *project*, translate them using the glossary, and write them back as WIP."

`npm test` runs a live smoke test (local-only, not committed; needs the API key).

## Notes

- Every GET carries a cache-buster: Ditto's CDN caches responses by exact URL and ignores `no-cache` headers, serving stale data after writes.
- `{{variable}}` placeholders written via the API land as literal text — the public API can't link workspace variables to items (verified: `variableIds` in a PATCH is silently ignored). Linking, variable creation, and dev-ID renames happen in the Ditto web app.
- v1 is public-API only. Browser-session operations (Figma link-pass, dev-ID renames) live in the companion pipeline repo and may join later.
