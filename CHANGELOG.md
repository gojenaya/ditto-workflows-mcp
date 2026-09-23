# Changelog

All notable changes to ditto-workflows-mcp are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.32.0] - 2026-09-23

### Fixed
- Plural detection fired on **amount and date placeholders whose names happen to
  contain a countable noun** — `{{installment_amount}}` contains "installment",
  `{{total_repayment_amount}}` contains "repayment", `{{buy_order_total}}`
  contains "order". All are money, none is a count. The not-a-count guard
  applied only to the positional rule; it now applies to the name-based rule too.
- A string that is **only** a placeholder (`{{month_year}}`) has no word to
  inflect and can never need plural forms, whatever the placeholder is called.
- Together these cut the English plural backlog from 77 items to 43 real ones.

## [0.31.0] - 2026-09-23

Plural forms. Every tool filtered `pluralForm === null`, so plurals could be
neither read nor written — and two live items shipped to Arabic FINAL with a
single form, which is wrong for five of Arabic's six categories.

### Added
- **CLDR categories per locale** (`plurals.js`). Arabic has six, Slavic four,
  English two, Indonesian one. **Ditto does not validate these**: writing a
  `few` form onto English returns 200 and creates a form no runtime will ever
  select, so the check has to live here. Wrong categories are refused; a partial
  set (Arabic without `zero`) is written and the gap reported.
- **Write**: `write_translations` and `update_text` accept
  `plurals: {category: text}`. `text` and `plurals` are mutually exclusive —
  Ditto derives the display text from the first form.
- **Read**: `list_untranslated` reports `pluralCategoriesForLocale`,
  `needsPluralForms` for new work and `incompletePluralForms` for items already
  translated but short of the locale's categories. `search_text` surfaces plural
  rows instead of hiding them. `export_review_csv` gains a `plural_form` column
  and a row per form, each compared against its own source form;
  `apply_review_csv` writes them back by upserting that form.
- **Detection**: a string is a plural candidate when a count-bearing placeholder
  sits next to a countable noun. The positional rule matters more than the name
  — `Confirm {{tenor}} payments` reads as a duration but substitutes 3 or 6, and
  already had plural forms in SNPL. Placeholders that are emphatically not counts
  (`card_last4`, `amount`, `date`) are excluded.
- `/ditto-translate` now has the mechanism to go with `ar-voice-rules.md` §5,
  which has prescribed plural forms from the start while the skill offered no way
  to write them — so the agent fell back to one form and said so in its notes.

### Fixed
- Backfilled the live case: `split-plan-option` and `installments-count-title`
  in salary-loan now carry one/two/few/many/other in Arabic —
  `one` singular, `two` dual, `few` (3-10) plural, `many` (11-99) singular
  accusative, `other` singular, per `ar-voice-rules.md` §5.

### Notes
- Plural rows come back from the API with a suffixed developer ID
  (`split-plan-option_few`), not as a field on the item — which is why an
  exact-ID lookup appears to show nothing after a successful write.
- `test/plurals-test.mjs`, 18 checks.

## [0.30.0] - 2026-09-23

Source-copy defects. A live run shipped an item reading "Interes" and another
reading "Processing fee (inclu. vat)" — a mistyped "incl." and a lowercase
"vat". The Arabic translator quietly corrected the first, so the base and the
variant then disagreed about what the string even was.

### Added
- `propose_copy_fixes` — scans base English for typos, abbreviations written two
  ways, acronym casing that disagrees, stray whitespace, and trailing
  punctuation that fights its siblings. **Reports only; never applies.**
  Findings on already-translated items are marked, because those are the
  expensive ones to fix.
- The checks are **workspace-relative, not dictionary-driven**: a word appearing
  once while a near-identical word appears fifty times is a typo, and that
  signal does not mistake "botim", "SNPL" or "Aani" for errors. The first pass
  over the real workspace returned 1,319 findings, nearly all noise; suppressing
  rarer real words, inflections, proper nouns, sentence-final full stops and
  apostrophe styles brought it to ~310, with the genuine defects surfacing
  ("successfull", "microhone", "benficiary", "verifcation", "adress", "lssue").
- `test/copy-check-test.mjs` — 16 checks. The first three are the defects that
  shipped; the rest are false positives the first pass produced.
- `/ditto-handoff` step 5b runs the check and reports it as "fix in Figma, then
  re-run", explicitly not as "fixed for you".

### Fixed
- **`update_text` no longer silently deletes translations.** Changing base text
  drops every variant of that item — irreversibly, with no warning. It now
  refuses when a target has variants, names which languages would be lost, and
  requires `dropVariants: true` to proceed.
- Both new variant lookups asked for `{projects:[…]}` alone, which returns BASE
  rows only, so the guard would never have fired and every finding would have
  looked untranslated. Variants must be requested by name.

## [0.29.0] - 2026-09-23

Three defects in the screen filter, all found on a live Salary Loan run
(LGHGeKlrPzcSCJETp9C4PS), all of which passed the `floating === 0` guardrail
while still shipping wrong copy.

### Fixed
- **The screen was mis-identified whenever it was an INSTANCE.** `walk` recorded
  the screen only on `FRAME`, so on a file whose screens are instances of a
  template it descended past the 393x852 screen and treated the first nested
  frame as the screen. A "Learn more" label inside a 77px auto-layout button was
  rejected as "frame is 77px wide" while the rest of that same screen imported
  fine. The screen is now the outermost container below the selection root,
  whatever its type.
- **Cropped detail frames passed the width test.** "installment 2-6" is a
  353x520 FRAME — phone-width, but an excerpt rather than a screen. Bounds now
  include `minHeight` (600 by default, overridable via `screenBounds`). The
  rejection says outright that a legitimate bottom sheet would land here too, so
  it is judged rather than trusted.
