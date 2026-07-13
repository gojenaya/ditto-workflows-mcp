---
name: ditto-translate
description: Translate a Ditto project's untranslated strings into a variant — refresh translation assets, read the workspace glossary, translate in batches with self-review, write back as WIP for expert review. Use when the user wants to translate or localise strings in Ditto.
---

# Ditto translation loop

Glossary-aware translation of a project's untranslated strings using the ditto-workflows-mcp tools. You are the translation engine; the glossary and translation memory are your source of truth for terminology and voice.

## Arguments

`/ditto-translate [projectId] [variantId]` — both optional. If projectId is missing, call `list_projects` and ask the user to pick. If variantId is missing, the tools use the configured default variant.

## Procedure

1. **Refresh assets:** call `refresh_translation_assets(variantId?)` so the local translation memory reflects the latest expert-approved (FINAL) copy. Note the pair count.
2. **Read the glossary:** read the `ditto://glossary/{variantId}` resource BEFORE translating anything. If it comes back empty, stop and tell the user: either distill one first (read the translation-memory file from step 1 in chunks and extract locked terms + voice rules into `translation-assets/` files), or confirm they want to translate without a glossary.
3. **Fetch the work:** call `list_untranslated(projectId, variantId?)`. If count is 0, say so and stop.
4. **Translate in batches of ~20:**
   - Apply locked glossary terms exactly; follow the voice rules.
   - Preserve `{{variables}}`, placeholders, and markup untouched and untranslated.
   - Match the register of the base copy; keep translations roughly comparable in length (UI strings — don't let them balloon).
   - Consult the translation-memory sample/file for phrasing precedent when a string resembles already-approved copy.
5. **Self-review each batch before writing:** re-check every translation against the locked terms and voice rules; fix violations. Skip (don't guess) strings that can't be translated confidently without UI context — ambiguous single words, truncated fragments.
6. **Write back:** `write_translations(batch, variantId, status: "WIP")` — one call per batch.
7. **Report:** total written, plus every skipped item with the reason. Suggest `/ditto-review` as the next step so an expert promotes WIP → FINAL.

## Rules

- The glossary lives in the MCP resource — read it fresh every run; never copy its rules into this skill or assume them from memory.
- Always write at status **WIP**. Promotion to FINAL is a human decision, made in `/ditto-review`.
- Skipping with a stated reason beats a confident-sounding guess.
