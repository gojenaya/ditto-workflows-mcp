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
   - **Guardrail — items must NOT be floating.** Linking a Figma frame is only "done" when every item's copy actually lands under its frame in Ditto (the `connect` step persisted its instances). Check **both** `counts.floating === 0` **and** `counts.instancesPersisted === counts.instancesConnected`. `floating` covers created *and* connected-to-existing items and counts partial persistence (fewer instances than sent), not just zero. The tool resolves the true page, sends the connect in small batches, and re-verifies with retries, so anything still short means the backend genuinely rejected it — commonly a `figmaPageId`/frame mismatch, or a Figma node already claimed by another item. The `floating` list names the affected items + screens. Do NOT proceed as if the section is linked; diagnose first, and if it still won't link, stop and report it.
2. **Rename dev IDs — apply automatically, across BOTH result lists.** Go through `created` **and** `connectedToExisting` (both come back with dev IDs + screen names), decide semantic IDs, and apply them directly via `rename_developer_id(projectId, renames)` — one call, no approval step.
   - **Do not skip the connected-to-existing items.** They keep whatever IDs earlier passes gave them, so junk like `1000000`, `000002798236526`, `annie`, `okay-3`, `home-2` survives run after run and never gets cleaned unless this step covers them. Expect to rename far more existing items than created ones.
   - Rename content-derived IDs (`15-june-2025`, `000002798236526`), truncated ones (`set-up-auto-debit-for-automati`), trailing-punctuation ones (`recent-beneficiaries-`), mismatches, and meaningless numbered duplicates (`home-2`, `okay-3`, `add-5`). Keep already-semantic IDs and short standard labels (`learn-more`).
   - Good IDs describe the purpose/UI element, not the literal content; kebab-case, 2–4 words, max 30 chars. Use the screen name to disambiguate; never reuse an ID.
   - Group repeated UI roles under a shared prefix so the project reads well: `nav-home` / `nav-calls` / `nav-chats`, `debit-card-option-1` / `-2`.
3. **Variablise — apply automatically, but only once step 1's guardrail is green.** Rewriting copy to `{{placeholders}}` makes the item text stop matching the Figma text, so any later re-link or repair pass can no longer match those items and they have to be hand-mapped by node ID. Never variablise over a partially-linked section.
   - `list_variablisation_candidates(projectId)`, keep this run's items (post-rename IDs), and apply `{{variable}}` replacements directly via `update_text(projectId, updates)` — no approval step. Semantically specific names; reuse an existing workspace variable only when it genuinely fits; for a text that is entirely a sample value, replace the whole text with the placeholder. Note in the final report which variables the workspace still lacks (they must be created/linked in the Ditto web app — the API can't link them).
   - **Read the item list yourself as well — the detector is regex-based and finds only what it has a pattern for.** It catches amounts, card last-4, reference IDs, dial codes, dates, percentages and emails, but it cannot judge *semantics*: hardcoded personal names (`Transfer to Moataz` → `Transfer to {{recipient_name}}`), sample counts written as words (`20K users`), placeholder junk (`XX AED`), and currency codes in their own layer (`AED`, `PHP`) all need your eye. Scan every item's text, not just the tool's candidate list.
4. **Translate — only if a variant was given.** Delegate to `/ditto-translate`'s subagent pattern: **spawn one translation subagent per requested variant, in parallel (single message)**, each following the /ditto-translate Procedure for that variantId. Each returns only a compact summary `{variantId, wrote, skipped}` — do NOT translate inline in the handoff context (that's what keeps this orchestrator lean). Translations write as WIP; they'll be reviewed later. If no subagent capability, translate inline, one variant at a time. (Keeping the untranslated lists + glossaries inside the subagents is the token-efficiency win — the handoff context never loads them.)
5. **Stage everything at REVIEW.** Move base items and each written variant to REVIEW without touching FINAL, using the status-list form:
   - Base: `update_status(projectId, status: "REVIEW", fromStatus: ["NONE","WIP","REVIEW"])`.
   - Each variant: `update_status(projectId, status: "REVIEW", variantId, fromStatus: ["NONE","WIP","REVIEW"])`.
   - **Keep the `fromStatus` form — don't switch to an explicit `ids` list here.** `fromStatus` derives its targets from variant rows that actually exist; an `ids` list can name items with no translation, and promoting those would mint empty copy. The tool now refuses that and reports the skipped IDs — treat any such report as "these still need translating", not as a failure.
6. **Audit before reporting — don't trust the step reports.** Each step returns its own summary; those summaries are what let silent failures through. Re-read the project and confirm: every item's Figma instances persisted, no dev ID still looks auto-generated, no item still holds a hardcoded dynamic value, and no variant has empty text. Fix anything that turns up, then report.
7. **Report once, at the end:** connected / created / renamed / variablised / translated / moved-to-REVIEW counts, ambiguous or skipped items, and any variables that need creating in the web app. Point the user to `/ditto-review` (or `export_review_sheet`) to review the batch now staged at REVIEW.

## Rules

- **Autonomous by default — don't stop for approvals.** Everything lands at REVIEW (never FINAL), so review happens after. Stop only for real blockers (auth, ambiguous project). If the user explicitly says they want to review as you go, switch to presenting each step for approval instead.
- Never promote to FINAL in this flow — that's the reviewer's job (`/ditto-review`).
- Renames and variablisation are reversible (rename again; re-edit text); staging never downgrades a FINAL item.
- The link-pass is idempotent-ish (re-running connects rather than duplicates) — don't silently re-run it to "fix" things.
- **Order is load-bearing:** link → *verify* → rename → variablise → translate → stage. Variablising before verifying breaks re-matching; variablising after translating leaves the variants holding stale literals (if that happens, mirror the placeholders into each variant, and re-translate anything whose surrounding words changed).
- **Editing base text in the Ditto web app silently drops that item's variants.** If the user has been editing alongside you, re-check for missing/empty variants before reporting.
