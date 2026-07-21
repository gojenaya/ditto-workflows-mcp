# Changelog

All notable changes to ditto-workflows-mcp are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — `no-review-direct-final` branch

### Changed

- **No review stage — copy lands at FINAL directly.** On this branch `/ditto-translate` writes translations at `FINAL` (instead of `WIP`) and `/ditto-handoff` sets the whole batch to `FINAL` (instead of staging at `REVIEW`). The `/ditto-review` gate is no longer part of the default flow. Both skills now instruct extra caution — skip and flag anything ambiguous rather than committing a guess as approved copy, since nothing sits in review before shipping. The `with-review-process` branch keeps the WIP → REVIEW → FINAL flow.

## [0.14.0] - 2026-07-17

### Changed

- **Token-efficient parallel translation.** `/ditto-translate` and `/ditto-handoff` now delegate each variant's translation to its own subagent, run concurrently, each returning only a compact summary (`{variantId, wrote, skipped}`). The bulky data — the untranslated list, the ~25k-char glossary, the memory table — stays inside the subagent's context (discarded when it returns) instead of accumulating in the orchestrator. Independent variants never conflict; a single variant is never split across agents (keeps repeated-string terminology consistent). Falls back to inline translation where no subagent/Task capability exists.

## [0.13.1] - 2026-07-15

### Fixed

- Variablise detection now recognises the botim dirham glyph `ď` (and `đ`) in amounts (e.g. `ď3,000`, `Total outstanding: ď200.00`) — restored from the original ditto-script patterns, dropped during the port.

## [0.13.0] - 2026-07-15

### Changed

- `/ditto-handoff` now runs autonomously end to end by default — it applies dev-ID renames, variablisation, and translations without pausing for per-step approval, then stages the whole batch at REVIEW. Safe because nothing is promoted to FINAL; the human review happens afterwards (`/ditto-review` or a review sheet). It stops only for genuine blockers (auth, ambiguous project), or if the user explicitly asks to review as they go.

## [0.12.6] - 2026-07-15

### Changed

- apply_review_sheet now honours any changed Suggested cell as an edit regardless of the A/N verdict letter — so a translator who edits the translation but leaves the verdict at A does not silently lose the edit.

## [0.12.5] - 2026-07-15

### Changed

- Review sheet restructured: narrower columns (cap 40) so rows fit one line and only long sentences overflow; **Verdict moved to the last column as A/N** (A = approve/keep, N = not approved → put the fix in Suggested; blank = defer). apply_review_sheet parses A/N accordingly.

## [0.12.4] - 2026-07-15

### Changed

- Table columns are padded to align in the raw file (short cells line up under their header); long sentences remain the exception — they wrap (wrap columns) or overrun (others). Applies to memory, conflicts, and review sheets alike. Review-sheet round-trip stays exact because apply_review_sheet trims cells.

## [0.12.3] - 2026-07-15

### Changed

- One shared Markdown table style across every generated file (memory, conflicts, review sheets) so output is identical regardless of which tool/client produced it. Long cells wrap with <br> (fixed-width columns in a viewer; short entries stay one line) instead of char-padding, which could not align proportional Arabic/emoji.
- Conflicts file: one row per distinct translation with dev@project refs collapsed (was one row per ref — the {{_}} case went from ~90 rows to a handful).

## [0.12.2] - 2026-07-15

### Changed

- Translation-memory / conflict tables now cap column width (~48 chars): short entries stay compact and aligned on one line; only genuinely long sentences overrun and wrap.

## [0.12.1] - 2026-07-15

### Changed

- `refresh_translation_assets` now skips untranslated placeholders even at FINAL status — a translation like `[AR-TODO] …` / `[EN-TODO] …` (Ditto's not-yet-translated marker) or an empty string never enters the memory or the conflicts.
- Table columns are fully padded (every column, including the last) so borders align in the raw Markdown file.

## [0.12.0] - 2026-07-15

### Added

- `set_excluded_projects(projectIds)` — configure test/sandbox projects (e.g. QA playgrounds) to skip entirely when building the translation memory. Stored in the gitignored local config (never hardcoded — the repo is public). `refresh_translation_assets` also takes an `excludeProjects` override.

### Changed

- `refresh_translation_assets` reworked per real-use feedback:
  - **Excludes** the configured test/sandbox projects from both memory and conflicts.
  - The memory now contains only sources with a **single agreed** FINAL translation; a source with divergent FINAL translations is **held out** of the memory until resolved.
  - **Conflicts moved to their own file** (`translation-conflicts.md`), separate from the memory, with each translation's dev IDs + project IDs.
  - Cleaner **RTL-safe table**: dropped the noisy `uses` column and put the translation in the last column (so right-to-left text no longer visually reorders trailing cells); the Source column is padded so raw rows line up.

## [0.11.0] - 2026-07-14

### Changed

- **Translation memory reworked to be a reusable reference.** `refresh_translation_assets` now groups FINAL translations by source text: identical source→translation pairs are collapsed (with an occurrence count), and any source with more than one FINAL translation is flagged as a **conflict** listing each variant's **dev IDs + project IDs** to confirm and re-align. Output is a clean Markdown **table** (Memory + Conflicts sections) instead of a bullet list; the tool's response is capped/summarised so it stays small even with hundreds of conflicts.
- `/ditto-translate` (and the handoff's translation step) now **reference the memory first**: exact source matches reuse the approved translation verbatim, similar sources mirror its wording, and only genuinely-new copy is translated from scratch. Verified live: with the current workspace memory, a translation pass would reuse 98 Arabic / 34 Hindi existing translations across sample projects instead of re-inventing them.

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