- **A COMPONENT_SET bypassed every check and duplicated its copy.** A set is N
  variants of ONE component, so importing it yields duplicates by construction —
  "Repayment Plans" contributed 31 redundant strings. Only the default variant
  (Figma's first child) is imported now; `includeComponentSets: true` restores
  the old behaviour for the rare file that keeps distinct copy per variant. A
  standalone COMPONENT is still exempt from size checks, since that is where
  Figma legitimately stores component copy.

### Changed
- `/ditto-handoff` now has two guardrails after the link pass, not one.
  Guardrail A is to **read and judge `skippedOffScreenItems`** — both of these
  defects were visible in that list and went unnoticed because the skill only
  asked for `floating === 0`.

### Added
- `test/screen-filter-test.mjs` — 13 checks, one per defect plus the behaviour
  each fix must not break, with the real node IDs in the comments.

## [0.28.0] - 2026-09-23

Only product copy reaches Ditto now.

A design file holds far more text than the product does. On one SNPL page, 1,100
text nodes included 261 on presentation slides, a designer's paragraph about an
upcoming layout change, flow labels like "Back intercept" and "Exit MP", and
stickers reading "TO-BE" and "For ditto integration only" — 275 strings that no
engineer will ever reference, all of which used to become Ditto items.

### Added
- `figma_link_pass` imports only text on a **product screen**. The signal is
  structural rather than textual: product copy lives inside a device-sized frame
  (280-600px wide). Anything loose on the canvas, or inside a 1920x1080 slide or
  a 78px flow label, is documentation.
- **Component definitions are exempt.** Copy inside a COMPONENT or COMPONENT_SET
  is kept even though it sits outside any frame — that is simply where Figma
  stores it. Without this exemption the filter dropped real copy: "Available to
  send" and "Repay your dues to unlock sending" live in a Balance card component
  set, outside every phone frame.
- Everything skipped is **reported** under `skippedOffScreenItems` with the
  reason and frame, never silently dropped — a real screen wrongly excluded has
  to be visible to be fixable. `includeOffScreen: true` imports everything.

### Notes
- Verified on the three naya2 test sections: 21, 6 and 133 strings, none skipped.
  On the SNPL documentation page: 1,100 in, 825 kept, 275 correctly excluded.

## [0.27.0] - 2026-09-22

Skill guidance, no code change.

### Changed
- **`/ditto-handoff` never exports a review sheet.** It has no review stage — it
  writes FINAL — so producing a sheet implies a gate that isn't there and leaves
  a file nobody asked for. Reviews belong to `/ditto-review`. The handoff exports
  one only on an explicit request.
- **Parallelism is now spelled out in `/ditto-handoff`.** The pipeline has a hard
  spine (link → rename → variablise → translate → FINAL) whose writes are
  strictly ordered — variablisation needs post-rename IDs, and merging duplicates
  before translating is what avoids paying to translate one string five times.
  What parallelises is the *deciding*: naming per screen, naming alongside
  variablisation detection, one translation subagent per variant, and the audit's
  four independent checks. Subagents return compact summaries and the
  orchestrator does the writing, so parallel writers never race on dev-ID
  uniqueness.
- `/ditto-handoff` step 2 now starts from `propose_developer_ids` and records
  decisions with `remember_developer_ids`.
- `/ditto-review` prefers the CSV round-trip over the Markdown one, with the
  reasons why (spreadsheet-native, and it validates placeholders and staleness on
  the way back in), and points the feedback loop at
  `propose_rules_from_reviews`.

## [0.26.0] - 2026-09-22

Fixes found by running the whole pipeline — link pass, naming, variablisation,
translation, review, rule proposal — end to end on a real 21-string Figma
section before publishing.

### Fixed
- `propose_rules_from_reviews` only clustered corrections that shared the same
  source string, so three different CTAs corrected for the same stated reason
  produced no proposal at all. Rationale is now the primary grouping — "masdar
  avoids assuming gender" applied across three strings is a rule about CTAs, not
  about those three strings, and it is the more actionable of the two signals.
- Developer-ID proposals named a string after a container that merely *holds* a
  control: "Consent button group" wraps consent text and a button both, so the
  legal text was being proposed as `consentgroup-cta`. Collective nouns (group,
  wrapper, area, list, row, section) no longer match a role.
- Figma component paths were used whole, producing truncated nonsense —
  `top-navigation-large-content-n` from "Top navigation / Large content". Only
  the family before the slash names a role, and IDs are now trimmed at a word
  boundary rather than mid-word.
- A role suffix no longer counts as copy-derived: `submit-request-cta` was being
  rejected for containing its own copy, when the suffix is exactly what makes it
  purposeful rather than a slug.
- Component-family names (top-navigation, sheet, card, section-header, list-item)
  joined the generic list — `top-navigation-nav-title` is redundant and says
  nothing a screen name would not.

## [0.25.0] - 2026-09-22

Developer IDs stop being the copy slugged. Ditto names a new item from its text,
which is where `enter-your-botim-pay-password-`, `abc-1` and `13` come from, and
a rename pass afterwards only fixes them when someone remembers to run it.

The extractor was throwing away everything needed to do better: a text node's
layer name, its ancestor containers, the component it belongs to, its size and
weight. A string sitting in `repayment-card__summary` at 24px bold is a card
title — the copy alone never says that.

### Added
- `propose_developer_ids` — resolves what structure can answer (component
  library, unambiguous UI role) and hands back the rest as a **digest**: one line
  per string with size, weight and container, in reading order. About 1,700
  tokens for a 97-string frame, against roughly ten times that for a screenshot
  per frame. Deduped by copy first, so a string repeated across twelve screens is
  one decision.
- `remember_developer_ids` — records the chosen ID per Figma node, so a second
  link pass returns the same names instead of churning them under engineers who
  already reference them.

### Changed
- `rename_developer_id` validates its targets: kebab-case, under 30 characters,
  not generic (`title-2`), and not the copy slugged again — including Ditto's
  own slug-plus-counter pattern (`abc-1` from "ABC", `home-2` from "Home"),
  which otherwise reads as a deliberate name. `allowAnyId` overrides.

### Notes
- Figma layer names are offered but never trusted. They are frequently
  copy-paste debris: in SNPL an interest note sits on a layer called "Sync
  Contacts" (which appears 12 times on one page) and a figure on one called
  "Info". A purely structural naming pass would emit `sync-contacts-note`, which
  is worse than the status quo because it looks deliberate.
- Containers named for a button's visual variant are rejected too — every screen
  has a primary button, so `primary-cta` would both collide and mean nothing.

## [0.24.0] - 2026-09-22

Translator review moves to CSV. The Markdown sheets were readable in chat but not
in the tool translators actually use — a reviewer working in Excel or Sheets had
to hand-edit `\|` and `<br>` escapes in a text editor, and mostly didn't.

The bigger change is that the round-trip now validates. A sheet that comes back
with a dropped, renamed or duplicated `{{placeholder}}` is rejected instead of
written, and a row whose English changed while the sheet was out for review is
rejected as stale rather than attached to copy that no longer exists. Neither
check existed before; the old sheet simply asked reviewers to be careful.

### Added
- `export_review_csv` — scope to a Figma page (`figmaUrl`/`figmaPageId`), a
  block, or the whole project. A page-sized sheet is 20-40 rows; the SNPL
  Markdown export was 468, which nobody reviews. Omitting `variantId` writes one
  file per variant, since different languages go to different reviewers and
  mixing RTL with LTR in one sheet is unreadable. Carries screen context and a
  fixed `reason_category` vocabulary.
- `apply_review_csv` — validates placeholders and staleness before writing,
  links placeholders as real variables on write, joins on `dev_id` so reviewers
  may sort/filter/delete freely, and supports `dryRun`.
- `propose_rules_from_reviews` — counts which corrections REPEAT and routes each
  to the glossary, a voice-rules section, or back to content design. Proposes
  only: one reviewer's preference must not silently become a workspace rule.

### Notes
- CSV handling covers the failure modes that are silent rather than loud: a
  UTF-8 BOM (without it Excel renders Arabic, Hindi and Urdu as mojibake), a
  formula guard on cells starting `=`/`+`/`-`/`@`, and delimiter sniffing for the
  European locales where Excel writes semicolons.
- Page scoping reads the Figma linkage through the unofficial backend, so it
  needs a session token and fails with that message rather than silently
  reporting zero rows.

## [0.23.0] - 2026-09-22

Placeholders in a translated variant were never actually linked — they were
literal `{{name}}` characters. Ditto could not track them, could not warn when a
translation dropped or mistyped one, and never rendered the example value. The
variant looked correct and carried an untracked string, which is the same silent
failure `update_text` used to cause on base items.

The fix turned out to be simpler than the workaround it replaces. The public API
accepts `variables` as an array of variable **names**, and builds the rich-text
variable node from them. An earlier note in this repo claimed this was impossible
and forced a write through the web app's internal API; that test passed
`variableIds`, and `variables` as objects — both are ignored. Names as plain
strings work, on variants and on base items alike.

### Added
- `write_translations` links every `{{placeholder}}` it writes, so a variant
  tracks its variables exactly like the base item does. Names are checked against
  the workspace first — an unknown name is rejected by the API with a 400 that
  would otherwise fail the whole batch — and anything unlinkable is reported as
  `unlinkedPlaceholders`, which almost always means the base item was never
  variablised.

### Changed
- `link_variables` now uses the public API and **no longer needs a session
  token**. The backend rich-text write and its `login_to_ditto` dependency are
  gone from this path.

### Fixed
- `updateTextItemsRich` throws if handed a `variantId`. That backend endpoint
  silently ignores the field and writes the **base** item instead: sending Arabic
  with `variantId: "ar"` overwrote the English source, returned 200, and reported
  success. Observed on a live item before the guard existed.
- `link_variables` reported `precise: true` on its component guard even when the
  guard had fallen back to the public-API approximation.

## [0.22.0] - 2026-08-27

Corrects 0.21.0, which drew the line in the wrong place. Auto-linking to
components is wanted — it is how the design system gets applied. What must never
happen is editing a component's content.

### Changed

- **Auto-linking to library components is restored.** `figma_link_pass` links matching texts to their component again. Linking points the item *at* the component and leaves the component's copy, translations and statuses untouched, so it applies the design system rather than changing it. 0.21.0 removed this along with the genuinely unsafe behaviour; the removal meant a screen's "Confirm" would sit unlinked beside the component that already owned that string, accumulating duplicate copy.
- **`linkComponent()` is back as the *only* permitted component write** (`PATCH /library-component/{id}/link`), documented as such in `ditto-backend.js`. The regression test no longer forbids all component writes — it now asserts that the only one present is `/link`, and fails on any other (create, rename, re-text, delete, or writing translations).
- **`figma_link_pass` reports a `componentText` field when the item's wording differed from the component's.** Matching is on normalised text, so an item reading `confirm` links to a `Confirm` component and then defers to its exact wording. That is the design system applying, but it is now visible rather than silent.

### Kept from 0.21.0 — every content guard

Linking makes an item component-governed, and that protection is unchanged: `update_text`, `link_variables`, `write_translations`, `update_status`, `rename_developer_id`, `merge_duplicate_items` and `apply_review_sheet` all refuse such items and report `componentLinkedSkipped`. `list_untranslated`, `list_for_review` and `list_variablisation_candidates` still exclude them so they are never offered as work.

**This holds when a translation is FINAL and equally when it is MISSING.** Verified against production: `split-pay` in `help-center` is component-linked with no Arabic translation — `list_untranslated` does not offer it, and a direct `write_translations` call returns `wrote: 0` with the reason. An absent translation is the component owner's to fill; filling it here would push unreviewed copy into every project using that component.

### Notes

- **Linking is a one-way door into protection**, by design: a handoff will now link some items and then deliberately skip them for renaming, variablisation, translation and status changes. Those skips are correct behaviour, and all three skills say so explicitly, so a future run does not read them as failures to work around.
- Reads remain fully open (`list_components`, `search_text`) — knowing a component exists is how you avoid duplicating it.

## [0.21.0] - 2026-08-27

Library components are the design system's shared strings, owned by one person
and edited only by them. This server was modifying them automatically. It no
longer has any way to.

### Fixed

- **`figma_link_pass` silently modified the design system on every run.** Step 6 called `PATCH /library-component/{id}/link` to link matching texts to their library components — so any handoff, run by anyone, edited components as a side effect, with no review and no mention in the report. The step is now **read-only**: it reports `componentMatches` (which of this screen's texts duplicate a component, and whether they are already linked) and links nothing. Deciding to link is the component owner's call, made in the web app.
- **`linkComponent()` is deleted from `ditto-backend.js`, and there is now no component write path in the module at all.** A comment marks the removal so it is not re-added as a "missing feature", and a regression test fails if any `library-component` write endpoint or a `linkComponent` definition/call reappears.
- **Writes to component-*governed* items are refused.** A project item linked to a component carries the component's copy, so editing it either propagates to the design system or detaches the item — both are design-system changes made by the wrong hand. `write_translations`, `update_text`, `update_status`, `link_variables`, `rename_developer_id`, `merge_duplicate_items` and `apply_review_sheet` now withhold those items and report them under `componentLinkedSkipped` with the reason and what to do instead. Verified against production: `update_status` on the component-linked `confirm-cta` writes nothing and explains why.
- **Component-governed items are no longer offered as work.** `list_untranslated`, `list_for_review` and `list_variablisation_candidates` exclude them, because presenting them as pending is what leads to writing them. On `profile` that removes 8 items from the variablisation candidate list.

### Notes

- **The public API does not expose component linkage at all** (verified 27 Aug 2026: a component-linked item returns no component field of any kind). Accurate detection therefore uses the backend dump's `ws_comp` and needs a session token. Without one the guard falls back to an exact text match against the component library — approximate and over-blocking, so it is labelled unverified in the response rather than presented as fact. Run `login_to_ditto` for an exact check.
- **`write_translations` takes no `projectId`**, so its guard is workspace-wide: if any item anywhere carries that developer ID and is component-linked, the ID is withheld. Over-blocking is the correct failure direction when the alternative is editing the design system by accident.
- Reads are unchanged and encouraged — `list_components` and `search_text` still cover the library, since knowing a component exists is how you avoid duplicating copy that already ships.
- **What a write to a component-governed item actually does — propagate, detach, or error — is untested.** Finding out would mean modifying a real component, which is precisely what this release forbids, so the guard is preventive rather than characterised.

## [0.20.0] - 2026-08-27

A configured default variant was silently ignored, so nothing was ever
translated unless the user named a language in the prompt — defeating the point
of the setting.

### Fixed

- **`/ditto-handoff` ignored the configured default variant entirely.** Its Arguments section said "if none is mentioned, skip translation silently" and step 4 was gated on "only if a variant was given", where *given* meant an explicit argument or a language in the prompt. A user who had set `set_default_variant` (or `DITTO_DEFAULT_VARIANT`) got a handoff that ran every other step and quietly skipped translation. Variant resolution is now explicit and ordered: `variantId` argument → language named in the prompt → **configured default**, and translation only skips when all three are empty or the user says not to.
- **The default variant was unreadable, so no skill could act on it.** `getDefaultVariant()` was internal — used only by `requireVariant()` as a per-call fallback — and no tool returned it. The model had no way to discover that a default existed, which is *why* the skill's logic could never account for one. Fixing the skill without exposing the value would have changed nothing.
- **Users were being asked to confirm or "create" a variant that already existed.** Nothing exposed the workspace's variant list, so there was no way to check. `get_settings` now returns `workspaceVariants` with a `defaultVariantExists` flag, and both skills say: if it's listed, translate into it — don't ask.

### Added

- **`get_settings()`** — the configuration read-back that was missing: `defaultVariant` plus `defaultVariantSource` (config file vs env, so it's clear which value is in play), the workspace's variants from `GET /v2/variants` with `defaultVariantExists`, `excludedProjects`, `configPath`/`dataDir`, and session-token expiry. It also carries a `guidance` string stating the expected behaviour, so the setting explains itself at the point of use rather than only in a skill file.
- `readConfigDefaultVariant()` in `config.js`, so `get_settings` can report *where* the default is configured rather than just its value.

### Changed

- **`/ditto-translate` now resolves the variant up front via `get_settings` when none is named.** The individual tools already fell back server-side, but the parallel-subagent pattern needs a concrete variant ID per agent, so relying on that fallback meant it could not spawn anything. It also no longer asks which language when a default is set.
- `/ditto-handoff`'s description and summary line now state that the configured default is translated automatically, and a new rule records that a configured default is an instruction, not a hint.

## [0.19.0] - 2026-08-27

Bare numeric values — order numbers, reference IDs, account numbers — were never
reaching Ditto at all. Found while investigating why an "Order no." row wouldn't
variablise.

### Fixed

- **The link-pass placeholder filter discarded every pure-digit text, so bare numeric values never became items.** `isPlaceholder()` returned true for `/^\d+$/`, intended to skip mock junk like a stray `4`. It also threw away order numbers, reference IDs, account numbers and OTP codes — exactly the strings that most need a variable. They were invisible to the *whole* handoff, not just variablisation: no item, no Figma linkage, no translation, and no detector could ever flag them because they did not exist. Confirmed on real data: an `Order no.` row whose Figma value `648476283017361` sat right beside the label had no Ditto item at all. Now only runs of ≤2 digits are treated as junk (`MAX_PLACEHOLDER_DIGITS`); `9:41` status-bar times and the named placeholder set are unaffected. **Re-run `figma_link_pass` on existing projects to pull in the values it previously dropped.**
- **Alphanumeric ID codes were structurally undetectable.** Every dynamic pattern was digit-anchored, and `\b\d{7,}\b` cannot fire mid-token because there is no word boundary between `L` and `2` — so `ICL2602230000001234`, `ORD-2026-0012` and `TRK88291` all passed as static copy. Added an alphanumeric-code pattern requiring a 3+ digit run or a separator, which keeps ordinary words-with-numbers (`iPhone15`) out.
- **The field-keyword pattern demanded 5+ digits glued to the keyword**, so `Order #1234`, `Order no. 4521` and `Booking ref: XY9K2M` all missed. It now accepts any digit-bearing value after a much wider keyword list (order, ref, txn, invoice, receipt, tracking, ticket, booking, policy, case, loan, account, iban, voucher, promo, coupon), and `#\s*\d{4,}` replaces the 6-digit form.
- **The keyword pattern flagged ordinary copy as reference IDs.** Under `/i`, `[A-Z0-9]` also matches lowercase, so `Loan details` and `Transaction history` were reported as dynamic. The value branch now requires a digit.

### Added

- **`labelledValue` signal — detects a field value from its Figma neighbour, not its own text.** A bare `4521` is unknowable in isolation; what makes it dynamic is the `Order no.` label beside it. `list_variablisation_candidates` now pairs field labels with their nearest value layer using the geometry the link-pass already stores (`integrations.figmaV2.instances[].position`), handling both label-left/value-right and label-above/value-below. Needs a session token; degrades with an explicit `proximityNote` rather than failing.
- **`fieldLabelsWithNoValue` — reports labels whose value layer never became an item.** This is what identifies the bug above from inside the tool: the value cannot be variablised because it is absent, not because it went unflagged. Would have diagnosed the `Order no.` case immediately.
- **`matchesVariableExample` signal** — flags items whose text equals an existing workspace variable's example (`Carrefour` → `merchant_name`, `ICL2602230000001234` → `loan_id`). All six semantic misses in the 24 Aug production run had an exact-match variable already in the workspace.
- **An `unjudged` list, returned by default.** The tool used to hand back only its own hits, which read as a complete answer and is why semantic cases kept slipping through. It now returns every item no signal fired on, and says in the output that reading it is required — regex cannot judge merchant names, word-form counts (`20K users`), placeholder junk (`XX AED`) or standalone currency codes. Pass `includeUnjudged: false` on very large projects.
- **`test/variablise-detection-test.mjs`** — a regression suite over the detector, the label logic, the label-column false positive and the placeholder filter, wired into `npm test` ahead of the smoke test. It caught two of the bugs above during development.

### Changed

- **BREAKING (tool output):** `list_variablisation_candidates` returns `flagged` (each item carrying a `signals` array) and `counts` instead of `candidates` and `count`. Anything reading the old field names needs updating; the bundled skills already are.

## [0.18.0] - 2026-08-26

### Added

- **`link_variables` — variablise text AND actually link the variables.** A linked variable is a node inside the item's `rich_text`; the public API's `variableIds` is derived from it, which is why `PATCH /v2/textItems` silently ignores any `variableIds`/`variables` you send. This writes the rich-text node through the web app's internal API (session token) and creates missing variables via the public API first. Verified on a production project: 21/21 items linked, 49/49 Figma instances preserved — `update_text` still writes literal `{{name}}` text only.
- **New variables get a REAL example value.** They used to be created with their own name as the example, so the workspace filled up with variables whose example read `outstanding_amount` — useless to anyone reading the project. `deriveVariableExamples()` recovers what each placeholder actually replaced by matching the item's old text against the new (`- ď425.00` + `- {{transaction_amount}}` → example `ď425.00`), including multi-placeholder strings (`You saved {{amount}} on {{count}} trips`). Pass `examples` to override; when the texts can't be lined up (copy reworded in the same edit) the name is still used and the affected variables are reported under `variablesMissingExample` instead of failing silently. Existing variables are never modified.
- **`merge_duplicate_items` — one string, one item, one dev ID.** `figma_link_pass` dedupes by exact text, so four different merchant names become four items; rewrite them all to `{{merchant_name}}` and you have four copies of one string with numbered dev IDs (`txn-merchant-1..4`) that no developer wants. This collapses them into one item carrying all the Figma instances, strips the trailing `-N` from the keeper's dev ID, and deletes the leftovers. Defaults to `apply: false` — it reports the plan and changes nothing. Verified on `naya2`: four `txn-merchant-*` items became one `txn-merchant` holding all 5 instances, with the variable link and FINAL status intact. **The delete-then-move ordering is forced, not preferred:** a Figma node cannot be re-attached while its old item still owns it, so the duplicates are always deleted first and there is a window where the items are gone and their instances are not yet on the keeper. Any group that fails to verify echoes its instance payloads under `recoverInstances`, which is the only route back.
- **`deleteTextItems(projectId, developerIds)` in `ditto-api.js`** — `DELETE /v2/textItems`. The body field is `developerIds`; a plain `ids` array is rejected with a zod error naming the right field.

### Fixed

- **The README documented a `create_variables` tool that does not exist.** Nothing registered it — `createVariables()` lives in `ditto-api.js` and is called by `link_variables`, which creates any missing variable itself. The row is gone and the Notes section now says how creation actually happens. `list_variablisation_candidates`' row also still pointed at `update_text` for applying replacements, which writes literal text; it points at `link_variables` now.
- **The server reported version `0.17.0` while the package was `0.17.1`** — the docs-only 0.17.1 release didn't update the string in `mcp-server.js`. Now correct, and worth checking on every bump.

### Notes

- **`merge_duplicate_items` must not be run blind, and that is why it defaults to a dry run.** Identical text is not proof of identical meaning. Generic variable naming manufactures false duplicates: a project where outstanding balance, remaining principal, remaining interest and late payment fee were all flattened to `{{amount}}` presents four semantically distinct items as one mergeable group, and merging them destroys the distinction permanently. Specific variable names are a *prerequisite* for safe merging, not an independent nicety.
- **Known defect, not yet fixed: the `figma_link_pass` guardrail false-positives on connect-to-existing.** `counts.instancesPersisted === counts.instancesConnected` compares project totals, but `persisted` counts *all* instances on an item while `instances` counts only what the pass sent. One item with 13 pre-existing instances makes the totals 63 vs 50, so a skill-obedient run halts on any mature project. The per-item check (`persisted >= instances`) is already correct internally — only the reported totals mislead.
- **Known gap: no block write path.** Created items always land ungrouped (`blockName: null`). The public API returns `blockName` on read and the backend dump exposes `blockId` on each item, so a write path looks reachable — it would give a handoff run a deletable container, which is the main thing missing when testing on a live project.

## [0.17.1] - 2026-08-17

Documentation only — no server or skill behaviour changed.

### Fixed

- **The README's Skills table described the opposite of what the skills do.** It listed two skills instead of three, pointed at `.claude/skills/` (they moved to `plugin/skills/` in 0.10b), and claimed `/ditto-handoff` staged the batch at REVIEW with "nothing goes FINAL automatically" and that `/ditto-translate` wrote back as WIP. Both write FINAL directly — there is no review gate in this variant. `/ditto-review`'s entry also now mentions the style-guide guardrail, the Markdown review-sheet mode and the feedback loop added in 0.15.0–0.16.0.
- **Setup told users the plugin install would prompt for their API key.** It doesn't reliably: the install completes silently, and the `/plugin` → Configure screen can report "Configuration saved" while writing an empty `pluginConfigs` entry — leaving the server dead with `missing DITTO_API_KEY` and no obvious cause. The plugin section now covers install and key entry as separate steps and documents the manual `~/.claude/settings.json` fallback. (Both manifests pass `claude plugin validate`, so the `userConfig` declaration is not at fault.)
- **`FIGMA_API_KEY` was undocumented outside a tool-table cell.** None of the Setup routes mentioned it, so anyone not using the plugin had nowhere to put it and `figma_link_pass` simply failed. Added to the `claude mcp add`, MCP-client JSON and clone `.env` snippets, with the required *File content: read* scope.

### Changed

- Plugin and marketplace descriptions now list `/ditto-handoff` — the main entry point, previously missing from both — and drop the "prompts for your Ditto API key on install" claim.

## [0.17.0] - 2026-08-17

### Fixed

- **`figma_link_pass` was silently linking a fraction of a section.** On a four-frame selection it reported `floating: 0` and 56 instances connected while Ditto had persisted **12 instances across 7 items**, all on a single frame. Two compounding causes, both fixed:
  - **The connect went out as one PATCH.** The unofficial `connect` endpoint returns `200` with `{"figmaTextNodesToUpdate":[]}` while persisting only part of a large payload. Re-sending the *identical* payload in batches of 5 persisted 100% across all four frames. The connect is now always chunked (`CONNECT_BATCH_SIZE = 5`) on both the initial pass and every retry. The endpoint is also not purely additive — a later small call was observed dropping instances from items it never mentioned — so the verify step re-reads the whole set, not just what it sent.
  - **The guardrail was blind to three quarters of the work.** `counts.floating` was computed over `createdReport` alone, so it meant "no *newly created* item is floating" while the connect-to-existing items — 35 of 47 in the failing run — went unchecked. It now covers created *and* connected items, and counts **partial** persistence (fewer instances than sent), not just zero. Each entry reports `persisted`/`expected`, retries run up to `CONNECT_RETRIES = 3` rounds, and a new `counts.instancesPersisted` gives a direct check against `instancesConnected`.
- **`update_status` could mint empty copy at FINAL.** Promoting a variant that doesn't exist yet *creates* it — with empty text. Passing an explicit `ids` list alongside a `variantId` therefore wrote blank approved copy for any item the translator had skipped (observed: six empty `ar`/`hi` values at FINAL). The tool now looks up which variant rows actually hold text, promotes only those, and names the rest in its response instead of silently creating them. The `fromStatus` path was already safe, since it derives its targets from real variant rows.
- **`list_variablisation_candidates` missed most hardcoded values.** It found 3 of 14 on a real screen set. Added patterns for bare formatted amounts (`10,000.00`, `15.1899` — common when the currency sits in its own text layer), `#`-prefixed and long-digit reference IDs (`#000002798236526`), `ref/txn/order/invoice` numbers, parenthesised card last-4 (`Debit card (4563)`, `(8122)`), and country dial codes (`+63`). Verified against the missed strings with no false positives on real copy (`Send`, `Apple Pay`, `9:41`, `Recent beneficiaries`).

### Changed

- **`/ditto-handoff` step 2 now renames across both result lists.** It previously renamed only `created` items, so connect-to-existing items kept whatever IDs earlier passes gave them — `1000000`, `000002798236526`, `annie`, `okay-3`, `home-2` survived run after run and were never cleaned. Expect to rename more existing items than created ones.
- **`/ditto-handoff` step 3 gained an ordering constraint and a manual-scan instruction.** Variablising rewrites item text, which breaks text-based re-matching, so it must not run over a partially-linked section. The step also now says to read the item list directly rather than trusting the detector alone — regex cannot judge semantics, so hardcoded personal names (`Transfer to <a recipient's real name>`), word-form counts (`20K users`), placeholder junk (`XX AED`) and standalone currency codes still need a human eye.
- **`/ditto-handoff` gained an audit step (new step 6)** — re-read the project and confirm instances persisted, dev IDs look semantic, no hardcoded values remain, and no variant is empty at FINAL, *before* reporting. Every step returns its own summary, and trusting those summaries is exactly what let these failures through.
- **`/ditto-handoff` step 1** now checks `counts.floating === 0` **and** `counts.instancesPersisted === counts.instancesConnected`; step 5 prefers `fromStatus` over an explicit `ids` list when promoting variants. Two new rules document that the pipeline order is load-bearing (link → *verify* → rename → variablise → translate → FINAL) and that editing base text in the Ditto web app silently drops that item's variants.

## [0.16.0] - 2026-08-17

### Added

- **`lookup_translation_memory(sources[], variantId?)`** — the reuse step of the translation loop as a tool instead of a file read. Takes a batch of source strings, returns only the rows that matter: `exact` (reuse verbatim), `near` (scored, ranked candidates to mirror), `conflict`, or `none`. Matching is case-, punctuation- and trailing-space-insensitive, and collapses `{{placeholders}}` and literal amounts to a common token, so `Includes ď50.00 interest` finds `Includes {{interest_amount}} interest`. Near-match scoring blends unigram and bigram Dice over counted token bags — the bigram half restores enough word order that `Includes {{amount}} interest` outranks `Includes interest {{amount}}` instead of tying at 1.0.
- **Conflicting sources are now reachable.** A source whose FINAL translations disagree across the workspace is deliberately held out of `translation-memory.md`, which meant a translator reading that file saw *nothing* and translated from scratch — silently forking terminology a third way. `lookup_translation_memory` returns these as `match: "conflict"` with every rival translation and its dev IDs. (Live example: `Continue` in `ar` has four, including the `يكمل` third-person form that `ar-voice-rules.md` §3 flags as P0.)

### Changed

- **`/ditto-translate` step 4 now calls the tool instead of reading `translation-memory.md`,** and both the procedure and the Rules say why: the file is a *display* rendering — long cells hard-wrapped on `<br>`, every column space-padded — so grep-based lookup silently misses short entries. Verified: a padded-column grep found none of `Send`, `Pay`, `Add`, `Home`, `Calls`, `Chats`, `To do`, `View all`; the tool returns all eight as exact matches. For `ar` this also replaces reading a 375 KB file with a response carrying only the batch's rows.
- **Memory-index construction extracted into one shared builder** (`buildMemoryIndex`) used by both `refresh_translation_assets` and `lookup_translation_memory`, so the two can't drift on what counts as memory versus conflict. The index is cached in-process for ~10 min (≈3.5 s cold, ≈5 ms warm) since a translation run looks up several batches back to back; `refresh_translation_assets` always rebuilds and reseeds it, and `refresh: true` forces it.

### Fixed

- **`figma_link_pass` no longer leaves copy floating.** Two independent bugs. (1) A single-node Figma fetch never includes the `CANVAS` ancestor, so the tree walk couldn't learn the real page and stamped every node with a hardcoded `"0:1"` — wrong for any frame not on the first page, and Ditto's `connect` validates frame-on-page (strictly on mature projects, laxly on playgrounds), so instances were silently rejected. `resolvePageId` now resolves the true page once per selection (`GET /v1/files/{key}?ids={node}&depth=2` → the single CANVAS returned with children) and stamps it on every node. (2) The unofficial `connect` endpoint can return 200 while persisting nothing, so the tool no longer trusts the status code: it re-reads each item, confirms `integrations.figmaV2.instances` actually landed, retries the connect once for anything still empty, and reports whatever remains as `counts.floating` plus a `floating` list. Ditto groups by `figmaV2.instances`, not `blockId`.
- **`/ditto-handoff` gained a floating guardrail.** Step 1 now requires `counts.floating === 0` before continuing, with the diagnosis path and workaround inline — shipping unlinked copy straight to FINAL is worse than pausing.
- Version strings were out of sync across `package.json` (0.15.0), `mcp-server.js`, `plugin/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` (all 0.14.0). All four now read 0.16.0.

## [0.15.0] - 2026-07-23

### Added

- **Style-guide rule tools (unofficial backend).** `list_style_guides`, `list_style_guide_rules`, and `add_style_guide_rules` wrap Ditto's internal style-guide routes — the public API can read style guides but has no write path for rules. `add_style_guide_rules` creates rules with `examples:[{from,to}]` (wrong→right pairs), a section, and tags. Endpoints reverse-engineered from the web app and verified live (create → confirm → delete leaves no trace). Needs a session token, like the other backend tools.
- **`/ditto-review` correction→rule feedback loop.** After review, generalizable reviewer corrections (do-not-translate brand terms, common mistranslations, voice rules) are distilled into the local glossary/voice-rules and, with the reviewer's explicit OK, pushed to the Ditto style guide via `add_style_guide_rules`.

### Changed

- **No review stage by default — copy lands at FINAL directly.** `/ditto-translate` writes translations at `FINAL` (instead of `WIP`) and `/ditto-handoff` sets the whole batch to `FINAL` (instead of staging at `REVIEW`). `/ditto-review` is no longer a required gate — it's now an optional QA/learning pass. Both skills instruct extra caution: skip and flag anything ambiguous rather than committing a guess as approved copy, since nothing sits in review before shipping. (A `with-review-process` branch preserves the previous WIP → REVIEW → FINAL flow for teams that want the gate.)
- **`/ditto-review` gained a flag-only guardrail pass.** Before review, it checks each item against the Ditto style guide (`get_styleguide_rules` via the official Ditto MCP when connected), the local glossary/voice-rules, and the nova-copy references — flagging only objective, nameable violations (never rewrites, never nitpicks intentional copy).

## [0.14.0] - 2026-07-17

### Changed

- **Token-efficient parallel translation.** `/ditto-translate` and `/ditto-handoff` now delegate each variant's translation to its own subagent, run concurrently, each returning only a compact summary (`{variantId, wrote, skipped}`). The bulky data — the untranslated list, the ~25k-char glossary, the memory table — stays inside the subagent's context (discarded when it returns) instead of accumulating in the orchestrator. Independent variants never conflict; a single variant is never split across agents (keeps repeated-string terminology consistent). Falls back to inline translation where no subagent/Task capability exists.

## [0.13.1] - 2026-07-15

### Fixed

- Variablise detection now recognises the botim dirham glyph `ď` (and `đ`) in amounts (e.g. `ď3,000`, `Total outstanding: ď200.00`) — restored from the original ditto-script patterns, dropped during the port.

## [0.13.0] - 2026-07-15

### Changed

- `/ditto-handoff` now runs autonomously end to end by default — it applies dev-ID renames, variablisation, and translations without pausing for per-step approval, then stages the whole batch at REVIEW. Safe because nothing is promoted to FINAL; the human review happens afterwards (`/ditto-review` or a review sheet). It stops only for genuine blockers (auth, ambiguous project), or if the user explicitly asks to review as they go.

## [0.12.6] - 2026-07-15

### Changed

- apply_review_sheet now honours any changed Suggested cell as an edit regardless of the A/N verdict letter — so a translator who edits the translation but leaves the verdict at A does not silently lose the edit.

## [0.12.5] - 2026-07-15

### Changed

- Review sheet restructured: narrower columns (cap 40) so rows fit one line and only long sentences overflow; **Verdict moved to the last column as A/N** (A = approve/keep, N = not approved → put the fix in Suggested; blank = defer). apply_review_sheet parses A/N accordingly.

## [0.12.4] - 2026-07-15

### Changed

- Table columns are padded to align in the raw file (short cells line up under their header); long sentences remain the exception — they wrap (wrap columns) or overrun (others). Applies to memory, conflicts, and review sheets alike. Review-sheet round-trip stays exact because apply_review_sheet trims cells.

## [0.12.3] - 2026-07-15

### Changed

- One shared Markdown table style across every generated file (memory, conflicts, review sheets) so output is identical regardless of which tool/client produced it. Long cells wrap with <br> (fixed-width columns in a viewer; short entries stay one line) instead of char-padding, which could not align proportional Arabic/emoji.
- Conflicts file: one row per distinct translation with dev@project refs collapsed (was one row per ref — the {{_}} case went from ~90 rows to a handful).

## [0.12.2] - 2026-07-15

### Changed

- Translation-memory / conflict tables now cap column width (~48 chars): short entries stay compact and aligned on one line; only genuinely long sentences overrun and wrap.

## [0.12.1] - 2026-07-15

### Changed

- `refresh_translation_assets` now skips untranslated placeholders even at FINAL status — a translation like `[AR-TODO] …` / `[EN-TODO] …` (Ditto's not-yet-translated marker) or an empty string never enters the memory or the conflicts.
- Table columns are fully padded (every column, including the last) so borders align in the raw Markdown file.

## [0.12.0] - 2026-07-15

### Added

- `set_excluded_projects(projectIds)` — configure test/sandbox projects (e.g. QA playgrounds) to skip entirely when building the translation memory. Stored in the gitignored local config (never hardcoded — the repo is public). `refresh_translation_assets` also takes an `excludeProjects` override.

### Changed

- `refresh_translation_assets` reworked per real-use feedback:
  - **Excludes** the configured test/sandbox projects from both memory and conflicts.
  - The memory now contains only sources with a **single agreed** FINAL translation; a source with divergent FINAL translations is **held out** of the memory until resolved.
  - **Conflicts moved to their own file** (`translation-conflicts.md`), separate from the memory, with each translation's dev IDs + project IDs.
  - Cleaner **RTL-safe table**: dropped the noisy `uses` column and put the translation in the last column (so right-to-left text no longer visually reorders trailing cells); the Source column is padded so raw rows line up.

## [0.11.0] - 2026-07-14

### Changed

- **Translation memory reworked to be a reusable reference.** `refresh_translation_assets` now groups FINAL translations by source text: identical source→translation pairs are collapsed (with an occurrence count), and any source with more than one FINAL translation is flagged as a **conflict** listing each variant's **dev IDs + project IDs** to confirm and re-align. Output is a clean Markdown **table** (Memory + Conflicts sections) instead of a bullet list; the tool's response is capped/summarised so it stays small even with hundreds of conflicts.
- `/ditto-translate` (and the handoff's translation step) now **reference the memory first**: exact source matches reuse the approved translation verbatim, similar sources mirror its wording, and only genuinely-new copy is translated from scratch. Verified live: with the current workspace memory, a translation pass would reuse 98 Arabic / 34 Hindi existing translations across sample projects instead of re-inventing them.

## [0.10.0] - 2026-07-14

### Added

- **Translator review sheet** — a Markdown round-trip so a human translator (native speaker) can review a variant's translations outside chat:
  - `export_review_sheet(projectId, variantId?, statuses=['REVIEW'])` writes a Markdown sheet (dev id · base · current · Verdict · editable Suggested · Notes) and returns it inline too (works as a file *or* in chat). Pipes/newlines are escaped so the table survives arbitrary copy.
  - `apply_review_sheet(projectId, variantId?, path?)` parses the edited sheet back: edited rows written at FINAL, `approve` rows promoted to FINAL, blank/`skip` left in REVIEW. Returns a tally.
  - `/ditto-review` skill gained a "Mode A — translator review sheet" path alongside the interactive in-chat mode.
- Works in Claude Desktop (and any MCP client), which is why the export/apply is server-side rather than relying on the client's filesystem.

## [0.9.0] - 2026-07-14

### Changed

- `update_status`: `fromStatus` now accepts a **list** of statuses and works for **variants** (with `variantId`), not just base items. This makes "stage everything for review without touching FINAL" a single call — `fromStatus: ["NONE","WIP","REVIEW"] → REVIEW` — since FINAL is simply excluded from the list.
- `/ditto-handoff` final step changed from *offering* FINAL promotion to **automatically staging** the batch at REVIEW: all touched base items and written variants move to REVIEW, and any already-FINAL item is left untouched (never downgraded). Verified live: an `ar` variant with a pre-existing FINAL item kept it FINAL while 41 others moved to REVIEW.

## [0.8.1] - 2026-07-14

### Fixed

- `figma_link_pass` and `rename_developer_id` now resolve a project's internal ID via a direct backend project-list lookup (`GET /ditto-project`), so they work on **empty projects** — the old dev-ID-overlap join needed at least one existing item, which broke the first link-pass into a fresh project.
- Variablise detection now catches **trailing-currency amounts** ("8.00 AED"), not just currency-first ("AED 8.00"); added PKR/PHP to the currency set.

## [0.8.0] - 2026-07-13

### Added

- `figma_link_pass(projectId, figmaUrl)` — port of the ditto-handoff pipeline's link-pass, now headless: pulls the text nodes under a Figma frame ("Copy link to selection" URL required; whole-file blocked), connects texts that match existing items, creates new ones as WIP, and links matches to library components. Returns created items with auto-generated developer IDs and screen names for the rename step. Needs `FIGMA_API_KEY` (unofficial backend + Figma REST).
- `/ditto-handoff` skill — the full flow from a pasted Figma link: link-pass → semantic developer-ID suggestions (screen-aware, reviewed by the user) → `rename_developer_id` → glossary-aware translation into a variant when one is mentioned ("…and add Arabic"; translations land as WIP for `/ditto-review`) → optional promotion of the touched base items to FINAL.
- Plugin: optional `figma_api_key` install prompt wired to `FIGMA_API_KEY`.

## [0.7.0] - 2026-07-13

### Added

- **Unofficial backend tools** (session JWT, separate `ditto-backend.js` module — public-API tools never depend on it):
  - `login_to_ditto` — designer-friendly auth: opens a real browser window on app.dittowords.com, the user signs in like normal, and the session token is captured automatically (no devtools). First run self-installs a browser-automation helper into the data dir (~40 MB, one-time) and drives the user's own Chrome/Edge — no browser download. The login persists in a local profile, and the token (~72 h lifetime) is cached with 0600 perms, so later refreshes are hands-free.
  - `set_session_token` — paste a browser-session JWT manually (validated immediately, expiry reported); also honours a `DITTO_JWT` env var.
  - `rename_developer_id` — rename text-item developer IDs, which the public API cannot do. Locates the project's internal ID by joining the backend workspace dump against public-API dev IDs, skips unknown/colliding renames with reasons, and verifies results via the public API afterwards.
  - These replay Ditto's internal web-app API: unversioned, may break without notice, and clearly marked UNOFFICIAL in the tool descriptions. Expired tokens produce a "grab a fresh one" message with exact devtools steps instead of a raw 401.
- **Claude Code plugin distribution**: the repo doubles as a plugin marketplace (`.claude-plugin/marketplace.json`), with the plugin itself under `plugin/` (`plugin/.claude-plugin/plugin.json`, `plugin/.mcp.json`, `plugin/skills/`). `/plugin marketplace add gojenaya/ditto-workflows-mcp` then `/plugin install ditto-workflows@ditto-workflows-mcp` installs the MCP server (via npx) *and* both skills in one step, prompting for the Ditto API key through the plugin's `userConfig`. Closes the gap where npx users didn't get the skills. (Not shipped to npm — plugin files are git-only.)

## [0.6.0] - 2026-07-07

### Added

- **npx distribution**: install with `claude mcp add ... -- npx -y ditto-workflows-mcp@latest` — no clone, no paths. API key and default variant are passed as env vars at add-time.
- MIT license, changelog, npm `files` whitelist.

### Changed

- Per-user state (config, auto-generated translation assets) moved to `~/.ditto-workflows-mcp/` (override with `DITTO_DATA_DIR`; glossary dir alone with `DITTO_ASSETS_DIR`) — the package dir is a throwaway cache under npx. Clone installs with an existing `translation-assets/` dir next to the server keep working unchanged, and a legacy `.ditto-config.json` next to the script is still read.
- Dropped the `node-fetch` dependency in favour of the global fetch (Node 18+).

## [0.5.0] - 2026-07-07

### Added

- Skills layer, shipped in-repo (`.claude/skills/`): `/ditto-translate` (refresh assets → read glossary → translate in batches with self-review → write back as WIP) and `/ditto-review` (approve/edit/skip pending translations; results become FINAL, translation memory refreshed after).

## [0.4.0] - 2026-07-07

### Added

- `list_variablisation_candidates` — detect hardcoded dynamic values (dates, amounts, percentages, card last-4, emails) in a project's base items, returned with the workspace's variables; Claude suggests the `{{variable}}` replacements.
- `update_text` — rewrite base item text (copy edits, variable replacements); unknown IDs skipped.
- `list_components` — the workspace component library, optionally by folder.
- `search_text` — reuse-oriented substring search over base items and components.

### Known limitations

- `{{name}}` placeholders written via the public API land as literal text — variable linking/creation and dev-ID renames remain Ditto web-app steps.

## [0.3.0] - 2026-07-03

### Added

- Configurable default variant: `set_default_variant` tool + `DITTO_DEFAULT_VARIANT` env (no more hardcoded `'ar'`).
- `refresh_translation_assets` — pull all FINAL base→variant pairs workspace-wide into a local translation-memory file for glossary distillation.
- `list_for_review` — pending variant translations joined with base text, powering the review loop.
- Glossary resource generalised to `ditto://glossary/{variantId}`.

## [0.2.0] - 2026-07-03

### Added

- Initial MCP server: `list_projects`, `list_untranslated`, `write_translations`, `update_status`, and the `ditto://glossary/ar` resource. Claude is the translation engine; the server is deterministic I/O over the Ditto public API (with CDN cache-busting).
