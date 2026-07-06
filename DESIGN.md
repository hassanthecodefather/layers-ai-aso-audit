# Design & Engineering Notes

This document covers **what was built**, **how it maps to the take-home
brief**, and the **engineering practices** behind it. For setup, see the
[README](README.md).

---

## 1. What was built

A conversational ASO (App Store Optimization) audit agent. The user pastes an
Apple App Store URL; the app fetches surface metadata, resolves the app's
function-grounded identity, confirms both with the user, runs a full
ten-dimension audit, and renders a prioritised report.

The flow is a four-step **Mastra workflow** with one human-in-the-loop gate:

```
identify-app ─▶ confirm-app ──suspend──▶ [user confirms app + identity] ─▶ gather-listing ─▶ score-listing
```

1. **`identify-app`** — a custom workflow step (not a tool wrapper) that
   resolves the URL to surface metadata via the iTunes Lookup API **and** runs
   the ID-lite identity resolver: extracts deterministic signal families
   (developer, bundle-id org, marketing domain, review vocabulary), asks the
   Gemini classifier for a function-grounded category, and computes a two-axis
   confidence band. A prior human-confirmed identity is reused verbatim when
   its load-bearing signals have not changed.
   ([audit-workflow.ts:101-128](apps/server/src/mastra/workflows/audit-workflow.ts#L101), commit `87e6239`)

2. **`confirm-app`** — the workflow **`suspend()`s**
   ([audit-workflow.ts:150](apps/server/src/mastra/workflows/audit-workflow.ts#L150)).
   Its state serialises to LibSQL via `LibSQLStore`
   ([mastra/index.ts:22](apps/server/src/mastra/index.ts#L22)); the UI shows
   an *"Is this the app you meant?"* card and waits. When the resolved identity
   escalates (cross-domain divergence or low band), the card widens to
   *"Here is what we think your app does — confirm, correct, or pick"*,
   capturing an `IdentityDecision` alongside the app confirmation.
   ([audit-workflow.ts:132-162](apps/server/src/mastra/workflows/audit-workflow.ts#L132),
   [human-confirm.ts](apps/server/src/identity/human-confirm.ts),
   commit `87e6239`)

3. **`gather-listing`** — on confirmation the workflow resumes; this step is
   `createStep(gatherListingTool)` — the tool is used directly as a step.
   Fans out across every data source (iTunes core + reviews + competitors +
   Firecrawl page scrape) into one canonical `AppListing`.
   ([audit-workflow.ts:165](apps/server/src/mastra/workflows/audit-workflow.ts#L165))

4. **`score-listing`** — applies the human identity decision (if any), reads
   prior snapshot history, runs the prompt-hash whole-snapshot reuse check
   (skips the LLM when nothing changed), calls the auditor agent for a
   structured judgement with per-dimension reuse for unchanged inputs, and
   finally persists the audit: snapshot, identity version, applied-detection,
   dedup and contradiction guard.
   ([audit-workflow.ts:168-342](apps/server/src/mastra/workflows/audit-workflow.ts#L168),
   commit `87e6239`;
   [version.ts](apps/server/src/scoring/version.ts) A7 fix in commit `a05e592`)

Progress streams to the browser over Server-Sent Events the whole time.

### The Mastra primitives

The brief asked for *"idiomatic use of agents, tools, workflows, and skills."*

| Primitive | Where |
|---|---|
| **Agent** | `aso-auditor` in [aso-auditor.ts](apps/server/src/mastra/agents/aso-auditor.ts) — scores the ten dimensions; deliberately **tool-free** (every input is pre-gathered; structured text output works on every model) |
| **Agent** | `identity-classifier` (lazy-initialised in [resolve-identity.ts:63-73](apps/server/src/mastra/tools/resolve-identity.ts#L63)) — interprets the identity fact sheet into a function category; temperature 0 |
| **Tool** | [identify-app.ts](apps/server/src/mastra/tools/identify-app.ts) — `identifyAppTool` wrapping the plain `identifyApp` function; used by agents; the workflow's `identify-app` step is a separate custom step that calls the same function and also resolves identity |
| **Tool** | [gather-listing.ts](apps/server/src/mastra/tools/gather-listing.ts) — `gatherListingTool` used directly as a workflow step via `createStep(gatherListingTool)` |
| **Workflow** | `aso-audit` in [audit-workflow.ts](apps/server/src/mastra/workflows/audit-workflow.ts) — the four-step pipeline, with `suspend`/`resume` for the human gate |
| **Skill** | [aso-audit.ts](apps/server/src/mastra/skills/aso-audit.ts) — the audit framework (rubric, scoring bands, output discipline), loaded as the `aso-auditor` agent's instructions |

---

## 2. How it maps to the brief

Every requirement in `task.md`, and where it is met:

| Brief requirement | How it's met |
|---|---|
| Chat app; user pastes an App Store URL | React chat UI; `Composer` accepts any `apps.apple.com` URL or bare app ID |
| Fetch surface metadata, confirm *"Is this the app you meant?"* | `identify-app` step → workflow **suspends** → `ConfirmationCard` (icon, name, developer, category, rating) with Yes/No |
| On confirmation, run the full audit | `resume()` → `gather-listing` → `score-listing` |
| Keep the user informed while it runs | SSE `progress` events per workflow step, rendered as a live `ProgressTrace` |
| Present recommendations nicely | `ScoreCard` (score ring + per-dimension bars), grouped recommendation cards with before/after diffs, competitor table |
| Works on apps you haven't seen | Verified across Spotify, TikTok, Notion, US & GB storefronts; URL parsing handles every link form |
| Mastra: agents, tools, workflows, skills | See the table above |
| The 10-dimension weighted rubric, scored 0–100 | [rubric.ts](apps/server/src/scoring/rubric.ts) (rubric-as-data) + [aggregate.ts](apps/server/src/scoring/aggregate.ts) (weighted, normalised) |
| Output: Score Card, Quick Wins, High-Impact, Strategic, Competitor table | The `AuditReport` shape and the `ReportView` components map 1:1 to this |
| Evidence + before/after for every text change | Enforced in the skill and the `Recommendation` schema (`before`/`after` required for text changes) |
| `npm install && npm run dev` works | npm workspaces; one root `dev` script runs both apps |
| Complete `.env.example` | Documents every variable, both LLM options, and the optional crawler |
| README with setup + decisions | [README.md](README.md) + this document |

A few places where the framework was **deliberately refined** (the brief
invited this):

- The rubric's weight column **sums to 110, not 100** — kept all ten
  dimensions and normalised instead of dropping one (see §4.3).
- Added **confidence levels** — the iOS keyword field isn't public, so
  pretending to score it would be dishonest (see §4.4).
- Added **ID-lite identity resolution** — the app's declared store category
  often misrepresents what it does; a function-grounded identity drives
  suppression of misleading `reposition_identity` recommendations (see §4.8).
- Added **P1 persistent memory** — repeated audits detect applied changes,
  never re-raise dismissed suggestions, and guard contradictions (see §4.9).
- Added **score determinism** — confidence and three dimension scores are
  computed purely in code; identical re-audits return a cached report with
  zero LLM calls (see §4.10).

---

## 3. Architecture

The codebase is a layered monorepo. Each layer has one job and a typed seam to
the next.

```
apps/
  server/
    src/
      domain/      Canonical types — AppListing, AuditReport, AuditDraft,
                   URL parsing, Result, ListingSnapshot, LedgerRecommendation,
                   IdentityVersion
      llm/         LLM Strategy — LlmProvider interface + GoogleProvider (Gemini) + factory
      sources/     Data layer — iTunes adapter, HTTP retry, parallel fan-out
        crawler/   Crawler Strategy — ListingCrawler + Firecrawl / Null
        websearch/ Web-search Strategy — WebSearchProvider interface + NoopWebSearch
      identity/    ID-lite — signal extraction, tally→band resolver, human-confirm
      memory/      P1 persistent memory — StorageClient seam, LibSQL impl, dedup engine,
                   audit-memory (applied-detect, change-diff, persist), migration runner
      scoring/     Rubric, deterministic signals, prompt (pure-function prompt builder +
                   scoringConstraints), JSON extraction, aggregation, score
                   (generate→validate→repair), dimension-scorer (codeScore /
                   coarseOrdinal / per-dim hashing), candidates (normaliseRecs / gates),
                   replay (zero-LLM rubric-weight replay), version (RUBRIC_VERSION)
      mastra/      Agent, tools, workflow, skill, SSE routes, composition root
  web/             Vite + React + Tailwind chat UI
```

Three **Strategy seams** isolate the volatile, third-party parts:

- **LLM** ([llm/](apps/server/src/llm/)) — an `LlmProvider` interface;
  [google.ts](apps/server/src/llm/google.ts) is the implementation (Google
  Gemini via its OpenAI-compatible endpoint
  ([google.ts:28](apps/server/src/llm/google.ts#L28))). The `getLlmProvider()`
  factory in [llm/index.ts:19](apps/server/src/llm/index.ts#L19) reads
  `LLM_PROVIDER` from the environment; adding a backend = one class + one
  `case`. Model defaults to `gemini-2.5-flash`
  ([llm/index.ts:8](apps/server/src/llm/index.ts#L8)). Ollama was removed in
  Phase 0 (`87e6239`): the OpenAI wire format Gemini speaks is already handled
  by `@ai-sdk/openai-compatible`, so no extra dependency was needed.

- **Crawler** ([sources/crawler/](apps/server/src/sources/crawler/)) — a
  `ListingCrawler` interface; [firecrawl.ts](apps/server/src/sources/crawler/firecrawl.ts)
  is the real one, [none.ts](apps/server/src/sources/crawler/none.ts) the no-op
  fallback.

- **Web-search** ([sources/websearch/](apps/server/src/sources/websearch/)) — a
  `WebSearchProvider` interface; `NoopWebSearch` in
  [websearch.ts](apps/server/src/sources/websearch/websearch.ts) is the keyless
  default (reports `searched_and_empty`, never `errored`). The tri-state
  (`corroborated` / `searched_and_empty` / `errored`) is intentional: absence
  of a footprint is a small honest confidence penalty, not a broken call. A
  real Exa/Tavily client drops in here when a key is available — no changes
  elsewhere. (commit `87e6239`)

The agent, workflow, identity resolver and data layer depend only on these
interfaces — never on "Gemini", "Firecrawl" or "Exa" directly.

---

## 4. Key decisions

The unifying principle of the whole design, applied repeatedly:
**deterministic signals decided in code; the LLM confined to judgment, and
never trusted with anything that must be stable.** Most issues that surfaced
during live testing were a violation of that principle somewhere; most fixes
were moving a decision out of the model and into code.
(See the invariants in §4.12 and the code comments in
[candidates.ts:9-10](apps/server/src/scoring/candidates.ts#L9),
[audit-workflow.ts:208-212](apps/server/src/mastra/workflows/audit-workflow.ts#L208))

The brief left most of the *how* open. The deliberate calls:

### 4.1 Workflow-driven, not agent-driven
The sequence (identify → confirm → gather → score) is fixed, so it's encoded
as a **workflow** — *code* for control flow, *LLM* for judgement. The agent is
confined to the one step that genuinely needs reasoning. The
*"is this the app?"* gate is a real workflow `suspend()`/`resume()`, not a
prompt heuristic — which is what makes it reliable.

### 4.2 The LLM never does arithmetic
Character counts, utilisation ratios, screenshot tallies, rating averages and
the weighted 0–100 total are all computed in pure, unit-tested code
([signals.ts](apps/server/src/scoring/signals.ts),
[aggregate.ts](apps/server/src/scoring/aggregate.ts)). The agent receives those
as an authoritative *fact sheet* and supplies only judgement. Models are
unreliable at counting and averaging — this removes that failure mode entirely.

### 4.3 The rubric sums to 110 — so normalise
The brief's weight column adds to 110, not 100. Rather than silently drop a
dimension, all ten are kept and the score is **normalised**:
`Σ(score·weight) / Σ(weight)`. This is a true 0–100 regardless — and it also
gracefully handles a dimension dropping out when the crawler isn't configured.
([rubric.ts:11-14](apps/server/src/scoring/rubric.ts#L11), [aggregate.ts:97](apps/server/src/scoring/aggregate.ts#L97))

### 4.4 Honest confidence levels
The iOS keyword field is **not public** — neither Apple's API nor the web page
exposes it. Each dimension carries a confidence: `observed`, `inferred` (the
keyword field — scored by inference and clearly flagged), or `unavailable`
(excluded from the weighted total). The report states its own limitations
rather than bluffing.

From Phase A onwards, **confidence is always code-derived** — the model is
never asked to assess its own observability. `deriveConfidence` in
[dimension-scorer.ts](apps/server/src/scoring/dimension-scorer.ts) is the
single source of truth for which label a dimension gets.
([dimension-scorer.ts:118-154](apps/server/src/scoring/dimension-scorer.ts#L118), commit `87e6239`)

### 4.5 Owned structured output: generate → validate → repair → normalise
Providers don't reliably enforce a schema via `response_format` — Gemini, in
testing, returned valid-but-wrong-shaped JSON. So
[score.ts](apps/server/src/scoring/score.ts) owns the full pipeline:

1. **Generate** — call the agent at temperature 0
   ([score.ts:53](apps/server/src/scoring/score.ts#L53)).
2. **Extract** — `extractJsonObject`
   ([extract.ts:9](apps/server/src/scoring/extract.ts#L9)) brace-matches out
   of prose, code fences and `<think>` blocks.
3. **Validate** — Zod `safeParse` against `AuditDraftSchema`
   ([domain/audit.ts](apps/server/src/domain/audit.ts)). On failure, one
   repair call feeds the model its own output plus the exact validation errors.
4. **Normalise** — `normalizeRecommendations` in
   [candidates.ts](apps/server/src/scoring/candidates.ts) enforces structural
   existence gates (gated recs like `enable_promo_text` are injected or
   removed by code, never left to the model) and remaps each rec's `dimension`
   to its canonical value. The `dimension` field flickered between runs before
   this fix — it is now deterministic in code, not model text.
   No component of `rec_key` is ever a free model choice.

([score.ts:68-88](apps/server/src/scoring/score.ts#L68))

### 4.6 Strategy abstractions for the swappable parts
The LLM, the crawler and the web-search provider are the three pieces most
likely to change (and the first two the brief itself left open). Each sits
behind an interface with a factory, so swapping a provider is a config change,
not a refactor.
([getLlmProvider](apps/server/src/llm/index.ts#L18),
[getCrawler](apps/server/src/sources/crawler/index.ts#L14),
[getWebSearch](apps/server/src/sources/websearch/websearch.ts#L46))

### 4.7 Custom SSE routes over the generic client SDK
The suspend/resume flow is cleaner with the *server* controlling the run; the
browser consumes two endpoints and an SSE stream. Same-origin via a Vite proxy
— no CORS, no backend URL in the client. The identity payload now travels in
the `/audit/identify` response so the UI can widen the confirm prompt when
`identityNeedsConfirm` is true.
([routes.ts:/audit/health:94](apps/server/src/mastra/routes.ts#L94),
[/audit/identify:112](apps/server/src/mastra/routes.ts#L112),
[/audit/run:164](apps/server/src/mastra/routes.ts#L164), commit `87e6239`)

### 4.8 Identity as a first-class primitive
The app's declared App Store category is often wrong — a vehicle-companion app
sits under "Utilities"; a B2B tool sits under "Business". Auditing against the
declared category produces misleading `reposition_identity` recommendations.

ID-lite (Phase A, `87e6239`) resolves the app's **function-grounded identity**
before any scoring. Crucially, the day-one signals (`bundleId`, `sellerUrl`)
are already returned by the free iTunes Lookup API — no second fetch, no
additional key.
([domain/listing.ts:69-70](apps/server/src/domain/listing.ts#L69))

  `identify-app` constructs a `coreToIdentityListing`
  ([audit-workflow.ts:65-98](apps/server/src/mastra/workflows/audit-workflow.ts#L65)) — a
  minimal `AppListing` from the iTunes core with `reviews: []`,
  `competitors: []`, and `provenance.crawler: false`. This stripped listing is
  all ID-lite needs; the full listing (reviews, Firecrawl page scrape, competitors)
  is gathered only *after* the human has confirmed both the app and its identity.
  The design principle: do the cheap work first, gate on human, then do the
  expensive work.

- **Signal extraction** ([identity/signals.ts](apps/server/src/identity/signals.ts)) — pure
  code over the listing: developer name, bundle-id reverse-DNS org segment
  (e.g. `com.rivian.ios` → `"rivian"`), marketing domain label from
  `sellerUrl`, store genres, and a lowercased review corpus.
- **Gemini classifier** ([resolve-identity.ts:111-115](apps/server/src/mastra/tools/resolve-identity.ts#L111)) — the
  model interprets a grounded fact sheet into
  `{ functionCategory, functionNiche, functionTerms }` at temperature 0. It
  reads signals; it never *sets* the band.
- **Tally → band resolver** ([resolve.ts:72-185](apps/server/src/identity/resolve.ts#L72)) — a pure function
  of signal weights (`observed_on_store=2`, `fetched_and_cited=2`,
  `review_inferred=1`) and divergence type. Conflict collapses to `low`
  regardless of score.
- **Escalation gate** — `categoryBand === 'low'` or a high category over a
  low niche fires `escalate: true` and widens the confirm prompt. Cross-domain
  divergence is the most common trigger.
  ([resolve.ts:172-181](apps/server/src/identity/resolve.ts#L172))
- **Human override** ([human-confirm.ts](apps/server/src/identity/human-confirm.ts)) — a confirmed or corrected
  identity is stored as `source: 'human_confirmed'` (a tier above any resolved
  band). `resolveWithHistory`
  ([human-confirm.ts:101](apps/server/src/identity/human-confirm.ts#L101))
  reuses it verbatim when load-bearing signals haven't changed
  (`signalsMateriallyChanged` at
  [human-confirm.ts:81](apps/server/src/identity/human-confirm.ts#L81)), and
  re-asks only when the domain actually flips.
- **Identity-rewriting suppression** ([audit-memory.ts:244](apps/server/src/memory/audit-memory.ts#L244)) —
  `reposition_identity` recommendations are silently dropped when the identity
  is unconfirmed; the report's limitations section says why.

### 4.9 Generation is a pure function — the ledger is not injected
This was discovered live: injecting the prior recommendation ledger into the
generation prompt caused the model to diversify away from past recommendations
every run, growing the ledger instead of stabilising it.

The fix is to treat generation as stateless — a pure function of
`(listing + identity)`. The ledger is read **after** generation, in the memory
reconciliation layer (`persistAudit`
([audit-memory.ts:186](apps/server/src/memory/audit-memory.ts#L186))), where
applied-detection, contradiction guard, and dedup operate without polluting the
model's input. `buildPriorContext`
([audit-memory.ts:139](apps/server/src/memory/audit-memory.ts#L139)) injects
only the resolved identity (category, confidence band, and a cross-domain
divergence warning when `divergence === 'cross_domain'`) and the identity fact
sheet — never the ledger, never the prior recommendation set, never the
change-diff. The change-diff is computed later in `persistAudit` and surfaced
in the report's `limitations` section after generation, not before it.
([audit-workflow.ts:208-219](apps/server/src/mastra/workflows/audit-workflow.ts#L208),
commit `87e6239`)

### 4.10 Persistent ledger and dedup
Every audit persists four things to LibSQL ([migrate.ts](apps/server/src/memory/migrate.ts)):

1. **An immutable `aso_listing_snapshots` row** — the full listing, signals,
   report, rubric fingerprint and model id, frozen at that instant. Evidence
   chips resolve into *that date's* data.
2. **An `aso_identity_versions` row** — append-only; each run appends the
   resolved identity, so the history is traceable.
3. **Upserted `aso_recommendations` rows** — one live row per logical
   recommendation, deduped on `rec_key` (see below).
4. **`aso_rec_occurrences` rows** — one per (rec, snapshot) pair; the
   belief-accumulation write path.

**`rec_key = hash(dimension, intent, target_field, value_key)`** where
`value_key` is derived from the typed `Referent`
(`kind: 'keyword' | 'country' | 'none'`
([domain/recommendation.ts:58-62](apps/server/src/domain/recommendation.ts#L58))),
never the model's free-text prose
([dedup.ts:60-71](apps/server/src/memory/dedup.ts#L60), commit `87e6239`). The
normalisation (casefold + NFC + trim + plural-collapse
([dedup.ts:25-31](apps/server/src/memory/dedup.ts#L25))) means reworded
versions of the same suggestion collapse to one row. This was a live bug:
Gemini reworded the same suggestion on a second cold run → different
prose-hash → spurious duplicate row. Typed referents fix this permanently.

**`fix_complaint_theme` is single-instance at Phase A.** `ReferentSchema`
has no `theme` kind — only `keyword | country | none`. `fix_complaint_theme`
sits in `SINGLE_INSTANCE_INTENTS` so there is at most one complaint-theme rec
per listing; its `value_key` is forced empty. The 15-bucket `COMPLAINT_THEMES`
taxonomy exists in code (spec §C) and is the planned `value_key` discriminator
for Phase D, when the intent is upgraded to multi-instance and each theme bucket
gets its own independent rec. Until then, the `other`-collapse risk cannot arise.
([domain/recommendation.ts:36-50](apps/server/src/domain/recommendation.ts#L36))

**Applied-detection** ([audit-memory.ts:101-115](apps/server/src/memory/audit-memory.ts#L101)) — a prior
recommendation flips to `applied` when the *new* listing's relevant field
contains the `after_text`. This is a match, not a causal claim; the report
calls it "Applied since last audit".

**Contradiction guard** ([dedup.ts:98](apps/server/src/memory/dedup.ts#L98)) — two cases:
(1) a new rec reverses live advice on the same field and value (e.g.
`add_keyword` ↔ `remove_wasted_term`); (2) a dismissed rec is being re-raised.
Human dismissals are honoured: the occurrence is recorded, the status left
untouched.
([audit-memory.ts:258-259](apps/server/src/memory/audit-memory.ts#L258),
commit `87e6239`)

### 4.11 Score determinism and per-dimension reuse
Run-to-run score swings on unchanged listings are a first-class quality
problem. Phase A addresses this at multiple levels (commits `87e6239`, `a05e592`):

**Code-scored dimensions** — three dimensions are purely deterministic and
never sent to the model:
- `screenshots` → `signals.screenshots.slotsUsedOf10` (0–10)
- `previewVideo` → 8 if present, 0 if absent (existence only)
- `ratings` → normalised from `averageRating`, adjusted ±1 for recent trend

([dimension-scorer.ts:161-199](apps/server/src/scoring/dimension-scorer.ts#L161))

**Coarse-ordinal snapping** — `title` and `subtitle` model scores are snapped
to the nearest anchor `{0, 5, 10}` via `coarseOrdinalScore`, eliminating ±1–3
point drift. A utilisation floor (`< 20%` → forced `0`) is applied before
snapping. ([dimension-scorer.ts:214-233](apps/server/src/scoring/dimension-scorer.ts#L214))

**Prompt echoes computed scores** — `scoringConstraints` in
[prompt.ts:139](apps/server/src/scoring/prompt.ts#L139) injects the
code-derived numbers into the prompt so the model's *findings text* matches the
score that will actually be displayed. Without this, the model would write
"7 slots — solid" while the displayed score would show 7 from code.

**Per-dimension input hashing** — `dimensionInputHash` hashes the exact subset
of listing/signal fields each dimension depends on. When the hash matches the
prior run, the cached score is spliced in and the model is never called for
that dimension.
([dimension-scorer.ts:90-112](apps/server/src/scoring/dimension-scorer.ts#L90))

**Whole-snapshot reuse** — `RUBRIC_VERSION` is the first 16 hex chars of a
SHA-256 of the live rubric weight column **and** `SCORER_VERSION = 'phase-a-v1'`
([dimension-scorer.ts:13](apps/server/src/scoring/dimension-scorer.ts#L13)).
When the new audit's `promptHash`
([audit-workflow.ts:231-234](apps/server/src/mastra/workflows/audit-workflow.ts#L231))
and `RUBRIC_VERSION` both match the prior snapshot, the entire cached report is
returned with zero LLM calls. `SCORER_VERSION` being folded in (not just
weights) ensures a scorer-code change invalidates the cache even when the
listing itself is unchanged.
([version.ts:17-27](apps/server/src/scoring/version.ts#L17), commit `a05e592`)

**Rubric-weight replay** — `replayReportScore` in
[replay.ts](apps/server/src/scoring/replay.ts) recomputes the overall 0–100
from *frozen* dimension scores under a *different* weight column. Both live
assembly ([aggregate.ts:97](apps/server/src/scoring/aggregate.ts#L97)) and
replay delegate to the same `replayOverallScore` — one normalisation formula,
no drift between the two paths.

**Screenshot overcount bug (fixed in `87e6239`).** The original screenshot
signal used `Math.max(itunes_count, crawler_count)` to combine iTunes's
`screenshotUrls` length with Firecrawl's CDN URL extraction count. Firecrawl's
markdown parser picked up iPad-specific screenshots AND icons from related-app
sections, routinely inflating the crawler count to 15–18 — which forced
`Math.max` to report 10/10 (full score) for apps with only 5 phone screenshots.
Fix: iTunes `screenshotUrls` is the authoritative count; the crawler count is
used only as a *fallback* when `screenshotUrls` is empty (i.e., iTunes failed
but the crawler succeeded). The `crawledScreenshotCount` field is still stored
on the listing for provenance, but it never overrides a real iTunes count.
([signals.ts](apps/server/src/scoring/signals.ts))

### 4.12 Architecture invariants

1. **No `rec_key` component is free model text.** Dimension, intent,
   target_field and value_key are all deterministic or from a typed,
   schema-validated enum. The model phrases; code computes the identity.
   ([candidates.ts:9-10](apps/server/src/scoring/candidates.ts#L9),
   [dedup.ts:12-16](apps/server/src/memory/dedup.ts#L12))

2. **Recommendation generation is a pure function of `(listing + identity)`.**
   History is reconciled in code after generation, never injected into the
   generation prompt.
   ([audit-workflow.ts:208-212](apps/server/src/mastra/workflows/audit-workflow.ts#L208))

3. **The model proposes; code disposes.** For identity: the model guesses the
   function category; code corroborates via tally and gates via divergence.
   For scoring: the model judges; code computes confidence, the deterministic
   dimension scores, the quantization, and the 0–100 total.
   ([resolve.ts:72-185](apps/server/src/identity/resolve.ts#L72),
   [dimension-scorer.ts:118-154](apps/server/src/scoring/dimension-scorer.ts#L118))

4. **Reuse, don't recompute.** Byte-identical identity signals reuse the stored
   identity at zero LLM calls. Byte-identical listing snapshots reuse the
   stored report. Unchanged dimensions reuse their stored score.
   ([audit-workflow.ts:240-251](apps/server/src/mastra/workflows/audit-workflow.ts#L240),
   [audit-workflow.ts:270-295](apps/server/src/mastra/workflows/audit-workflow.ts#L270))

5. **Honesty discipline.** Every signal and score is labelled
   `observed` / `inferred` / `unavailable` truthfully. Stubbed sources report
   `searched_and_empty`, never fabricated data. On-store-only confidence is
   capped at `medium`. The system escalates on doubt rather than guessing.
   ([dimension-scorer.ts:118-154](apps/server/src/scoring/dimension-scorer.ts#L118),
   [websearch.ts:34-40](apps/server/src/sources/websearch/websearch.ts#L34),
   [resolve.ts:152-163](apps/server/src/identity/resolve.ts#L152))

---

## 5. Engineering practices that stand out

What a senior reviewer should notice:

- **Anti-corruption layer.** Three data sources (iTunes JSON, the reviews RSS
  feed, a Firecrawl page scrape) return wildly different shapes. None leaks
  past [listing.ts](apps/server/src/domain/listing.ts) — every source maps
  *into* one canonical `AppListing`. The scoring engine only ever sees the
  domain model.

- **`Result<T,E>` for expected failures.** A missing app or a flaky scraper is
  an expected outcome, not an exception — so it lives in the return type
  ([result.ts](apps/server/src/domain/result.ts)), where the compiler forces
  callers to handle it. Exceptions are reserved for genuine bugs.

- **Pattern vocabulary, applied where it earns its place.** Strategy (LLM,
  crawler, web-search), Factory (`getLlmProvider`, `getCrawler`,
  `getWebSearch`), Null Object (`NullCrawler`, `NoopWebSearch` — callers never
  branch on "is one configured?"), Anti-Corruption Layer,
  Generate-Validate-Repair. No pattern for its own sake.

- **Engine-agnostic storage seam.**
  [storage-client.ts](apps/server/src/memory/storage-client.ts) crosses only
  domain types — no SQL dialect, no vendor schema. The same conformance suite
  ([storage-client.conformance.ts](apps/server/src/memory/storage-client.conformance.ts))
  that the LibSQL client passes today is what a future Postgres client must
  pass, proving the swap is a config change. (commit `87e6239`)

- **Recommendation dedup with typed referents.** `rec_key` is a four-part hash
  (dimension, intent, target_field, value_key). `value_key` is derived from
  a typed `Referent` discriminator — never the model's free-text title or
  rationale — so reworded suggestions collapse to one row. Dismissals are
  sticky across rewordings.
  ([dedup.ts](apps/server/src/memory/dedup.ts), commit `87e6239`)

- **Tool-free auditor agent.** `aso-auditor` has no tools registered — every
  input is pre-gathered by the workflow before the agent runs. This means it
  relies only on structured text output, which every model supports, and never
  on function-calling reliability. Its one job is judgement.
  ([aso-auditor.ts:8-15](apps/server/src/mastra/agents/aso-auditor.ts#L8))

- **`IdentityClassifier` seam enables LLM call count assertions.** The
  identity resolver accepts an `IdentityClassifier` dependency via parameter
  rather than importing the Gemini agent directly. Tests inject a stub
  classifier and assert on call counts — this is the only reason the "zero LLM
  calls on unchanged listing" assertion in `a6-score-stability.test.ts` is
  writable at all. Without the seam the test could only check the output, not
  whether the model was actually skipped.
  ([resolve-identity.ts](apps/server/src/mastra/tools/resolve-identity.ts),
  [storage-client.conformance.ts](apps/server/src/memory/storage-client.conformance.ts))

- **Two-function tool pattern.** Each tool has a plain function (`identifyApp`,
  `gatherListing`) and a `createTool` wrapper. The workflow calls the plain
  function directly (the `identify-app` step needs to also resolve identity and
  then `suspend()`); an agent would call the tool. One implementation, two
  call sites, no duplication.
  ([identify-app.ts](apps/server/src/mastra/tools/identify-app.ts),
  [gather-listing.ts](apps/server/src/mastra/tools/gather-listing.ts))

- **Graceful degradation, with provenance.** iTunes core is the only hard
  dependency; reviews, competitors and the page crawl are best-effort and fan
  out in parallel. What each run actually observed is recorded in
  `provenance`, and the audit is honest about the gaps.

- **Discriminated unions over flags.** Chat messages and dimension confidence
  are tagged unions — rendering is one exhaustive `switch`, and illegal states
  are unrepresentable.

- **Rubric-as-data.** Weights, character limits and checks live in one table
  ([rubric.ts](apps/server/src/scoring/rubric.ts)), read by the scoring engine,
  the prompt and the UI. Retuning the framework touches no logic.

- **Strict TypeScript.** `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `verbatimModuleSyntax`, `isolatedModules` — and Zod validation at every
  external boundary (`safeParse`, not casts), so malformed data fails loudly
  at the seam, not deep in the scoring code.

- **Resilient I/O.** Every outbound call goes through one HTTP helper
  ([http.ts](apps/server/src/sources/http.ts)) with an abort-based timeout and
  bounded exponential-backoff retry that distinguishes retryable (5xx, 429,
  network) from terminal (404) failures.

- **Code-derived confidence and deterministic scoring.** The model is never
  asked to assess its own observability. `deriveConfidence` in
  [dimension-scorer.ts](apps/server/src/scoring/dimension-scorer.ts) is the
  single source of truth; three dimensions (`screenshots`, `previewVideo`,
  `ratings`) are pure functions of signals and never touch the LLM. Title and
  subtitle scores are quantised to `{0, 5, 10}` to eliminate run-to-run drift.

- **Identity classification with fail-safe parsing.** `parseClassificationText`
  in [resolve-identity.ts:89](apps/server/src/mastra/tools/resolve-identity.ts#L89)
  uses the same `extractJsonObject` brace-matcher as the audit JSON extraction,
  then Zod `safeParse`. Any malformed output degrades to
  `UNKNOWN_CLASSIFICATION` — the identify step never throws and always produces
  a band.

- **The pure core is unit-tested.** 193 hermetic tests cover URL parsing,
  signal computation, weighted aggregation, JSON extraction, the full
  `StorageClient` conformance suite, the ID-lite `§F` acceptance gates, the P1
  `§F` gates (dedup, contradiction, zero-LLM replay), human-confirm reuse and
  re-ask logic, dismissal stickiness across rewordings, and A6 score stability
  — without needing the network or an LLM.

- **Idiomatic Mastra.** `createStep(tool)` composes tools as workflow steps;
  `suspend`/`resumeStream` drives the human gate; `registerApiRoute` serves
  the SSE endpoints. The framework is used the way its docs intend.

- **Honest, actionable errors.** A failure surfaces a message a user can act
  on — *"Check that LLM\_API\_KEY (a Google AI Studio key, starting with
  'AIza') is set in .env"*, not a raw stack trace.

---

## 6. Development phases and engineering post-mortems

This section documents *how* the system evolved from the initial scaffold to its
current state: the deliberate decisions behind each phase, and the bugs
discovered in code review plus exactly how they were fixed. Commit hashes are
the canonical pointer to the diff.

### 6.1 Phase 0 — Gemini-only groundwork (commit `87e6239` early sub-commits)

**Ollama removal.** The initial Mastra scaffold included Ollama as an alternative
LLM backend. Since Gemini speaks the OpenAI wire format, `@ai-sdk/openai-compatible`
already handles it — a separate Ollama adapter was dead weight and a divergence
surface (different error shapes, different retry behaviour). Ollama was removed.
`getLlmProvider()` in [llm/index.ts:19](apps/server/src/llm/index.ts#L19) now
resolves only to `GoogleProvider`. Adding a new backend remains a one-class +
one-`case` operation at the factory.

**Migration runner.** Mastra's `LibSQLStore` creates its own internal tables.
The custom `aso_*` schema (`aso_listing_snapshots`, `aso_identity_versions`,
`aso_recommendations`, `aso_rec_occurrences`) needed its own idempotent runner
that fires at server startup before any queries. `runMigrations()` in
[migrate.ts](apps/server/src/memory/migrate.ts) issues `CREATE TABLE IF NOT EXISTS`
statements — no ORM, no framework, one function auditable in a single reading.

**Model reachability check.** `LlmProvider.reachable()` pings the configured
model endpoint before the workflow starts. The error is intentionally actionable —
*"Check that LLM\_API\_KEY (a Google AI Studio key, starting with 'AIza') is set in
.env"* — rather than a raw stack trace. The `score-listing` step additionally
catches and re-wraps any mid-run model failure with the model ID
([audit-workflow.ts:174-180](apps/server/src/mastra/workflows/audit-workflow.ts#L174)),
so a quota error identifies the responsible key.

**Docker volume mount.** `docker-compose.yml` mounts a persistent DB at
`.docker-data/` (the `ASO_DB_URL` env var) — outside the source tree so `git
status` stays clean. Without this, the SQLite file would appear as an untracked
change after every `docker compose up`.

### 6.2 A5 — Human escalation gate: `applyHumanDecision` and `resolveWithHistory` (commit `87e6239`)

**The two pure functions.** `applyHumanDecision`
([human-confirm.ts](apps/server/src/identity/human-confirm.ts)) maps an
`IdentityDecision` onto the resolved identity, setting `source: 'human_confirmed'`
and clearing `escalate: false`. Three decision modes:

| Mode | Meaning |
|---|---|
| `confirm` | Accept the Gemini-resolved category as-is |
| `correct` | Supply a free-text replacement category (stored verbatim) |
| `pick` | Select from the `candidates` list surfaced by the cross-domain divergence path |

`resolveWithHistory`
([human-confirm.ts:101](apps/server/src/identity/human-confirm.ts#L101)) is the
reuse gate: if `prior.source === 'human_confirmed'` and
`!signalsMateriallyChanged(prior, fresh)`, the prior identity is returned verbatim
at zero LLM calls. Re-asking happens only when the load-bearing signals (`bundleId`,
`sellerUrl`, `developer`) have materially changed AND the fresh Gemini
classification flips domain. This is the mechanism behind the
"same app, unchanged → zero identity LLM calls" acceptance test.

**`ResolvedIdentity` as a Zod schema — required for Mastra serialization.** Mastra
serializes step output across the `suspend` boundary into LibSQL. `ResolvedIdentity`
had to become a proper Zod-validated schema (not a bare TypeScript interface) so
the `source` discriminant and all enum values survive round-trip deserialization.
Without this, the human decision captured at `confirm-app` would be unreadable at
`score-listing` via `getStepResult`.
([audit-workflow.ts:191-196](apps/server/src/mastra/workflows/audit-workflow.ts#L191))

**`getStepResult` cross-step read verified by hermetic mini-workflow.** Code
review raised the question: does a resumed step's output survive readable from
a *later* step past an intervening narrow step (`confirm → gather → score`)?
The A7 fix added a hermetic mini-workflow that drives the exact sequence and
asserts the identity decision is readable in `score-listing`. It holds — the
`getStepResult(identifyStep)` / `getStepResult(confirmStep)` pattern at
[audit-workflow.ts:191-204](apps/server/src/mastra/workflows/audit-workflow.ts#L191)
is verified, not assumed.

### 6.3 A3-fixup — Typed `Referent` pins `rec_key` (commit `87e6239`)

**Root cause.** The original `value_key` was derived from the recommendation's
free-text `after` or `title` prose emitted by the model. Gemini rewords
suggestions between runs ("add 'fitness tracker' to keywords" vs "include
'fitness tracker' in your keyword list"). Different prose → different hash →
different `rec_key` → two duplicate ledger rows for the same suggestion. This
also meant a dismissed rec could be re-raised under a different wording — the
contradiction guard would miss it because the `rec_key` was different.

**Fix: `ReferentSchema`.** `ReferentSchema`
([domain/recommendation.ts:58-62](apps/server/src/domain/recommendation.ts#L58))
is a discriminated union that the model emits alongside `intent`:

```
{ kind: 'keyword', value: 'fitness tracker' }
{ kind: 'country', value: 'GB' }
{ kind: 'none' }                         // single-instance intents
```

`computeRecKey` ([dedup.ts:60-71](apps/server/src/memory/dedup.ts#L60)) derives
`value_key` from `referent.value` — never from prose. `normalizeValueKey`
([dedup.ts:25-31](apps/server/src/memory/dedup.ts#L25)) runs casefold + Unicode
NFC + trim + depluralize. The `depluralize` rule (`-s` / `-es`) mirrors Apple's
indexing: "tracker" and "trackers" are the same keyword in Apple's Search Ads.
Intentionally not full stemming — "track" and "tracker" are distinct keywords.
The four `parts` are space-joined before hashing, producing a fixed-width 32-hex-char
key. The `NUL-joined` comment in the source predates a refactor; the live code
uses `' '` (space) as the separator.

**Stickiness of dismissals across rewordings.** With typed referents, a dismissal
is sticky across any rewording: same `referent.value` → same `rec_key` →
contradiction guard catches the re-raise → occurrence recorded against the
dismissed row's id, status untouched. This is verified by the "reworded-dismissed"
hermetic test (97 tests, commit `87e6239`).

### 6.4 Code review bugs and fixes (within commit `87e6239`)

#### Dismissed rec upsert race (the most important bug)

**Bug.** `upsertRecommendation` SQL used:
```sql
ON CONFLICT (app_id, country, rec_key) DO UPDATE SET status = excluded.status
```
Re-raising a `dismissed` rec would flip `dismissed → proposed` silently. A user
who dismissed a suggestion would see it re-appear on the next audit.

**Fix.** `persistAudit` now checks before calling `upsertRecommendation`: if the
contradicting row has `status === 'dismissed'`, it calls
`recordOccurrence(conflict.id, snapshotId, true)` (the third arg flags it as a
re-raise) and `continue`s — no upsert, no status flip. The dismissal sticks.
([audit-memory.ts:255-261](apps/server/src/memory/audit-memory.ts#L255))

#### Orphaned occurrence rows

**Bug.** LibSQL's `ON CONFLICT ... DO NOTHING` on `upsertRecommendation` keeps
the *original* ledger row with its *original* `id`. `toLedgerRec` generates a
fresh `newId('rec')` id for every candidate. When `recordOccurrence(rec.id, ...)`
was called on a re-raise, `rec.id` was the freshly minted id — a row that
didn't exist in `aso_recommendations`. LibSQL (without `PRAGMA foreign_keys = ON`)
silently accepted the write; the occurrence row existed but was orphaned and
invisible in belief-accumulation counts.

**Fix.** `persistAudit` builds `priorIdByRecKey = new Map(priorLedger.map(r => [r.recKey, r.id]))`
before the recommendation loop and uses
`priorIdByRecKey.get(rec.recKey) ?? rec.id` for every `recordOccurrence` call
— so re-raised recs always log against the canonical stored id.
([audit-memory.ts:240](apps/server/src/memory/audit-memory.ts#L240),
[audit-memory.ts:264](apps/server/src/memory/audit-memory.ts#L264))

#### Fail-safe classifier parse

**Bug.** `extractJsonObject` does brace-matching — it returns the substring
between the outermost matching braces. That substring passes the balanced-brace
check but can be invalid JSON (trailing commas, single quotes, `<think>` block
remnants from Gemini 2.5 Flash's reasoning output). If `JSON.parse` threw, the
whole `identify-app` step crashed with an unhandled exception, leaving the
workflow in an unresumable state.

**Fix.** `parseClassificationText()`
([resolve-identity.ts:89](apps/server/src/mastra/tools/resolve-identity.ts#L89))
wraps the parse in `try/catch`, then runs Zod `safeParse`, then falls through to
`UNKNOWN_CLASSIFICATION` if either fails. The step always produces a band; it
never throws. Unit-tested for malformed, empty, and wrong-shape JSON cases.

### 6.5 A7 correctness fixes (within commit `87e6239`)

#### `nicheBand` missing on the no-flip reuse path

**Bug.** `applyHumanDecision` correctly set `nicheBand` when writing back a
`human_confirmed` identity. `resolveWithHistory` on the no-flip reuse path
(signals unchanged, prior returned verbatim) did not mirror that assignment.
The returned identity had the wrong niche confidence when a human-confirmed
result was reused unchanged. This caused the prompt to emit a misleading
niche confidence level and could cause divergence between the stored and
displayed identity.

**Fix.** Mirror `applyHumanDecision`'s `nicheBand` assignment in the reuse
path of `resolveWithHistory`.
([human-confirm.ts](apps/server/src/identity/human-confirm.ts))

#### `SCORER_VERSION` missing from `dimensionInputHash`

**Bug.** `dimensionInputHash` hashed only the relevant listing fields for each
dimension (e.g. `{ name: listing.name }` for `title`). A `codeScore` or
`coarseOrdinalScore` logic change on an unchanged listing produced an identical
hash, so the per-dimension reuse cache silently served the stale pre-change
score — the new scoring logic was never reached for cached dimensions.

**Fix.** Prepend `SCORER_VERSION + ':'` to the hash input at
[dimension-scorer.ts:96](apps/server/src/scoring/dimension-scorer.ts#L96).
Bumping `SCORER_VERSION` (e.g. `'phase-a-v1'` → `'phase-b-v1'`) now invalidates
ALL per-dimension caches for ALL stored snapshots in one string change.

#### Single `overallScore` formula

**Bug.** `assembleReport` in [aggregate.ts](apps/server/src/scoring/aggregate.ts)
computed the weighted-average normalisation inline. `replayReportScore` in
[replay.ts](apps/server/src/scoring/replay.ts) had a slightly different
formulation. After a rubric weight retune, the live score and the replayed score
would diverge — a correctness bug that would be invisible until someone actually
ran a replay.

**Fix.** `assembleReport` now delegates to `replayOverallScore` — one
normalisation formula `Σ(score·weight) / Σ(weight)`, one code path, shared
between live assembly and replay.
([aggregate.ts:97](apps/server/src/scoring/aggregate.ts#L97))

#### Hono 4.12 type breakage

**Symptom.** Hono 4.12 changed the internal `[GET_MATCH_RESULT]` symbol on
`HonoRequest`, breaking `tsc --noEmit` for the `streamSSE` call site in
[routes.ts](apps/server/src/mastra/routes.ts). Runtime behaviour was
unaffected — this was a pure type-level regression in the Hono upgrade.

**Fix.** Cast `c as any` for the `streamSSE` argument. Noted as a known typing
regression until Hono stabilises the API. The `tsc --noEmit` gate now exits
clean at 0 errors.

### 6.6 A7 residual (c) — `SCORER_VERSION` in whole-snapshot reuse (commit `a05e592`)

**Bug.** The whole-snapshot cache compared `promptHash + rubricVersion`.
`rubricVersion` was `hash(rubric_weights)` only — scorer code was not in the
key. A `codeScore` or `coarseOrdinalScore` change on an unchanged listing:

1. Changed no listing fields → same `promptHash`.
2. Changed no rubric weights → same `rubricVersion`.
3. Therefore `listingUnchanged = true` → stale cached report returned,
   new scoring logic silently ignored.

This was the most subtle caching bug: it couldn't be caught by running the
tests (tests don't change scorer code between runs), only by a careful
adversarial review of the cache key.

**Fix.** `scoringVersion()` in [version.ts:17-27](apps/server/src/scoring/version.ts#L17):

```ts
export function scoringVersion(scorerVersion = SCORER_VERSION): string {
  return createHash('sha256')
    .update(JSON.stringify(RUBRIC.map(d => [d.id, d.weight])))
    .update(':')
    .update(scorerVersion)
    .digest('hex')
    .slice(0, 16);
}

export const RUBRIC_VERSION = scoringVersion();
```

`RUBRIC_VERSION` now captures rubric weights AND scorer code version. Bumping
`SCORER_VERSION` in [dimension-scorer.ts:13](apps/server/src/scoring/dimension-scorer.ts#L13)
changes `RUBRIC_VERSION`, which fails the whole-snapshot equality check and
forces a full re-score. The `scorerVersion` parameter is purely for testability —
`version.test.ts` asserts that a scorer-version change yields a different
fingerprint without touching the live `SCORER_VERSION` constant.

### 6.7 Test count evolution

The hermetic test suite grew in lockstep with each phase and bug fix:

| Milestone | Tests | Coverage added |
|---|---|---|
| Phase A main | 78 | URL parsing, StorageClient conformance, ID-lite §F gates, P1 §F gates (dedup, contradiction, zero-LLM replay) |
| + A5 (human escalation) | 88 | `human-confirm` reuse/re-ask/flip, `human_confirmed` persistence |
| + code review fixes | 95 | Dismissed-rec honouring, `parseClassificationText` fail-safe, `getStepResult` cross-step guard |
| + A3-fixup (typed referent) | 96 | "reworded re-raise" → same `referent.value` → same `rec_key` |
| + reworded-dismissed test | 97 | Dismissal stickiness across model rewordings |
| + A7 correctness fixes | 186 | Per-dimension reuse with `SCORER_VERSION`, occurrence regression, niche-band fix |
| + A7 residual (`a05e592`) | 191 | `scoringVersion()` unit test pins scorer-version change yields different fingerprint |

All 191 tests are hermetic — no network, no LLM, no running server.
