---
name: ditto-translate
description: Translate a Ditto project's untranslated strings into one or more variants — refresh translation assets, read the workspace glossary, translate in batches with self-review, write back directly as FINAL (no review stage). Use when the user wants to translate or localise strings in Ditto.
---

# Ditto translation loop

Glossary-aware translation of a project's untranslated strings using the ditto-workflows-mcp tools. You are the translation engine; the glossary and translation memory are your source of truth for terminology and voice.

## Arguments

`/ditto-translate [projectId] [variantId...]` — all optional. If projectId is missing, call `list_projects` and ask the user to pick. One or more variants may be requested (e.g. "Arabic and Hindi").

**If no variant is named, call `get_settings` and use `defaultVariant`.** Don't ask the user which language — a configured default is them having already answered that, and don't ask them to create the variant either: `workspaceVariants` in the same response tells you whether it exists. The individual tools do fall back to the default server-side when `variantId` is omitted, but the subagent pattern below needs a concrete variant ID per agent, so resolve it explicitly up front. Stop and say so only if there is no default and none was named.

## Execution — delegate translation to a subagent per variant (token-efficient, parallel)

Translating drags large data into context — the untranslated list (often 100+ rows), the glossary (~25k chars), and the memory table. Keep that OUT of the orchestrating context by **delegating each variant's translation to its own subagent**, and run variants **concurrently**:

- When the Agent/Task tool is available, spawn **one subagent per requested variant, all in a single message** so they run in parallel. Each subagent is told: "Follow the /ditto-translate Procedure below for projectId=X, variantId=Y."
- Each subagent MUST return **only a compact summary** — `{variantId, memoryEntries, conflicts, wrote, skipped:[{id, reason}]}`. Never return the translations, the untranslated list, or the glossary text. Keeping the bulk in the subagent's context (which is discarded after it returns) is the entire point of the optimization.
- The orchestrator waits for all subagents, then merges their summaries into one report and suggests `/ditto-review`. It never itself reads the untranslated list or the glossary.
- **Fallback:** if no subagent/Task capability (some non–Claude-Code clients), run the Procedure inline, one variant at a time.

Independent by construction: different variants are different variant writes with no shared state, so parallel subagents never conflict. Do NOT split a single variant across parallel subagents — repeated source strings wouldn't be translated consistently.

## Procedure (each variant / subagent runs this for its own variantId)

