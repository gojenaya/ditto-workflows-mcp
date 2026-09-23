---
name: ditto-handoff
description: Full Figma→Ditto handoff — paste a Figma frame link and it runs end to end without stopping: link the copy into a Ditto project, give new items semantic developer IDs, variablise hardcoded dynamic values, translate into the requested variant — or the configured default variant, automatically, with no need to name it in the prompt — and set everything to FINAL (no review stage). Use when the user pastes a Figma link to hand off, sync, or import a screen's copy into Ditto.
---

# Figma → Ditto handoff

One autonomous flow from a pasted Figma link to a finished batch: link-pass → semantic dev IDs → variablise dynamic content → variant translation (the configured default needs no prompting) → set everything to FINAL. Uses the unofficial backend tools (session login) plus the Figma REST API.

**Run it end to end without stopping.** Apply your own best-judgement decisions (renames, variablisation, translations) as you go — do NOT pause to ask the user to approve each step. Only stop for a genuine blocker (missing session token, missing `FIGMA_API_KEY`, an ambiguous project) — never for routine approval.

> **This variant has no review stage — the batch lands at FINAL directly.** There is no `/ditto-review` gate afterwards, so favour caution: skip anything ambiguous rather than committing a guess as approved copy. (The review-process variant of this skill stages at REVIEW instead; use that one when a human should sign off before copy goes live.)

## Arguments

