---
name: ditto-translate
description: Translate a Ditto project's untranslated strings into a variant — refresh translation assets, read the workspace glossary, translate in batches with self-review, write back as WIP for expert review. Use when the user wants to translate or localise strings in Ditto.
---

# Ditto translation loop

Glossary-aware translation of a project's untranslated strings using the ditto-workflows-mcp tools. You are the translation engine; the glossary and translation memory are your source of truth for terminology and voice.

## Arguments

`/ditto-translate [projectId] [variantId]` — both optional. If projectId is missing, call `list_projects` and ask the user to pick. If variantId is missing, the tools use the configured default variant.

## Procedure

1. **Refresh assets:** call `refresh_translation_assets(variantId?)` so the translation memory reflects the latest FINAL (expert-approved) copy. Note the unique-source count and any conflicts it reports (surface conflicts to the user — the memory can't be a single source of truth while a source text has two approved translations).
2. **Read the glossary:** read the `ditto://glossary/{variantId}` resource BEFORE translating anything. If it comes back empty, stop and tell the user: either distill one first (read the translation-memory file from step 1 in chunks and extract locked terms + voice rules into `translation-assets/` files), or confirm they want to translate without a glossary.
3. **Fetch the work:** call `list_untranslated(projectId, variantId?)`. If count is 0, say so and stop.
4. **Load the memory for reuse:** read `translation-assets/{variantId}/translation-memory.md` (the Memory table from step 1). This is your reference for reuse — do NOT translate from scratch what the workspace has already approved.
5. **Translate in batches of ~20 — memory first, then translate the rest:**
   - **Exact source match in memory → reuse its FINAL translation verbatim** (barring an obvious context mismatch — flag those rather than silently diverging). This keeps terminology identical across projects.
   - **Similar source (same term/phrase, different surrounding text) → mirror the memory's wording and locked terms** rather than inventing new phrasing.
   - Only translate from scratch when the memory has nothing close.
   - Always: apply locked glossary terms exactly; follow the voice rules; preserve `{{variables}}`/placeholders untranslated; keep UI-string lengths sensible.
6. **Self-review each batch before writing:** re-check every translation against the memory, locked terms, and voice rules; fix violations. Skip (don't guess) strings that can't be translated confidently without UI context — ambiguous single words, truncated fragments.
7. **Write back:** `write_translations(batch, variantId, status: "WIP")` — one call per batch.
8. **Report:** total written, plus every skipped item with the reason. Suggest `/ditto-review` as the next step so an expert promotes WIP → FINAL.

## Rules

- The glossary lives in the MCP resource — read it fresh every run; never copy its rules into this skill or assume them from memory.
- Always write at status **WIP**. Promotion to FINAL is a human decision, made in `/ditto-review`.
- Skipping with a stated reason beats a confident-sounding guess.
