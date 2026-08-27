# ditto-workflows-mcp

An MCP server for [Ditto](https://dittowords.com) — drive copy workflows from Claude: find and write glossary-aware translations (Claude translates — no DeepL), review them with a human translator, build a workspace translation memory, hand a Figma frame off into Ditto end-to-end, variablise hardcoded values *and genuinely link them to workspace variables*, and manage workflow statuses.

Works with any Ditto workspace — auth is your own workspace API key. A few extra tools (Figma link-pass, dev-ID rename, variable linking) use your browser session for operations the public API doesn't expose.

## Tools

| Tool | What it does |
|---|---|
| `list_projects` | Projects in the workspace (id + name) |
| `get_settings()` | Read this install's config — `defaultVariant` (and whether it came from the config file or `DITTO_DEFAULT_VARIANT`), the workspace's real variants with `defaultVariantExists`, excluded projects, data paths and session-token expiry. Call it at the start of a handoff or translation flow: **a configured default variant means translate automatically**, with no language named in the prompt and no need to ask the user to create the variant |
| `set_default_variant(variantId)` | Set the default variant once (e.g. `ar`, `fr`); saved to `~/.ditto-workflows-mcp/config.json` |
| `set_excluded_projects(projectIds[])` | Test/sandbox projects to skip when building the translation memory (never seed real translations from them) |
| `list_untranslated(projectId, variantId?)` | Base items missing the variant |
| `write_translations(translations[], variantId?, status='WIP')` | Write variants back (creates if missing) |
| `list_for_review(projectId, variantId?, statuses=['WIP','REVIEW'])` | Pending translations joined with their base text — drive an approve/edit/skip review loop; edits go back via `write_translations` at FINAL, approvals via `update_status` |
| `export_review_sheet(projectId, variantId?, statuses=['REVIEW'])` | Write a Markdown review sheet (base · current · verdict · suggested · notes) for a human translator to edit — returned inline too, so it works as a file or in chat |
| `apply_review_sheet(projectId, variantId?, path?)` | Parse the translator's edited sheet back into Ditto: edits written at FINAL, approvals promoted to FINAL, flagged/blank left in REVIEW |
| `update_status(projectId, status, ids?/fromStatus?, variantId?)` | Set status on base items or a variant; unknown IDs skipped |
| `update_text(projectId, updates[], status?)` | Rewrite base item text (copy edits, `{{variable}}` replacements); unknown IDs skipped |
| `list_variablisation_candidates(projectId, includeUnjudged?)` | Items holding hardcoded dynamic values, via four signals: `pattern` (regex — dates, amounts, %, card last-4, emails, and reference/ID codes including alphanumeric ones like `ICL2602230000001234` / `ORD-2026-0012`), `labelledValue` (the item sits beside a Figma field label such as `Order no.`, so it is a field *value* whatever its shape — the only way a bare `4521` is knowable), `matchesVariableExample` (text equals an existing variable's example), plus an `unjudged` list of everything else. **The flagged list is a recall aid, not a verdict** — semantic cases (merchant/personal names, `20K users`, `XX AED`, bare currency codes) appear only in `unjudged`. Also reports `fieldLabelsWithNoValue`: labels whose value layer never became an item, so it can't be variablised at all. Apply with `link_variables` |
| `list_components(folderId?)` | The workspace's component library (shared strings) — check before writing new copy |
| `search_text(query, projectId?, limit=50)` | Substring search over base items + components — find existing copy to reuse, or locate where a string lives |
| `refresh_translation_assets(variantId?)` | Build the translation memory from FINAL (expert-approved) translations workspace-wide — one clean table of source→translation to reuse before translating; sources with conflicting FINAL translations are held out into a separate `translation-conflicts.md` (with dev IDs + projects) to resolve. Skips configured test/sandbox projects and `[XX-TODO]` placeholders |
| `lookup_translation_memory(sources[], variantId?, nearLimit=3, minScore=0.45)` | Look up a batch of source strings in the memory and get back only the rows that matter: `exact` (reuse verbatim), `near` (scored candidates to mirror), `conflict` (approved copy exists but the workspace disagrees — don't reuse blindly), or `none`. Matching ignores case, punctuation and trailing spaces and treats `{{placeholders}}` and literal amounts as interchangeable, so `Includes ď50.00 interest` finds `Includes {{interest_amount}} interest`. Use this instead of reading `translation-memory.md` — that file is a *display* rendering whose `<br>` wrapping and column padding make grep-based lookup silently wrong. Index is cached in-process for ~10 min |

### Unofficial backend tools (session login)

Some operations the public API can't do are covered by replaying the Ditto web app's *internal* API. Those endpoints are unversioned upstream and may break without notice — they live in a separate module so the official tools above are never affected. Auth is your browser session, not the API key:

| Tool | What it does |
|---|---|
| `login_to_ditto()` | Opens a browser window on app.dittowords.com — sign in like normal and the session token is captured automatically (no devtools). Login is remembered locally; the token lasts ~3 days and refreshes are hands-free. First ever run installs a small automation helper (~40 MB, one-time) and uses your own Chrome/Edge |
| `set_session_token(token)` | Manual alternative: paste the `Authorization` header from devtools (or set `DITTO_JWT` in the env). Validated immediately; expiry reported |
| `rename_developer_id(projectId, renames[])` | Rename developer IDs (`{from, to}` pairs) — not possible via the public API. Skips unknown/colliding IDs with reasons and verifies results via the public API afterwards |
| `figma_link_pass(projectId, figmaUrl)` | Wire a Figma frame's copy into a project: existing texts get connected, new ones created as WIP, matches to library components linked. Needs a "Copy link to selection" URL and `FIGMA_API_KEY` (personal access token, file-content read scope) |
| `merge_duplicate_items(projectId, apply?, groups?)` | Collapse base items holding the SAME text into one item carrying all their Figma instances, then delete the leftovers — the cleanup variablisation creates (four merchant names become four items, then all become `{{merchant_name}}` with dev IDs `-1..-4`). Defaults to `apply: false`, reporting the plan and changing nothing. **Judge every group: identical text is not identical meaning** — generically-named variables make distinct concepts look mergeable. Deletion is irreversible, and because a Figma node cannot move while its old item owns it, the duplicates are always deleted *before* their instances land on the keeper; unverified groups echo `recoverInstances` |
| `link_variables(projectId, updates[], createMissing?)` | Rewrite items to `{{variable}}` placeholders **and actually link them** — the thing `update_text` can't do. Missing variables are created first (public API) unless `createMissing: false`. Reports `unresolvedPlaceholders` (no such variable) and `malformedPlaceholders` (names with hyphens/dots, which Ditto can't accept) instead of silently leaving literal text, and verifies each item's `variableIds` via the public API afterwards |

Wherever `variantId` is omitted, the default variant applies (config file, or `DITTO_DEFAULT_VARIANT` in `.env`).

**Resource:** `ditto://glossary/{variantId}` — locked terminology + voice rules Claude applies when translating. Backed by `translation-assets/{variantId}-glossary.md` + `{variantId}-voice-rules.md`, or a `translation-assets/{variantId}/` folder of markdown files (gitignored — team-specific, never committed). Bootstrap yours from your own workspace: run `refresh_translation_assets`, then have Claude distill the pairs into glossary + voice-rule files. The translation-memory file itself is deliberately *not* served by the resource — it can be hundreds of KB.

## Skills

Three Claude Code skills ship in `plugin/skills/`, encoding the standard playbooks so a whole workflow is one command instead of a paragraph:

| Skill | What it does |
|---|---|
| `/ditto-handoff [figmaUrl] [projectId] [variantId]` | Full Figma→Ditto handoff, autonomous end-to-end: paste a frame link → copy linked into the project and *verified* as non-floating → semantic developer IDs applied across new **and** pre-existing items → hardcoded values variablised → glossary-aware translation into a variant if one is mentioned ("…and add Arabic") → the whole batch set to FINAL → project re-audited rather than trusting the step reports. There is no review gate in this flow, so it skips anything ambiguous and flags it in the report instead of guessing |
| `/ditto-translate [projectId] [variantId]` | Full translation loop: refresh assets → read the glossary → translate in batches with self-review → write back at FINAL → report written + every skipped item with its reason |
| `/ditto-review [projectId] [variantId]` | Reviewer loop, interactively in chat or as a Markdown sheet handed to a human translator: a flag-only guardrail pass against the Ditto style guide and local glossary/voice rules → approve/edit/skip → edits and approvals become FINAL → translation memory refreshed, and recurring reviewer corrections pushed back to the style guide as durable rules |

They load automatically with the plugin install below. With a standalone MCP install, copy the folders from `plugin/skills/` into `~/.claude/skills/` to have them everywhere.

## Components are read-only, by design

Library components are the design system's shared strings. They belong to one
person — the design-system designer / content writer — and are changed only by
them, in the Ditto web app. **This server has no component write path at all.**

- It cannot create, rename, re-text, re-link, delete or translate a component.
  There is no such function in `ditto-backend.js`, deliberately, and a
  regression test in `npm test` fails if one reappears.
- It refuses to write to any project item **governed by** a component — base
  text, variablisation, translations, status changes, dev-ID renames, merging.
  Such items come back as `componentLinkedSkipped` with the reason. Ask the
  component's owner to make the change once, on the component.
- Work lists (`list_untranslated`, `list_for_review`,
  `list_variablisation_candidates`) leave those items out, so they are never
  proposed in the first place.
- **Reads stay open and are encouraged:** `list_components` and `search_text`
  cover the library, because knowing a component exists is how you avoid
  duplicating copy that already ships.
- `figma_link_pass` reports `componentMatches` read-only — where a screen's copy
  duplicates a component — and links nothing. Until 0.21.0 it silently
  `PATCH`ed `/library-component/{id}/link` on every run, editing the design
  system as a side effect of a handoff.

Detection uses the backend's item→component link (`ws_comp`), which needs a
session token. **The public API does not expose component linkage at all**, so
without a token the guard falls back to an exact text match against the
component library — approximate, over-blocking, and reported as unverified
rather than presented as fact.

## Setup

**Prerequisites:** Node.js 18+, a Ditto workspace API key (Ditto → workspace settings → API).

### Claude Code plugin (recommended — tools + all three skills)

```
/plugin marketplace add gojenaya/ditto-workflows-mcp
/plugin install ditto-workflows@ditto-workflows-mcp
```

Then add your keys — `/plugin` → **Ditto Workflows** → **Configure**:

| Field | |
|---|---|
| **Ditto API key** | required — Ditto → workspace settings → API |
| **Default variant** | optional — e.g. `ar`; or call `set_default_variant` once instead |
| **Figma API key** | only needed for `figma_link_pass` — figma.com → Settings → Security → personal access token, *File content: read* scope |

Run `/reload-plugins`, then check that `/mcp` lists **ditto-workflows** as connected. The server runs via `npx`, so it stays up to date.

> **If the server reports `missing DITTO_API_KEY`,** the Configure screen saved a blank config — it doesn't reliably persist what you type, even when it says "Configuration saved". Add the entry to `~/.claude/settings.json` yourself:
>
> ```json
> "pluginConfigs": {
>   "ditto-workflows@ditto-workflows-mcp": {
>     "ditto_api_key": "<your key>",
>     "ditto_default_variant": "ar",
>     "figma_api_key": "<your figma token>"
>   }
> }
> ```
>
> Then `/reload-plugins` again. Keys live in your own user settings — never in a repo.

### npx (MCP server only, no clone)

**Claude Code:**

```bash
claude mcp add ditto-workflows -s user \
  -e DITTO_API_KEY=<your key> \
  -e DITTO_DEFAULT_VARIANT=<variant> \
  -e FIGMA_API_KEY=<your figma token> \
  -- npx -y ditto-workflows-mcp@latest
```

Only `DITTO_API_KEY` is required. `DITTO_DEFAULT_VARIANT` is optional (or call `set_default_variant` once instead), and `FIGMA_API_KEY` is only needed for `figma_link_pass` — a Figma personal access token with *File content: read* scope, from figma.com → Settings → Security.

**Other MCP clients** (Claude Desktop, Cursor, Windsurf, …) — add to the client's MCP config:

```json
{
  "mcpServers": {
    "ditto-workflows": {
      "command": "npx",
      "args": ["-y", "ditto-workflows-mcp@latest"],
      "env": {
        "DITTO_API_KEY": "<your key>",
        "DITTO_DEFAULT_VARIANT": "<variant>",
        "FIGMA_API_KEY": "<your figma token>"
      }
    }
  }
}
```

### From a clone (development)

```bash
git clone https://github.com/gojenaya/ditto-workflows-mcp && cd ditto-workflows-mcp
npm install
echo 'DITTO_API_KEY=<your key>' > .env         # loaded by the server itself
echo 'DITTO_DEFAULT_VARIANT=<variant>' >> .env # optional
echo 'FIGMA_API_KEY=<your figma token>' >> .env # optional — only for figma_link_pass
claude mcp add ditto-workflows -s user -- node "$PWD/mcp-server.js"
```

`npm test` runs a live smoke test (local-only, not committed; needs the API key).

### Where state lives

| What | Where |
|---|---|
| Default-variant config | `~/.ditto-workflows-mcp/config.json` |
| Glossary + translation-memory files | `~/.ditto-workflows-mcp/translation-assets/` — or a `translation-assets/` dir next to the server in clone installs, which takes precedence |
| Override the whole data dir | `DITTO_DATA_DIR` env (assets dir alone: `DITTO_ASSETS_DIR`) |

### First run

Restart your client, run `/mcp` — `ditto-workflows` should show connected. Then just ask:

> "List untranslated strings in *project*, translate them using the glossary, and write them back as WIP."

## Notes

- Every GET carries a cache-buster: Ditto's CDN caches responses by exact URL and ignores `no-cache` headers, serving stale data after writes.
- **Variable linking needs the rich-text path, not a field.** A linked variable is a *node inside* the item's `rich_text` — `{"type":"variable","attrs":{name,text,variableId,variableType}}` — and the public API's `variableIds` is *derived* from those nodes. So `PATCH /v2/textItems` ignores both `variableIds` and `variables` (verified 24 Aug 2026, both field names). `update_text` therefore writes placeholders as literal text; use **`link_variables`**, which builds the node via the backend and verifies the result. Variable *creation* does work on the public API, and `link_variables` does it for you — any placeholder with no matching workspace variable is created first (unless `createMissing: false`), with its example value recovered from the copy it replaced. There is no standalone create/delete-variable tool; `deleteVariables()` exists in `ditto-api.js` if you need the reverse.
- The unofficial backend tools (`login_to_ditto`, `figma_link_pass`, `rename_developer_id`, `link_variables`) replay Ditto's internal web-app API — unversioned and subject to change. They live in a separate module (`ditto-backend.js`) so a breakage there never affects the public-API tools.
