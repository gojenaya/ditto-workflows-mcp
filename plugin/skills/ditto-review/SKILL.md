---
name: ditto-review
description: Review pending Ditto translations for a project — either interactively in chat or by handing a human translator a Markdown review sheet — then push results back (edits and approvals become FINAL). Includes a flag-only guardrail pass that checks copy against the Ditto style guide, the local glossary/voice-rules, and the nova-copy references to catch what slipped through, and a feedback loop that turns reviewer corrections into durable rules pushed back to the Ditto style guide. Use when the user wants to review, QA, approve, or hand off translations for review in Ditto.
---

# Ditto translation review loop

Review a project's pending translations using the ditto-workflows-mcp tools. Two modes:

- **A — Translator review sheet (for a human expert):** when the user wants a *translator* to review (not review in chat themselves), export a Markdown sheet the translator edits — flag concerns, write optimal translations — then apply it back. Best when the reviewer is a native speaker who isn't driving Claude.
- **B — Interactive in chat:** Claude presents each translation for the user to approve/edit/skip live.

## Arguments

`/ditto-review [projectId] [variantId]` — both optional. If projectId is missing, call `list_projects` and ask the user to pick. If variantId is missing, the tools use the configured default variant.

## Guardrail check (flag-only) — run before both modes

The guardrail is a **safety net, not a copy review.** Designers already run copy review (often via the `nova-copy` skill) *before* pushing to Ditto — this pass exists only to catch clear, objective violations they missed, not to second-guess their wording. Run it over the queue before presenting Mode A or Mode B, and surface the flags alongside each item.

**Load the three rule sources (whichever are available):**
1. **Ditto style guide** — call the official Ditto MCP `get_styleguide_rules` (workspace- + project-level rules: terminology, tone, formatting, do-not-translate lists). If that MCP isn't connected, say so and continue with the two below.
2. **Local glossary + voice rules** — read the `ditto://glossary/{variantId}` resource (locked terms, voice rules, forbidden patterns, the do-not-translate brand list).
3. **nova-copy references** — botim's shared copy source of truth: `tone-of-voice.md`, `terminology.md`, `design-guidelines.md`. Resolve them the way the `nova-copy` skill does (`.claude/skills/nova-references/…`, or files supplied in-conversation). If unavailable, note it and continue — don't block.

**Flag ONLY objective, high-confidence violations** (map each to a severity, mirroring `ar-voice-rules.md` §8):
- 🔴 P0 — do-not-translate brand term was translated (e.g. `botim Credit` / `botim Finance` / `botim Pay` rendered in Arabic); glossary/style-guide locked term mismatch; reversed meaning; placeholder dropped, renamed, or fused; wrong currency/number/RTL format.
- 🟡 P1 — voice-rule breach (e.g. third-person present verb on a CTA — `يكمل` for Continue), terminology inconsistent with a rule source, tone class wrong for the surface.
- 🔵 P2 — punctuation/diacritics rule breaks.

