---
name: ditto-review
description: Review pending Ditto translations for a project — either interactively in chat or by handing a human translator a Markdown review sheet — then push results back (edits and approvals become FINAL). Use when the user wants to review, QA, approve, or hand off translations for review in Ditto.
---

# Ditto translation review loop

Review a project's pending translations using the ditto-workflows-mcp tools. Two modes:

- **A — Translator review sheet (for a human expert):** when the user wants a *translator* to review (not review in chat themselves), export a Markdown sheet the translator edits — flag concerns, write optimal translations — then apply it back. Best when the reviewer is a native speaker who isn't driving Claude.
- **B — Interactive in chat:** Claude presents each translation for the user to approve/edit/skip live.

## Arguments

`/ditto-review [projectId] [variantId]` — both optional. If projectId is missing, call `list_projects` and ask the user to pick. If variantId is missing, the tools use the configured default variant.

## Mode A — translator review sheet

1. `export_review_sheet(projectId, variantId?, statuses=['REVIEW'])` — writes a Markdown sheet (base · current translation · Verdict · editable Suggested · Notes) and returns its path + content. Give the translator the path (or paste the sheet in chat).
2. The translator edits each row: `approve` to keep, or `edit` + rewrite the Suggested cell; blank/`skip` to defer; Notes to flag. `{{variables}}` and placeholders stay intact.
3. `apply_review_sheet(projectId, variantId?, path?)` — pushes it back: edited rows written at FINAL, approvals promoted to FINAL, deferred rows left in REVIEW. Report the returned tally (edited / approved / deferred).
4. Then do step "Refresh the translation memory" below.

## Mode B — interactive review, procedure

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
