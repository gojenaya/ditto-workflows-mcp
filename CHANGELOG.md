# Changelog

All notable changes to ditto-workflows-mcp are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
