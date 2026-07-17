---
name: ditto-handoff
description: Full Figma→Ditto handoff — paste a Figma frame link and it runs end to end without stopping: link the copy into a Ditto project, give new items semantic developer IDs, variablise hardcoded dynamic values, optionally translate into a variant (e.g. Arabic), and stage everything at REVIEW for a later human review. Use when the user pastes a Figma link to hand off, sync, or import a screen's copy into Ditto.
---

# Figma → Ditto handoff

One autonomous flow from a pasted Figma link to a batch staged for review: link-pass → semantic dev IDs → variablise dynamic content → optional variant translation → stage everything at REVIEW. Uses the unofficial backend tools (session login) plus the Figma REST API.

**Run it end to end without stopping.** Apply your own best-judgement decisions (renames, variablisation, translations) as you go — do NOT pause to ask the user to approve each step. This is safe because nothing is promoted to FINAL: the whole batch lands at REVIEW, and the human review happens *afterwards* (via `/ditto-review` or a review sheet). Only stop for a genuine blocker (missing session token, missing `FIGMA_API_KEY`, an ambiguous project) — never for routine approval.

## Arguments

`/ditto-handoff [figmaUrl] [projectId] [variantId]` — all optional. If the Figma URL is missing, ask for a **"Copy link to selection"** link (right-click the frame/section in Figma — a plain file link won't work; it needs a `node-id`). If projectId is missing, call `list_projects` and ask the user to pick. If the user mentions a language/variant anywhere ("…and add Arabic", "translate to fr"), use it for the translation step; if none is mentioned, skip translation silently.

## Procedure (run straight through)

1. **Link-pass:** call `figma_link_pass(projectId, figmaUrl)`.
   - Missing/expired session token → tell the user a browser window is opening, call `login_to_ditto`, retry.
   - Missing `FIGMA_API_KEY` → relay the setup instructions and stop (genuine blocker).
2. **Rename dev IDs — apply automatically.** For the newly created items (auto-generated IDs + screen names come back in the result), decide semantic IDs and apply them directly via `rename_developer_id(projectId, renames)` — one call, no approval step.
   - Rename content-derived IDs (`15-june-2025`), truncated ones (`set-up-auto-debit-for-automati`), mismatches, meaningless numbered duplicates. Keep already-semantic IDs and short standard labels (`learn-more`).
   - Good IDs describe the purpose/UI element, not the literal content; kebab-case, 2–4 words, max 30 chars. Use the screen name to disambiguate; never reuse an ID.
3. **Variablise — apply automatically.** `list_variablisation_candidates(projectId)`, keep this run's items (post-rename IDs), and apply `{{variable}}` replacements directly via `update_text(projectId, updates)` — no approval step. Semantically specific names; reuse an existing workspace variable only when it genuinely fits; for a text that is entirely a sample value, replace the whole text with the placeholder. Note in the final report which variables the workspace still lacks (they must be created/linked in the Ditto web app — the API can't link them).
4. **Translate — only if a variant was given.** Delegate to `/ditto-translate`'s subagent pattern: **spawn one translation subagent per requested variant, in parallel (single message)**, each following the /ditto-translate Procedure for that variantId. Each returns only a compact summary `{variantId, wrote, skipped}` — do NOT translate inline in the handoff context (that's what keeps this orchestrator lean). Translations write as WIP; they'll be reviewed later. If no subagent capability, translate inline, one variant at a time. (Keeping the untranslated lists + glossaries inside the subagents is the token-efficiency win — the handoff context never loads them.)
5. **Stage everything at REVIEW.** Move base items and each written variant to REVIEW without touching FINAL, using the status-list form:
   - Base: `update_status(projectId, status: "REVIEW", fromStatus: ["NONE","WIP","REVIEW"])`.
   - Each variant: `update_status(projectId, status: "REVIEW", variantId, fromStatus: ["NONE","WIP","REVIEW"])`.
6. **Report once, at the end:** connected / created / renamed / variablised / translated / moved-to-REVIEW counts, ambiguous or skipped items, and any variables that need creating in the web app. Point the user to `/ditto-review` (or `export_review_sheet`) to review the batch now staged at REVIEW.

## Rules

- **Autonomous by default — don't stop for approvals.** Everything lands at REVIEW (never FINAL), so review happens after. Stop only for real blockers (auth, ambiguous project). If the user explicitly says they want to review as you go, switch to presenting each step for approval instead.
- Never promote to FINAL in this flow — that's the reviewer's job (`/ditto-review`).
- Renames and variablisation are reversible (rename again; re-edit text); staging never downgrades a FINAL item.
- The link-pass is idempotent-ish (re-running connects rather than duplicates) — don't silently re-run it to "fix" things.
