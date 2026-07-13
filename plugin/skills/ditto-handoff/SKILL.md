---
name: ditto-handoff
description: Full Figma→Ditto handoff — paste a Figma frame link, its copy is linked into a Ditto project (existing texts connected, new ones created), new items get semantic developer IDs the user reviews, and approved items can be promoted to FINAL. Use when the user pastes a Figma link to hand off, sync, or import a screen's copy into Ditto.
---

# Figma → Ditto handoff

One flow from a pasted Figma link to reviewed, semantically named text items: link-pass → semantic dev IDs → user review → optional FINAL promotion. Uses the unofficial backend tools (session login) plus the Figma REST API.

## Arguments

`/ditto-handoff [figmaUrl] [projectId]` — both optional. If the Figma URL is missing, ask for a **"Copy link to selection"** link (right-click the frame/section in Figma — a plain file link won't work; the tool requires a `node-id`). If projectId is missing, call `list_projects` and ask the user to pick.

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
6. **Offer FINAL promotion:** show the final list (dev ID + text) of the items this run touched (created + connected), and ask whether to set their status to FINAL. Only on an explicit yes: `update_status(projectId, status: "FINAL", ids: [...])` with exactly those dev IDs (post-rename ones for renamed items). If the user declines, leave them WIP and say so.
7. **Tally:** connected / created / renamed / promoted counts, plus anything skipped and why. Suggest `/ditto-translate` as the natural next step if the workspace translates into a variant.

## Rules

- The link-pass tool itself is idempotent-ish (re-running connects rather than duplicates), but never re-run it to "fix" something without telling the user.
- Renames and FINAL promotion are user decisions — present, ask, then act.
- Keep the review tables compact; truncate long copy to ~60 chars.