**Do NOT:**
- rewrite copy or attach "better" alternatives (the reviewer/translator decides the fix — you only point at the rule that's broken);
- flag copy the designer changed on purpose, subjective phrasing, or anything that merely differs from what you'd have written but breaks no rule;
- nitpick. If it isn't a nameable rule from one of the three sources, don't raise it.

Output a compact list: item id · the flagged text · the rule it breaks (name the source) · severity. Then proceed into the chosen mode with these flags shown inline. When no source is available at all, tell the user the guardrail was skipped rather than implying copy passed.

## Mode A — translator review sheet

0. **Run the guardrail check first** (above) so the flags can be written into each row's Notes for the translator.
1. `export_review_sheet(projectId, variantId?, statuses=['REVIEW'])` — writes a Markdown sheet (base · current translation · Verdict · editable Suggested · Notes) and returns its path + content. Pre-fill Notes with any guardrail flag for that row (rule + severity only, no suggested rewrite). Give the translator the path (or paste the sheet in chat).
2. The translator edits each row: `approve` to keep, or `edit` + rewrite the Suggested cell; blank/`skip` to defer; Notes to flag. `{{variables}}` and placeholders stay intact.
3. `apply_review_sheet(projectId, variantId?, path?)` — pushes it back: edited rows written at FINAL, approvals promoted to FINAL, deferred rows left in REVIEW. Report the returned tally (edited / approved / deferred). **Keep the edited rows** (their Current vs Suggested text) for the "Learn from corrections" step.
4. Then do "Refresh the translation memory" and "Learn from corrections" below.

## Mode B — interactive review, procedure

1. **Fetch the queue:** call `list_for_review(projectId, variantId?)` (default statuses WIP + REVIEW). If count is 0, say so and stop.
2. **Run the guardrail check** (above) — it already loads the glossary plus the Ditto style guide and nova-copy references, and produces per-item flags. The reviewer's judgment always wins over a flag.
3. **Present in batches of ~10.** For each item show, in a compact numbered list:
   - the base text
   - the current translation
   - its status
   - any guardrail flag for that item (rule + severity, no rewrite) — only real rule breaks, never nitpicks
4. **Collect verdicts per batch:** the reviewer replies with approvals, edits, or skips (e.g. "1,3-5 ok; 2: <new text>; skip 6"). Interpret flexibly.
5. **Push results after each batch:**
   - Edits → `write_translations(translations, variantId, status: "FINAL")`
   - Untouched approvals → `update_status(projectId, status: "FINAL", ids, variantId)`
   - Skips → leave untouched, carry to the tally
6. **Tally at the end:** report counts of approved / edited / skipped, plus any items where the push failed or was skipped by the API.
7. **Refresh the translation memory:** if anything was promoted or edited to FINAL, call `refresh_translation_assets(variantId)` so the local translation memory picks up the newly approved copy. If the session surfaced recurring glossary gaps or tone drift, suggest re-distilling the glossary from the refreshed memory.
8. Then do "Learn from corrections" below.

## Learn from corrections — feed rules back to the style guide

Every reviewer edit is a signal: Claude's translation was wrong in a way a human fixed. Turn the *generalizable* ones into durable rules so the mistake isn't repeated. A correction is a `{from: what Claude/the old copy said, to: what the reviewer approved}` pair — from the edited review-sheet rows (Mode A) or the in-chat edits (Mode B).

1. **Distill — only what generalizes.** From the corrections, keep the ones that state a reusable rule, not a one-off phrasing preference:
   - a **do-not-translate** brand/product term (e.g. `botim Credit` / `botim Finance` / `botim Pay` must stay in English/Latin);
   - a **commonly-mistranslated** word or phrase with a clear right form;
   - a **voice rule** (e.g. a CTA must not use a third-person present verb — `يكمل` → `متابعة`).
   Drop pure stylistic tweaks the reviewer just preferred in that one spot. When unsure whether it generalizes, ask the reviewer.
2. **Update the local source of truth first.** Add each distilled rule to the variant's `translation-assets/{v}-glossary.md` (terms / do-not-translate) or `{v}-voice-rules.md` (voice/grammar), with a dated changelog note — this is what `/ditto-translate` reads on every run.
3. **Then push to the Ditto style guide** (so designers see it where they work). This writes to a shared, cross-team artifact — **show the reviewer the exact rules you'll add and get a yes before writing.**
   - `list_style_guides` → pick the guide; choose a section by `kind` (`wordlist` for terms/do-not-translate, `rules` for voice/grammar).
   - `list_style_guide_rules(styleguideId)` → skip anything already covered; don't duplicate.
   - `add_style_guide_rules(styleguideId, rules)` — each rule `{sectionId, name, description, examples:[{from,to}], tags}`. Put the wrong→right pair in `examples` (`from` = wrong, `to` = correct); tag with the variant id and a category (`brand`, `cta`, …).
   - Report what was added. (Requires a session token — `set_session_token` / `login_to_ditto` — since style-guide writes use the unofficial backend.)

## Rules

- Never change a translation the reviewer didn't ask you to change — if you disagree, flag it and let them decide.
- The guardrail flags, it does not fix: name the broken rule and its source, never attach a rewrite or "better" alternative.
- Guardrail is high-precision by design — a false flag on intentional copy wastes the reviewer's time and erodes trust in the pass. When unsure whether something breaks a nameable rule, stay silent.
- Preserve `{{variables}}`, placeholders, and markup in edits exactly.
- Batch writes (one `write_translations` / `update_status` call per batch), not per-item calls.
- Style-guide rules are a shared, cross-team artifact — never push one without showing the reviewer the exact rule and getting an explicit yes. Update the local glossary/voice-rules first; the Ditto style guide mirrors it.
