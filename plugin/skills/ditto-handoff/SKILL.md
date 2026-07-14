---
name: ditto-handoff
description: Full Figma→Ditto handoff — paste a Figma frame link, its copy is linked into a Ditto project (existing texts connected, new ones created), new items get semantic developer IDs the user reviews, optionally the new copy is translated into a variant (e.g. Arabic), and approved items can be promoted to FINAL. Use when the user pastes a Figma link to hand off, sync, or import a screen's copy into Ditto.
---

# Figma → Ditto handoff

One flow from a pasted Figma link to reviewed, semantically named text items: link-pass → semantic dev IDs → user review → variablise dynamic content → optional variant translation → stage everything at REVIEW (except already-FINAL). Uses the unofficial backend tools (session login) plus the Figma REST API.

## Arguments

`/ditto-handoff [figmaUrl] [projectId] [variantId]` — all optional. If the Figma URL is missing, ask for a **"Copy link to selection"** link (right-click the frame/section in Figma — a plain file link won't work; the tool requires a `node-id`). If projectId is missing, call `list_projects` and ask the user to pick. If the user mentions a language or variant anywhere in the request ("…and add Arabic", "translate to fr"), treat that as the variantId for the translation step; if none is mentioned, skip that step silently — do not ask.

## Procedure

1. **Run the link-pass:** call `figma_link_pass(projectId, figmaUrl)`.
   - If it fails on a missing/expired session token: tell the user a browser window is about to open, then call `login_to_ditto` and retry.
   - If it fails on `FIGMA_API_KEY`: relay the setup instructions from the error and stop.
2. **Report the outcome** in a compact summary: how many texts were connected to existing items, created new, skipped as ambiguous or placeholders, plus any component links. List ambiguous ones so the user can resolve them in Ditto manually if needed.
3. **Suggest semantic developer IDs** for the newly created items (their auto-generated IDs come back in the result, with each item's screen name). Judge each ID:
   - **Rename** content-derived IDs (`15-june-2025` for a date), truncated ones (`set-up-auto-debit-for-automati`), mismatches, and meaningless numbered duplicates.
   - **Keep** already-semantic IDs and short standard labels (`learn-more`, `continue`).
   - Good IDs describe the **purpose or UI element**, not the literal content; they stay valid when the text changes; kebab-case, 2–4 words, **max 30 characters** (Ditto rejects longer).
   - Use the **screen name** to disambiguate — the same text on two screens should get distinct, screen-prefixed IDs. Never suggest the same ID twice.
4. **Present the suggestions for review** as a numbered table (current ID → suggested ID, with the text and screen). The user approves all, picks numbers, edits, or skips — interpret flexibly. Never rename anything the user didn't approve.
5. **Apply approved renames** with `rename_developer_id(projectId, renames)` — one call. Report any skipped/failed entries from the result.
6. **Variablise dynamic content:** call `list_variablisation_candidates(projectId)` and keep only candidates from this run's items (post-rename IDs). Freshly imported Figma copy is where hardcoded sample values concentrate — dates, amounts, card last-4, emails.
   - Suggest `{{variable}}` replacements per that tool's rules (semantically specific names; reuse an existing workspace variable only when it genuinely fits; static text untouched). For items whose text is *entirely* a sample value (e.g. "4,000,000.00"), suggest replacing the whole text with the placeholder.
   - Present for approval in the same numbered-table style; apply approved ones via `update_text(projectId, updates)`.
   - Tell the user plainly: placeholders land as literal `{{name}}` text — the public API cannot link workspace variables, so listed-but-missing variables must be created and linked in the Ditto web app. Include the needed-variable list in the report.
7. **Translate into the variant — only if the user asked for one.** Follow the `/ditto-translate` playbook, scoped to this run's items:
   - Read `ditto://glossary/{variantId}` BEFORE translating (empty glossary → warn and confirm before proceeding).
   - Translate the touched items (created + connected that lack the variant — check with `list_untranslated` and intersect with this run's dev IDs, using post-rename IDs). Apply locked terms and voice rules; preserve `{{variables}}` and placeholders; keep UI-string lengths sensible. Self-review against the glossary before writing.
   - `write_translations(batch, variantId, status: "WIP")` — write as WIP; the next step moves everything to REVIEW.
8. **Stage everything for review.** Move all base items and all written variants to **REVIEW**, leaving anything already FINAL untouched (FINAL = expert-approved; never downgrade it). Use the status-list form of `update_status`, which structurally excludes FINAL:
   - Base items: `update_status(projectId, status: "REVIEW", fromStatus: ["NONE","WIP","REVIEW"])`.
   - Each variant translated this run: `update_status(projectId, status: "REVIEW", variantId, fromStatus: ["NONE","WIP","REVIEW"])`.
   - This is automatic — the handoff's purpose is to stage the batch for review. Report how many base items and variants moved.
9. **Tally:** connected / created / renamed / translated / moved-to-REVIEW counts, plus anything skipped and why. Suggest `/ditto-review` as the next step (an expert approves REVIEW → FINAL).

## Rules

- The link-pass tool itself is idempotent-ish (re-running connects rather than duplicates), but never re-run it to "fix" something without telling the user.
- Renames are a user decision — present, ask, then act. Status staging (→ REVIEW) is automatic, but never downgrades a FINAL item.
- Keep the review tables compact; truncate long copy to ~60 chars.
