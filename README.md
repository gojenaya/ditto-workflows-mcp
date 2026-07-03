# ditto-workflows-mcp

An MCP server for [Ditto](https://dittowords.com) — drive copy workflows from Claude: list projects, find untranslated strings, write glossary-aware translations (Claude translates — no DeepL), and update workflow statuses.

Works with any Ditto workspace — auth is your own workspace API key.

## Tools

| Tool | What it does |
|---|---|
| `list_projects` | Projects in the workspace (id + name) |
| `list_untranslated(projectId, variantId='ar')` | Base items missing the variant |
| `write_translations(translations[], variantId='ar', status='WIP')` | Write variants back (creates if missing) |
| `update_status(projectId, status, ids?/fromStatus?, variantId?)` | Set status on base items or a variant; unknown IDs skipped |

**Resource:** `ditto://glossary/ar` — locked terminology + voice rules Claude applies when translating. The files live in `translation-assets/` (gitignored — team-specific, never committed); create your own for your team's glossary. Planned: assets auto-generated from your workspace's FINAL-status copies, and a configurable default variant instead of `ar`.

## Setup

```bash
git clone <this repo> && cd ditto-workflows-mcp
npm install
echo 'DITTO_API_KEY=<your key>' > .env   # Ditto → workspace settings → API
claude mcp add ditto-workflows-mcp -s user -- node "$PWD/mcp-server.js"
```

Restart Claude Code, run `/mcp` — `ditto-workflows-mcp` should show connected. Then just ask:

> "List untranslated strings in *project*, translate them using the glossary, and write them back as WIP."

`npm test` runs a live smoke test (local-only, not committed; needs the API key).

## Notes

- Every GET carries a cache-buster: Ditto's CDN caches responses by exact URL and ignores `no-cache` headers, serving stale data after writes.
- v1 is public-API only. Browser-session operations (Figma link-pass, dev-ID renames) live in the companion pipeline repo and may join later.
