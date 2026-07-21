---
name: ditto-translate
description: Translate a Ditto project's untranslated strings into one or more variants — refresh translation assets, read the workspace glossary, translate in batches with self-review, write back directly as FINAL (no review stage). Use when the user wants to translate or localise strings in Ditto.
---

# Ditto translation loop

Glossary-aware translation of a project's untranslated strings using the ditto-workflows-mcp tools. You are the translation engine; the glossary and translation memory are your source of truth for terminology and voice.

## Arguments

`/ditto-translate [projectId] [variantId...]` — all optional. If projectId is missing, call `list_projects` and ask the user to pick. If no variant is given, the tools use the configured default variant. One or more variants may be requested (e.g. "Arabic and Hindi").

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
4. **Load the memory for reuse:** read `translation-assets/{variantId}/translation-memory.md` (the Memory table from step 1). This is your reference for reuse — do NOT translate from scratch what the workspace has already approved.
5. **Translate in batches of ~20 — memory first, then translate the rest:**
   - **Exact source match in memory → reuse its FINAL translation verbatim** (barring an obvious context mismatch — flag those rather than silently diverging). This keeps terminology identical across projects.
   - **Similar source (same term/phrase, different surrounding text) → mirror the memory's wording and locked terms** rather than inventing new phrasing.
   - Only translate from scratch when the memory has nothing close.
   - Always: apply locked glossary terms exactly; follow the voice rules; preserve `{{variables}}`/placeholders untranslated; keep UI-string lengths sensible.
6. **Self-review each batch before writing:** re-check every translation against the memory, locked terms, and voice rules; fix violations. Skip (don't guess) strings that can't be translated confidently without UI context — ambiguous single words, truncated fragments.
7. **Write back:** `write_translations(batch, variantId, status: "FINAL")` — one call per batch. This variant writes FINAL directly; there is no WIP/REVIEW staging step.
8. **Return / report:** as a subagent, return the compact summary object only. Running inline, report total written (at FINAL) + every skipped item with the reason. Because translations land at FINAL immediately, be conservative — skip anything you can't translate confidently rather than committing a guess as approved copy.

## Rules

- The glossary lives in the MCP resource — read it fresh every run; never copy its rules into this skill or assume them from memory.
- Write at status **FINAL** directly — this variant has no review stage. (The review-process variant of this skill writes WIP and hands off to `/ditto-review`; this one does not.)
- Skipping with a stated reason beats a confident-sounding guess — doubly so here, since FINAL copy ships without a review gate.
- A subagent returns a compact summary, never the bulk (translations/lists/glossary) — that isolation is what keeps orchestrator tokens low.
