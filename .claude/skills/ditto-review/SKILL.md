---
name: ditto-review
description: Review pending Ditto translations for a project — present each translation with its base text, let the reviewer approve/edit/skip, then push results back (edits and approvals become FINAL). Use when the user wants to review, QA, or approve translations in Ditto.
---

# Ditto translation review loop

Interactive review of a project's pending translations using the ditto-workflows-mcp tools.

## Arguments

`/ditto-review [projectId] [variantId]` — both optional. If projectId is missing, call `list_projects` and ask the user to pick. If variantId is missing, the tools use the configured default variant.

## Procedure

1. **Fetch the queue:** call `list_for_review(projectId, variantId?)` (default statuses WIP + REVIEW). If count is 0, say so and stop.
2. **Read the glossary first:** read the `ditto://glossary/{variantId}` resource so you can flag glossary/voice-rule violations during review — but the reviewer's judgment always wins.
3. **Present in batches of ~10.** For each item show, in a compact numbered list:
   - the base text
   - the current translation
   - its status
   - any concern you spot (locked-term mismatch, tone drift, missing placeholder like `{{name}}`) — only when genuinely suspect, don't nitpick
4. **Collect verdicts per batch:** the reviewer replies with approvals, edits, or skips (e.g. "1,3-5 ok; 2: <new text>; skip 6"). Interpret flexibly.
5. **Push results after each batch:**
   - Edits → `write_translations(translations, variantId, status: "FINAL")`
   - Untouched approvals → `update_status(projectId, status: "FINAL", ids, variantId)`
   - Skips → leave untouched, carry to the tally
6. **Tally at the end:** report counts of approved / edited / skipped, plus any items where the push failed or was skipped by the API.
7. **Refresh the translation memory:** if anything was promoted or edited to FINAL, call `refresh_translation_assets(variantId)` so the local translation memory picks up the newly approved copy. If the session surfaced recurring glossary gaps or tone drift, suggest re-distilling the glossary from the refreshed memory.

## Rules

- Never change a translation the reviewer didn't ask you to change — if you disagree, flag it and let them decide.
- Preserve `{{variables}}`, placeholders, and markup in edits exactly.
- Batch writes (one `write_translations` / `update_status` call per batch), not per-item calls.