`/ditto-handoff [figmaUrl] [projectId] [variantId]` — all optional. If the Figma URL is missing, ask for a **"Copy link to selection"** link (right-click the frame/section in Figma — a plain file link won't work; it needs a `node-id`). If projectId is missing, call `list_projects` and ask the user to pick.

**Resolving which variant(s) to translate into — call `get_settings` first, every run.** Resolve in this order and stop at the first hit:

1. An explicit `variantId` argument.
2. A language the user mentioned anywhere in the prompt ("…and add Arabic", "translate to fr").
3. **`get_settings().defaultVariant` — a configured default means translate, automatically.** Setting a default is the user saying "always this language"; making them repeat it in every prompt defeats the point of the setting. This step used to be missing entirely, so a configured default was silently ignored and nothing was ever translated.

Only skip translation if all three are empty, or the user explicitly says not to translate. **Never ask which language when a default is configured, and never ask the user to create that variant** — `get_settings` returns `workspaceVariants` with `defaultVariantExists`, so check it: if it's listed, it exists, just translate. If `defaultVariantExists` is `false`, say so plainly and skip that variant (variants are created in the Ditto web app; no tool here creates them).

## Procedure (run straight through)

### What can run in parallel

The pipeline has one hard spine — **link → rename → variablise → translate → FINAL** — and each of those
writes depends on the one before it. Parallelising *across* that spine corrupts the run: variablisation
uses post-rename IDs, and merging duplicates before translating is what stops you paying to translate
the same string five times.

What genuinely parallelises is the **thinking**, not the writing. Fan these out in a single message;
none of them reads another's output:

| Run in parallel | Why it is safe |
|---|---|
| **Naming decisions, one subagent per screen** (step 2) | Each frame's strings are named from that frame's own context. A 100-string section is 5 screens' worth of independent judgement. |
| **Naming vs variablisation detection** (steps 2 and 3) | Renaming changes IDs, variablisation changes text. Both read the same post-link state, so decide both at once — then **apply them in order**, rename first. |
| **One translation subagent per variant** (step 4) | Arabic has no bearing on Hindi. This is the biggest single win and is already the documented pattern. |
| **The audit's four checks** (step 6) | Instances persisted, dev IDs, leftover hardcoded values, empty variants — four independent reads. |

Two rules when you fan out:

- **Each subagent returns a compact summary, never its working.** A naming agent returns
  `{from, to}` pairs; a translation agent returns `{variantId, wrote, skipped}`. Loading their
  intermediate lists into this context is what the fan-out exists to avoid.
- **Apply writes from the orchestrator, not from the subagents.** Parallel writers race on the same
  project and the dev-ID uniqueness check stops being meaningful. Gather decisions in parallel, write
  sequentially.

1. **Link-pass:** call `figma_link_pass(projectId, figmaUrl)`.
   - Missing/expired session token → tell the user a browser window is opening, call `login_to_ditto`, retry.
   - Missing `FIGMA_API_KEY` → relay the setup instructions and stop (genuine blocker).
   - **Guardrail A — read `skippedOffScreenItems` and JUDGE it. This is not a formality.** The filter keeps
     only text on a product screen; everything else is listed with a reason. Two failure modes, and the
     second is the dangerous one:
     - *Something skipped is real copy.* A short bottom-sheet frame trips the height check, an unusual
       screen size trips the width check, and a component set whose variants genuinely differ loses all
       but the default. Re-run with `screenBounds` widened, or `includeComponentSets: true`, for that case.
     - *Something imported is not copy.* Slides, flow labels and designer notes that slipped through.
     Report what was skipped in the final summary either way — the user knows their file; you do not.
     **`floating === 0` is not the guardrail — it is one of two.** It passes happily while
     `skippedOffScreenItems` contains real problems, and it did: on a Salary Loan run a mis-detected
     screen container and a duplicated component set both passed the floating check and still shipped
     wrong copy. Read BOTH lists, every run.
   - **Guardrail B — items must NOT be floating.** Linking a Figma frame is only "done" when every item's copy actually lands under its frame in Ditto (the `connect` step persisted its instances). Check **both** `counts.floating === 0` **and** `counts.instancesPersisted === counts.instancesConnected`. `floating` now covers created *and* connected-to-existing items and counts partial persistence (fewer instances than sent), not just zero — an earlier version scoped it to created items only, which made `floating: 0` mean "no NEW item is floating" while most of the connected ones had silently landed nowhere. The tool resolves the true page, sends the connect in small batches, and re-verifies with retries, so anything still short means the backend genuinely rejected it. Do NOT proceed as if the section is linked. Diagnose before continuing:
     - Common cause: a `figmaPageId` / frame mismatch, or the Figma node is already claimed by another item. The `floating` list names the affected items + screens.
     - Workaround (as used in the SNPL branch case): re-run the `connect` for just the floating items with the **correct resolved page** (`GET /v1/files/{key}?ids={node}&depth=2` → the one CANVAS that comes back with children is the real page), then re-verify `figmaV2.instances` persisted. Only continue once `floating` is 0.
     - If it still won't link after the workaround, stop and report it — shipping floating copy to FINAL is worse than pausing.
1b. **CLEAN UP before you name anything.** Read the `created` list and judge each item: is this really
   product copy? The structural and content filters catch a lot, but neither can catch everything inside
   a phone-sized frame, and two categories are explicitly left to you because no heuristic can settle
   them safely:
   - **Mock values typed into form fields** — "abby", "toy", a sample name in an input. Indistinguishable
     from real short copy by shape alone.
   - **A person's name used as a label** — "Yue Sui" looks exactly like a legitimate name field.
   Also watch for spec fragments, stray labels and anything that reads as a designer talking to a
   developer rather than to a user.
   - **Do this BEFORE renaming.** Everything downstream compounds: on one run nine junk items were
     named, variablised, reported, and one reached FINAL with an Arabic translation before anyone
     noticed. Deleting first costs one step; deleting last costs five.
   - Use `delete_text_items(projectId, ids)` — it is a **dry run by default** and shows what each
     deletion would take with it (variants, plural rows, Figma instances).
   - **On a live project, show the user the dry run and get their go-ahead before passing `confirm`.**
     A playground is yours to clean; a shipping project is not. The dry run is exactly what to show them.

2. **Rename dev IDs — apply automatically, across BOTH result lists.** Go through `created` **and** `connectedToExisting` (both come back with dev IDs + screen names), decide semantic IDs, and apply them directly via `rename_developer_id(projectId, renames)` — one call, no approval step.
   - **Start with `propose_developer_ids(figmaUrl, projectId)`.** It resolves what the design already answers — component-library strings and unambiguous UI roles — and hands back the rest as a compact digest (one line per string with font size, weight and container, in reading order). Name those from the digest; it carries the hierarchy a flat list of strings loses, at a fraction of the tokens of a screenshot. It also returns IDs it has seen before, so a re-run does not rename anything.
   - `rename_developer_id` **rejects** copy-derived and generic targets — including Ditto's own slug-plus-counter (`abc-1`, `home-2`, `okay-3`), which reads as a deliberate name but is just the copy again. A rejection comes back with the reason; fix the name rather than passing `allowAnyId`.
   - After the renames land, call `remember_developer_ids(figmaUrl, decisions)`. Without it the next run on the same frame proposes fresh names and churns IDs under engineers who already reference them.
   - **Do not skip the connected-to-existing items.** They keep whatever IDs earlier passes gave them, so junk like `1000000`, `000002798236526`, `annie`, `okay-3`, `home-2` survives run after run and never gets cleaned unless this step covers them. Expect to rename far more existing items than created ones.
   - Rename content-derived IDs (`15-june-2025`, `000002798236526`), truncated ones (`set-up-auto-debit-for-automati`), trailing-punctuation ones (`recent-beneficiaries-`), mismatches, and meaningless numbered duplicates (`home-2`, `okay-3`, `add-5`). Keep already-semantic IDs and short standard labels (`learn-more`).
   - Group repeated UI roles under a shared prefix so the project reads well: `nav-home` / `nav-calls` / `nav-chats`, `debit-card-option-1` / `-2`.
   - Good IDs describe the purpose/UI element, not the literal content; kebab-case, 2–4 words, max 30 chars. Use the screen name to disambiguate; never reuse an ID.
3. **Variablise — apply automatically, but only once step 1's guardrail is green.** Rewriting copy to `{{placeholders}}` makes the item text stop matching the Figma text, so any later re-link or repair pass can no longer match those items and they have to be hand-mapped by node ID. Never variablise over a partially-linked section.
   - `list_variablisation_candidates(projectId)`, keep this run's items (post-rename IDs), and apply `{{variable}}` replacements directly via **`link_variables(projectId, updates)`** — no approval step. **Use `link_variables`, not `update_text`.** `update_text` writes `{{name}}` as literal characters and creates nothing, so the item *looks* variablised with no variable behind it; `link_variables` writes the real rich-text variable node, creates any missing workspace variables, and gives each new one an example value recovered from the copy it replaced. It preserves Figma linkage (verified: 21 items, 49/49 instances kept).
   - **Name variables for what they mean, never generically.** One `{{amount}}` covering outstanding balance, remaining principal, remaining interest and a transaction amount is a real failure, not a shortcut — a developer reading the project cannot tell them apart, and it manufactures false duplicates that break step 3b. Prefer `{{outstanding_amount}}`, `{{remaining_principal}}`, `{{late_payment_fee}}`. Reuse an existing workspace variable only when it genuinely fits — and check the workspace list before inventing: `date_range`, `loan_id`, `merchant_name` and `Dateandtime` already existed with exactly the right example values in a run where the detector missed all four.
   - **`list_variablisation_candidates` returns four signals plus an `unjudged` list — read the `unjudged` list.** `flagged` is a recall aid, never a verdict: `pattern` is regex over the text, `labelledValue` means the item sits beside a Figma field label (`Order no.`, `Loan ID`) so it is a field *value* whatever its shape, and `matchesVariableExample` means the text equals an existing variable's example. Everything a regex cannot judge — merchant and personal names, word-form counts (`20K users`), placeholder junk (`XX AED`), standalone currency codes — appears **only** in `unjudged`. Treating `flagged` as complete is this tool's known failure mode.
   - **Act on `fieldLabelsWithNoValue`.** A label with no value beside it means the value layer never became a Ditto item, so it *cannot* be variablised — it is absent, not unflagged. Bare-number values used to be dropped by the link-pass placeholder filter (fixed 27 Aug 2026); if you see this on an older project, re-run `figma_link_pass` to pull them in, then variablise. Report any that remain rather than calling the screen done.
   - **Read the item list yourself as well — the detector is regex-based and finds only what it has a pattern for.** It catches amounts, card last-4, reference IDs, dial codes, dates, percentages and emails, but it cannot judge *semantics*: hardcoded personal names (`Transfer to <a recipient's real name>` → `Transfer to {{recipient_name}}`), sample counts written as words (`20K users`), placeholder junk (`XX AED`), and currency codes in their own layer (`AED`, `PHP`) all need your eye. Scan every item's text, not just the tool's candidate list. Semantically specific names; reuse an existing workspace variable only when it genuinely fits; for a text that is entirely a sample value, replace the whole text with the placeholder. Note in the final report which variables the workspace still lacks (they must be created/linked in the Ditto web app — the API can't link them).
3b. **Collapse duplicates — one string should be one item.** Variablisation regularly turns several distinct items into copies of the same string: four merchant names all become `{{merchant_name}}`, seven timestamps all become `{{Dateandtime}}`. Left alone the project carries `txn-merchant-1`, `-2`, `-3`, `-4` — four dev IDs for one string, which is not what a developer wants to consume. One string = one item with several Figma instances.
   - Run `merge_duplicate_items(projectId)` (dry run, changes nothing) and read the plan. It groups base items by identical text, picks the keeper with the most instances, and proposes the suffix-free dev ID (`txn-merchant-1` → `txn-merchant`).
   - **Judge each group before applying — identical text is not proof of identical meaning.** If step 3's variables were named generically, distinct concepts collapse into one group and merging them destroys the distinction permanently. Merge only groups that are genuinely the same string repeated in the UI. Pass an explicit `groups` array to apply some and not others.
   - Then `merge_duplicate_items(projectId, apply: true, groups: [...])`. Deletion is irreversible, so scope it explicitly rather than letting auto-detection decide on a live project.
   - Do this **before** translating — merging after means paying to translate the same string several times and then deleting most of it.

4. **Translate — for every variant resolved above (explicit, mentioned, or the configured default).** Delegate to `/ditto-translate`'s subagent pattern: **spawn one translation subagent per requested variant, in parallel (single message)**, each following the /ditto-translate Procedure for that variantId. Each returns only a compact summary `{variantId, wrote, skipped}` — do NOT translate inline in the handoff context (that's what keeps this orchestrator lean). In this variant translations write directly at FINAL. If no subagent capability, translate inline, one variant at a time. (Keeping the untranslated lists + glossaries inside the subagents is the token-efficiency win — the handoff context never loads them.)
5. **Set everything to FINAL.** Move base items and each written variant to FINAL, using the status-list form:
   - Base: `update_status(projectId, status: "FINAL", fromStatus: ["NONE","WIP","REVIEW"])`.
   - Each variant: `update_status(projectId, status: "FINAL", variantId, fromStatus: ["NONE","WIP","REVIEW"])`.
   - **Prefer `fromStatus` over an explicit `ids` list here.** `fromStatus` derives its targets from variant rows that actually exist; an `ids` list can name items with no translation, and promoting those would mint empty copy at FINAL. The tool now refuses that and reports the skipped IDs — treat any such report as "these still need translating", not as a failure.
5b. **Check the source copy — report, never fix.** Run `propose_copy_fixes(projectId)`. It finds typos,
   abbreviations written two ways, acronym casing that disagrees, stray whitespace, and trailing
   punctuation that fights its siblings — the class of defect nobody catches reading one screen at a time.
   - **Put the findings in the final report as "fix in Figma, then re-run" — not as "fixed for you".**
     These are copy decisions and some will be deliberate. You are handing the designer a list.
   - **Do NOT call `update_text` to fix them.** Editing base text in Ditto **deletes that item's existing
     translations**. After step 4 every item has variants, so a "quick typo fix" here silently throws away
     every language for that string. `update_text` now refuses when the target has variants and names what
     would be lost; that refusal is correct — do not pass `dropVariants` to get around it.
   - Findings marked `alreadyTranslated` are the expensive ones: fixing them in Figma and re-running means
     re-translating those items, because the English they were translated from has changed.
   - Real case: a run shipped "Interes" and "Processing fee (inclu. vat)". The Arabic translator quietly
     corrected the first, so the base and the variant then disagreed about what the string even was.

6. **Audit before reporting — don't trust the step reports.**
   - **On a re-run of a frame that has changed, call `reconcile_with_figma(projectId, [figmaUrl])` (dry
     run).** It matches on Figma NODE IDs, never on text, so variablised items and edited copy are not
     mistaken for dead — a text-based check would flag every `{{placeholder}}` item as an orphan. It
     reports orphans (every instance gone), partially stale items (prune, never delete) and items with
     no linkage at all (never auto-delete — absence of linkage is not evidence the copy is dead).
     Pass EVERY frame the project draws from: an item whose frame you did not scan looks orphaned. Each step returns its own summary; those summaries are what let silent failures through. Re-read the project and confirm: every item's Figma instances persisted, no dev ID still looks auto-generated, no item still holds a hardcoded dynamic value, and no variant has empty text at FINAL. Fix anything that turns up, then report.
7. **Report once, at the end:** connected / created / renamed / variablised / translated / set-to-FINAL counts, ambiguous or skipped items, and any variables that need creating in the web app. Because the batch is already FINAL, call out anything you were unsure about so the user can spot-check it directly in Ditto.

## Rules

- **On a live project, scope every write to this pass's own items.** Two rules in this skill are safe only in a sandbox. Step 2's rename covers connect-to-existing items — on production that overwrites dev IDs developers may already reference. Step 5's preferred `fromStatus` sweep promotes *everything* currently at NONE/WIP/REVIEW, including pre-existing items that have nothing to do with this handoff (on one real run that would have shipped 9 unrelated items to FINAL). For any project that isn't a playground: snapshot first, leave pre-existing dev IDs alone unless asked, and promote with an explicit `ids` list. Ask which project is which if you can't tell.
- **Components: linked automatically, never edited.** `figma_link_pass` links matching texts to their library component — that *applies* the design system and changes nothing about the component. But a linked item is then component-governed, and every write tool will refuse it: base text, variables, translations, status, dev-ID rename, merging. **Expect the rest of the handoff to skip those items, and report the skips as correct behaviour, not failures.** This holds whatever the translation's state — including when it is *missing*: do not fill in a component's absent translation, because that copy would land in every project using it. Refusals arrive as `componentLinkedSkipped`. If a component genuinely needs new or corrected copy, name it in your final report for the design-system owner to change in the Ditto web app. Reading components (`list_components`, `search_text`) is encouraged — that is how you avoid duplicating copy that already exists.
- **A configured default variant is an instruction, not a hint.** Translate into it without being asked and without confirming the language. The only reasons to skip are an explicit "don't translate" or `defaultVariantExists: false`.
- **A hardcoded number is not safe just because it looks like fixed policy.** Rates, tenors and
  thresholds change, and they change mid-design: on one run a designer edited "Total interest (12%)" to
  "(2.5%)" and "fixed at 6 months" to "3 months" while the handoff was in progress. The variablised
  items absorbed it silently; the eligibility thresholds left as literals in an earlier section
  (2 months / 3 months / 6 months / 35 days) would have shipped stale. Treat a number a user could see
  change as a variable candidate, whatever the surrounding copy implies about its permanence.
- **Autonomous by default — don't stop for approvals.** Stop only for real blockers (auth, ambiguous project). If the user explicitly says they want to review as you go, switch to presenting each step for approval instead.
- **Never export a review sheet as part of this flow.** `export_review_csv` / `export_review_sheet` are
  for when a human translator is going to check the work, which is a different job with a different
  skill (`/ditto-review`). Running it here produces a file nobody asked for and implies a review step
  this flow does not have. Export one **only** if the user asks for it in so many words — "give me a
  sheet for the translator", "I want to review the Arabic" — and then say that you have, and where.
- **This flow sets FINAL directly — there is no review gate.** Since FINAL is where copy ships, be conservative: skip the ambiguous and flag it in the report rather than committing a guess. Use the review-process variant of this skill when a human must sign off first.
- Renames and variablisation are reversible (rename again; re-edit text).
- The link-pass is idempotent-ish (re-running connects rather than duplicates) — don't silently re-run it to "fix" things.
- **Order is load-bearing:** link → *verify* → rename → variablise → translate → FINAL. Variablising before verifying breaks re-matching; variablising after translating leaves the variants holding stale literals (if that happens, mirror the placeholders into each variant, and re-translate anything whose surrounding words changed).
- **Editing base text in the Ditto web app silently drops that item's variants.** If the user has been editing alongside you, re-check for missing/empty variants before reporting.