1. **Refresh assets:** call `refresh_translation_assets(variantId?)` so the translation memory reflects the latest FINAL (expert-approved) copy. It excludes configured test/sandbox projects and holds conflicting sources OUT of the memory (they go to a separate `translation-conflicts.md` for the user to resolve — don't translate from that file). Note the memory-entry count; mention the conflict count so the user knows some sources are pending resolution.
2. **Read the glossary:** read the `ditto://glossary/{variantId}` resource BEFORE translating anything. If it comes back empty, stop and tell the user: either distill one first (read the translation-memory file from step 1 in chunks and extract locked terms + voice rules into `translation-assets/` files), or confirm they want to translate without a glossary.
3. **Fetch the work:** call `list_untranslated(projectId, variantId?)`. If count is 0, say so and stop.
4. **Query the memory — `lookup_translation_memory(sources, variantId)`.** Pass the batch's source strings; it returns only the rows that matter. Do NOT read `translation-assets/{variantId}/translation-memory.md` to do this: that file is a *display rendering* — long cells are hard-wrapped on `<br>` and every column is space-padded — so grepping it silently misses short entries (`Send`, `Pay`, `Add`, `Home`) and hands back broken text. It is for humans; the tool is for you.
5. **Translate in batches of ~20 — memory first, then translate the rest.** Each lookup result carries a `match`:
   - **`exact` → reuse its `translation` verbatim** (barring an obvious context mismatch — flag those rather than silently diverging). This keeps terminology identical across projects.
   - **`near` → mirror the top candidate's wording and locked terms** rather than inventing new phrasing. Candidates are scored 0–1 and ranked; treat a low score as a hint, not an answer.
   - **`conflict` → approved copy exists but the workspace disagrees with itself.** Do NOT pick one silently. Either use the glossary to settle it and say so in your report, or skip the string. These never appear in the memory file at all, so this is the only way you'll see them.
   - **`none` → translate from scratch.**
   - Always: apply locked glossary terms exactly; follow the voice rules; preserve `{{variables}}`/placeholders untranslated; keep UI-string lengths sensible.
5b. **Plural forms — when the target has more categories than English.** English has two plural
   categories (`one`, `other`); Arabic has six (`zero one two few many other`), Russian, Polish and
   Czech four, Indonesian one. `list_untranslated` reports `pluralCategoriesForLocale` and flags each
   item that needs them — `needsPluralForms` for new work, `incompletePluralForms` for items already
   translated but short of the locale's categories.
   - **Write the forms; do not force one template.** A single Arabic string cannot be correct for 1, 2,
     3 and 11 at once. `ar-voice-rules.md` §5 has prescribed this from the start; until now the skill
     gave no mechanism, so the agent fell back to one form and said so in its notes. The mechanism is
     the `plurals` field:
     `write_translations([{ id, plurals: { one: …, two: …, few: …, many: …, other: … } }], "ar")`
   - `text` and `plurals` are mutually exclusive — pass one or the other. Ditto derives the item's
     display text from the first form.
   - **Categories are validated against the target locale and a wrong one is refused.** Ditto itself
     accepts a `few` form on English and creates something no runtime will ever select, so the check
     lives here. `zero` is optional in Arabic — most UIs never render a zero count — but the other five
     are not.
   - Arabic guidance, consistent with `ar-voice-rules.md` §5: `one` singular, `two` dual (`قسطان`),
     `few` (3–10) plural (`{{n}} أقساط`), `many` (11–99) singular accusative (`{{n}} قسطًا`), `other`
     (100+) singular (`{{n}} قسط`).
   - Keep the placeholder in every form, verbatim.

6. **Self-review each batch before writing:** re-check every translation against the memory, locked terms, and voice rules; fix violations. Skip (don't guess) strings that can't be translated confidently without UI context — ambiguous single words, truncated fragments.
7. **Write back:** `write_translations(batch, variantId, status: "FINAL")` — one call per batch. This variant writes FINAL directly; there is no WIP/REVIEW staging step.
8. **Return / report:** as a subagent, return the compact summary object only. Running inline, report total written (at FINAL) + every skipped item with the reason. Because translations land at FINAL immediately, be conservative — skip anything you can't translate confidently rather than committing a guess as approved copy.

## Rules

- **A locale with more plural categories than the source needs plural forms, not a compromise string.**
  Writing one Arabic form for `{{installment_count}} installments` is grammatically wrong for five of
  Arabic's six categories. Two live items shipped that way (`split-plan-option`,
  `installments-count-title` in salary-loan) before the tooling could express plurals at all.

- **Components are never translated here — including when the translation is missing.** A library component's translations belong to the component and are written by its owner in the Ditto web app. An *absent* translation is not an invitation: writing it would push unreviewed copy into every project using that component. `list_untranslated` and `list_for_review` leave component-governed items out, and `write_translations` refuses them (`componentLinkedSkipped`). Report them to the owner; never route around it by writing to the project item, and never count them as your own skipped items — they were never yours to translate.
- The glossary lives in the MCP resource — read it fresh every run; never copy its rules into this skill or assume them from memory.
- **Never grep or read `translation-memory.md` to look something up** — use `lookup_translation_memory`. The file's `<br>` wrapping and column padding are display artifacts that make ad-hoc matching quietly wrong; the tool matches on the real data and also surfaces conflicts, which the file omits by design.
- Write at status **FINAL** directly — this variant has no review stage. (The review-process variant of this skill writes WIP and hands off to `/ditto-review`; this one does not.)
- Skipping with a stated reason beats a confident-sounding guess — doubly so here, since FINAL copy ships without a review gate.
- A subagent returns a compact summary, never the bulk (translations/lists/glossary) — that isolation is what keeps orchestrator tokens low.
