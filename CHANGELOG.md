# Changelog

All notable changes to ditto-workflows-mcp are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.10.0] - 2026-07-14

### Added

- **Translator review sheet** — a Markdown round-trip so a human translator (native speaker) can review a variant's translations outside chat:
  - `export_review_sheet(projectId, variantId?, statuses=['REVIEW'])` writes a Markdown sheet (dev id · base · current · Verdict · editable Suggested · Notes) and returns it inline too (works as a file *or* in chat). Pipes/newlines are escaped so the table survives arbitrary copy.
  - `apply_review_sheet(projectId, variantId?, path?)` parses the edited sheet back: edited rows written at FINAL, `approve` rows promoted to FINAL, blank/`skip` left in REVIEW. Returns a tally.
  - `/ditto-review` skill gained a "Mode A — translator review sheet" path alongside the interactive in-chat mode.
- Works in Claude Desktop (and any MCP client), which is why the export/apply is server-side rather than relying on the client's filesystem.

## [0.9.0] - 2026-07-14

### Changed

- `update_status`: `fromStatus` now accepts a **list** of statuses and works for **variants** (with `variantId`), not just base items. This makes "stage everything for review without touching FINAL" a single call — `fromStatus: ["NONE","WIP","REVIEW"] → REVIEW` — since FINAL is simply excluded from the list.
- `/ditto-handoff` final step changed from *offering* FINAL promotion to **automatically staging** the batch at REVIEW: all touched base items and written variants move to REVIEW, and any already-FINAL item is left untouched (never downgraded). Verified live: an `ar` variant with a pre-existing FINAL item kept it FINAL while 41 others moved to REVIEW.

## [0.8.1] - 2026-07-14

### Fixed

- `figma_link_pass` and `rename_developer_id` now resolve a project's internal ID via a direct backend project-list lookup (`GET /ditto-project`), so they work on **empty projects** — the old dev-ID-overlap join needed at least one existing item, which broke the first link-pass into a fresh project.
- Variablise detection now catches **trailing-currency amounts** ("8.00 AED"), not just currency-first ("AED 8.00"); added PKR/PHP to the currency set.

## [0.8.0] - 2026-07-13

### Added

- `figma_link_pass(projectId, figmaUrl)` — port of the ditto-handoff pipeline's link-pass, now headless: pulls the text nodes under a Figma frame ("Copy link to selection" URL required; whole-file blocked), connects texts that match existing items, creates new ones as WIP, and links matches to library components. Returns created items with auto-generated developer IDs and screen names for the rename step. Needs `FIGMA_API_KEY` (unofficial backend + Figma REST).
- `/ditto-handoff` skill — the full flow from a pasted Figma link: link-pass → semantic developer-ID suggestions (screen-aware, reviewed by the user) → `rename_developer_id` → glossary-aware translation into a variant when one is mentioned ("…and add Arabic"; translations land as WIP for `/ditto-review`) → optional promotion of the touched base items to FINAL.
- Plugin: optional `figma_api_key` install prompt wired to `FIGMA_API_KEY`.

## [0.7.0] - 2026-07-13

### Added

- **Unofficial backend tools** (session JWT, separate `ditto-backend.js` module — public-API tools never depend on it):
  - `login_to_ditto` — designer-friendly auth: opens a real browser window on app.dittowords.com, the user signs in like normal, and the session token is captured automatically (no devtools). First run self-installs a browser-automation helper into the data dir (~40 MB, one-time) and drives the user's own Chrome/Edge — no browser download. The login persists in a local profile, and the token (~72 h lifetime) is cached with 0600 perms, so later refreshes are hands-free.
  - `set_session_token` — paste a browser-session JWT manually (validated immediately, expiry reported); also honours a `DITTO_JWT` env var.
  - `rename_developer_id` — rename text-item developer IDs, which the public API cannot do. Locates the project's internal ID by joining the backend workspace dump against public-API dev IDs, skips unknown/colliding renames with reasons, and verifies results via the public API afterwards.
  - These replay Ditto's internal web-app API: unversioned, may break without notice, and clearly marked UNOFFICIAL in the tool descriptions. Expired tokens produce a "grab a fresh one" message with exact devtools steps instead of a raw 401.
- **Claude Code plugin distribution**: the repo doubles as a plugin marketplace (`.claude-plugin/marketplace.json`), with the plugin itself under `plugin/` (`plugin/.claude-plugin/plugin.json`, `plugin/.mcp.json`, `plugin/skills/`). `/plugin marketplace add gojenaya/ditto-workflows-mcp` then `/plugin install ditto-workflows@ditto-workflows-mcp` installs the MCP server (via npx) *and* both skills in one step, prompting for the Ditto API key through the plugin's `userConfig`. Closes the gap where npx users didn't get the skills. (Not shipped to npm — plugin files are git-only.)

## [0.6.0] - 2026-07-07

### Added

- **npx distribution**: install with `claude mcp add ... -- npx -y ditto-workflows-mcp@latest` — no clone, no paths. API key and default variant are passed as env vars at add-time.
- MIT license, changelog, npm `files` whitelist.

### Changed

- Per-user state (config, auto-generated translation assets) moved to `~/.ditto-workflows-mcp/` (override with `DITTO_DATA_DIR`; glossary dir alone with `DITTO_ASSETS_DIR`) — the package dir is a throwaway cache under npx. Clone installs with an existing `translation-assets/` dir next to the server keep working unchanged, and a legacy `.ditto-config.json` next to the script is still read.
- Dropped the `node-fetch` dependency in favour of the global fetch (Node 18+).

## [0.5.0] - 2026-07-07

### Added

- Skills layer, shipped in-repo (`.claude/skills/`): `/ditto-translate` (refresh assets → read glossary → translate in batches with self-review → write back as WIP) and `/ditto-review` (approve/edit/skip pending translations; results become FINAL, translation memory refreshed after).

## [0.4.0] - 2026-07-07

### Added

- `list_variablisation_candidates` — detect hardcoded dynamic values (dates, amounts, percentages, card last-4, emails) in a project's base items, returned with the workspace's variables; Claude suggests the `{{variable}}` replacements.
- `update_text` — rewrite base item text (copy edits, variable replacements); unknown IDs skipped.
- `list_components` — the workspace component library, optionally by folder.
- `search_text` — reuse-oriented substring search over base items and components.

### Known limitations

- `{{name}}` placeholders written via the public API land as literal text — variable linking/creation and dev-ID renames remain Ditto web-app steps.

## [0.3.0] - 2026-07-03

### Added

- Configurable default variant: `set_default_variant` tool + `DITTO_DEFAULT_VARIANT` env (no more hardcoded `'ar'`).
- `refresh_translation_assets` — pull all FINAL base→variant pairs workspace-wide into a local translation-memory file for glossary distillation.
- `list_for_review` — pending variant translations joined with base text, powering the review loop.
- Glossary resource generalised to `ditto://glossary/{variantId}`.

## [0.2.0] - 2026-07-03

### Added

- Initial MCP server: `list_projects`, `list_untranslated`, `write_translations`, `update_status`, and the `ditto://glossary/ar` resource. Claude is the translation engine; the server is deterministic I/O over the Ditto public API (with CDN cache-busting).
