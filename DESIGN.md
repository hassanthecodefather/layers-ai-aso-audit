# Design & Engineering Notes

This document covers **what was built**, **how it maps to the take-home brief**,
and the **engineering decisions and implementation details** behind every layer.
For setup, see the [README](README.md).

---

## 1. What was built

A conversational ASO (App Store Optimization) audit agent. The user pastes an
Apple App Store URL; the app resolves metadata, resolves app identity,
confirms the app with the user, runs a full ten-dimension audit, and renders a
prioritised report. Subsequent runs detect what the user applied and never
repeat dismissed advice.

The flow is a four-step **Mastra workflow** with one human-in-the-loop gate:

```
identify-app ─▶ confirm-app ──suspend──▶ [user confirms app + identity] ─▶ gather-listing ─▶ score-listing
```

1. **`identify-app`** — resolves the URL to surface metadata (name, developer,
   icon, category, rating) via Apple's free iTunes Lookup API, and runs the
   **ID-lite identity resolver** — a deterministic signal tally, a Gemini
   function classifier, and an off-store web-search footprint probe (Tavily/Exa),
   the last two run concurrently — so the single human gate can ask one widened
   question: "Is this the app, and is this what it does?"
2. **`confirm-app`** — the workflow **`suspend()`s**. Its state serialises to
   LibSQL; the UI shows an *"Is this the app you meant?"* card and waits.
3. **`gather-listing`** — on confirmation the workflow resumes, fanning out
   across every data source into one canonical listing.
4. **`score-listing`** — computes deterministic signals, runs vision analysis,
   generates keyword candidates, analyses review themes, asks the auditor agent
   for a structured judgement, assembles the report, and persists the snapshot.

Progress streams to the browser over Server-Sent Events the whole time.

### Build phases

The codebase evolved in tracked phases, each with its own spec gates (§F):

| Phase | What shipped |
|---|---|
| **v1.0** | Base four-step workflow, scoring engine, SSE, full React UI |
| **Phase 0** | Gemini-only LLM; `verifyModel()` startup probe; idempotent migration runner |
| **Phase A** | StorageClient seam + LibSQL; ID-lite identity resolver; P1 persistent memory; dedup; human-escalation gate; `A6` per-dimension + whole-snapshot reuse |
| **A7 fix** | `scoringVersion()` folds `SCORER_VERSION` into the reuse cache key |
| **Phase B** | B1 Gemini vision pass; B2 ID-full vision-grounded identity; B3 secondary uplifts; C4 keyword candidates; D2/D3 competitor discovery + review themes; F-K2 competitor review mining; export (Markdown); cost governor; storefront sweep |
| **D2/hardening** | D2 correction (multi-instance theme recs), vision hardening, identity fixes, observability (FileTransport) |

### The Mastra primitives

The brief asked for *"idiomatic use of agents, tools, workflows, and skills."*

| Primitive | Where |
|---|---|
| **Agent** | [`aso-auditor`](apps/server/src/mastra/agents/aso-auditor.ts) — scores the ten dimensions; its instructions *are* the audit skill |
| **Tools** | [`identify-app`](apps/server/src/mastra/tools/identify-app.ts), [`gather-listing`](apps/server/src/mastra/tools/gather-listing.ts) — composed directly as workflow steps via `createStep(tool)` |
| **Workflow** | [`aso-audit`](apps/server/src/mastra/workflows/audit-workflow.ts) — four-step pipeline with `suspend`/`resume` for the human gate |
| **Skill** | [`mastra/skills/aso-audit.ts`](apps/server/src/mastra/skills/aso-audit.ts) — the audit framework (rubric, scoring bands, output discipline), loaded as the agent's instructions |

---

## 2. How it maps to the brief

Every requirement in `task.md`, and where it is met:

| Brief requirement | How it's met |
|---|---|
| Chat app; user pastes an App Store URL | React chat UI; [`Composer`](apps/web/src/components/Composer.tsx) accepts any `apps.apple.com` URL or bare app ID |
| Fetch surface metadata, confirm *"Is this the app you meant?"* | `identify-app` step → workflow **suspends** → [`ConfirmationCard`](apps/web/src/components/ConfirmationCard.tsx) (icon, name, developer, category, rating, identity) with Yes/No |
| On confirmation, run the full audit | `resume()` → `gather-listing` → `score-listing` |
| Keep the user informed while it runs | SSE `progress` events per workflow step, rendered as a live [`ProgressTrace`](apps/web/src/components/ProgressTrace.tsx) |
| Present recommendations nicely | [`ScoreCard`](apps/web/src/components/ScoreCard.tsx) (score ring + per-dimension bars), grouped recommendation cards with before/after diffs, competitor table |
| Works on apps you haven't seen | Verified across Spotify, TikTok, Notion, US & GB storefronts; URL parsing handles every link form |
| Mastra: agents, tools, workflows, skills | See the table above |
| The 10-dimension weighted rubric, scored 0–100 | [`scoring/rubric.ts`](apps/server/src/scoring/rubric.ts) (rubric-as-data) + [`scoring/aggregate.ts`](apps/server/src/scoring/aggregate.ts) (weighted, normalised) |
| Output: Score Card, Quick Wins, High-Impact, Strategic, Competitor table | The `AuditReport` shape and the `ReportView` components map 1:1 to this |
| Evidence + before/after for every text change | Enforced in the skill and the `Recommendation` schema (`before`/`after` required for text changes) |
| `npm install && npm run dev` works | npm workspaces; one root `dev` script runs both apps |
| Complete `.env.example` | Documents every variable, both LLM options, and the optional crawler |
| README with setup + decisions | [README.md](README.md) + this document |

Deliberate refinements (the brief invited these):

- The rubric's weight column **sums to 110, not 100** — kept all ten
  dimensions and normalised instead of dropping one (see §4.3).
- Added **confidence levels** — the iOS keyword field isn't public, so
  pretending to score it would be dishonest (see §4.4).
- Added **persistent memory** — second audits detect what was applied and never
  repeat dismissed advice (see §4.8).
- Added **function-grounded identity** — the app is resolved to what it
  *does*, not just its store category, before scoring (see §4.9).
- Added **Gemini vision analysis** — screenshots and icons are assessed by the
  model before the prompt is built, so the LLM can cite per-slot critiques in
  findings (see §4.10).

---

## 3. Architecture

The codebase is a layered monorepo. Each layer has one job and a typed seam to
the next.

```
apps/
  server/
    src/
      domain/        Canonical types — AppListing, AuditReport, URL parsing, Result<T,E>
      llm/           LLM Strategy — LlmProvider interface + GeminiProvider + factory
      sources/       Data layer — iTunes adapter, HTTP retry/timeout, parallel fan-out
        crawler/     Crawler Strategy — ListingCrawler + Firecrawl / Null
        websearch/   Web-search seam — WebSearchProbe interface + Tavily/Exa/Noop
      scoring/       Rubric, deterministic signals, prompt, JSON extraction, aggregation
      identity/      ID-lite resolver, signals, domains, human-confirm, ID-full (vision)
      memory/        StorageClient seam, LibSQL implementation, dedup, persistAudit
      vision/        GeminiVisionClient, dHash, analysis, secondary uplifts
      keywords/      Candidate generation, AppKittie client, opportunity ranking, linter
      reviews/       Theme analysis, embedding provider
      cost/          Spend governor, LLM gateway, cache, pacer
      export/        Markdown export
      mastra/        Agent, tools, workflow, skill, SSE routes, composition root
  web/               Vite + React + Tailwind chat UI
```

Three **Strategy seams** isolate the volatile, third-party parts:

- **LLM** ([`src/llm/`](apps/server/src/llm/)) — an `LlmProvider` interface;
  `GeminiProvider` is the implementation. `getLlmProvider()` is the factory.
  Adding a backend = one class + one `case`.
- **Crawler** ([`src/sources/crawler/`](apps/server/src/sources/crawler/)) — a
  `ListingCrawler` interface; `FirecrawlCrawler` is the real one, `NullCrawler`
  the no-op fallback. Callers never branch on "is one configured?".
- **Web search** ([`src/sources/websearch/`](apps/server/src/sources/websearch/)) —
  a `WebSearchProbe` interface; `TavilyWebSearch` (primary) and `ExaWebSearch`
  (fallback) query their REST APIs through the source gateway, and `NoopWebSearch`
  is the keyless stub. App-Store / aggregator mirror domains are suffix-match
  filtered so they never count as off-store corroboration.

The agent, workflow, and data layer depend only on these interfaces — never on
"Gemini", "Firecrawl", "Tavily" or "Exa" directly.

---

## 4. Key decisions

### 4.1 Workflow-driven, not agent-driven

**What:** the sequence (identify → confirm → gather → score) is encoded as a
Mastra **workflow** — control flow in code, judgement in the LLM.

**Why:** the steps are fixed and non-negotiable. An agent left to reason about
the sequence would be wasteful and unreliable. The `suspend()`/`resume()` gate
in [`audit-workflow.ts:147-178`](apps/server/src/mastra/workflows/audit-workflow.ts#L147-L178)
is not a prompt heuristic — it is a genuine workflow pause that serialises the
step's input to LibSQL and waits for the browser's `POST /audit/run`. That is
what makes it reliable across browser refreshes and network interruptions.

The `identify-app` step was extended in Phase A to run ID-lite before the gate,
so the single human pause can widen to "is this the app, and is this what it
does?" ([`audit-workflow.ts:115-144`](apps/server/src/mastra/workflows/audit-workflow.ts#L115-L144)).

### 4.2 The LLM never does arithmetic

**What:** character counts, utilisation ratios, screenshot tallies, rating
averages, and the weighted 0–100 total are all computed in pure, unit-tested
code ([`scoring/signals.ts`](apps/server/src/scoring/signals.ts),
[`scoring/aggregate.ts`](apps/server/src/scoring/aggregate.ts),
[`scoring/dimension-scorer.ts`](apps/server/src/scoring/dimension-scorer.ts)).
The agent receives those as an authoritative *fact sheet* and supplies only
judgement.

**Why:** models are unreliable at counting and averaging. This removes that
failure mode entirely. `assembleReport()` in
[`aggregate.ts:41-153`](apps/server/src/scoring/aggregate.ts#L41-L153) is the
single place where scores turn into the headline number — it applies weights,
normalises, and quantises, then delegates the formula to
[`replay.ts`](apps/server/src/scoring/replay.ts) so live assembly and rubric-weight
replay share one definition.

The `codeScore()` function in
[`dimension-scorer.ts`](apps/server/src/scoring/dimension-scorer.ts) hard-computes
scores for fully-observable dimensions (ratings, preview video). For mixed
dimensions (title, subtitle), `coarseOrdinalScore()` quantises the model's
0-10 to {0, 5, 10}, eliminating ±1-3 run-to-run score drift.

### 4.3 The rubric sums to 110 — normalise, don't drop

**What:** [`scoring/rubric.ts`](apps/server/src/scoring/rubric.ts) holds all ten
dimensions and their weights unchanged from the brief. The brief's weight column
adds to 110, not 100.

**Why:** rather than silently drop a dimension, all ten are kept and the score
is normalised: `Σ(score·weight) / Σ(weight)`. This produces a true 0–100
regardless, and gracefully handles a dimension dropping out when the crawler
isn't configured — the `assessableWeight` denominator in
[`aggregate.ts:82-84`](apps/server/src/scoring/aggregate.ts#L82-L84) excludes
`confidence === 'unavailable'` dimensions automatically.

### 4.4 Honest confidence levels

**What:** the iOS keyword field is **not public** — neither Apple's API nor the
web page exposes it. Each dimension carries a `Confidence`:
`'observed'` (directly measured), `'inferred'` (scored by inference, e.g. the
keyword field), or `'unavailable'` (excluded from the weighted total).

**Why:** pretending to score an unobservable field would be dishonest. The
report states its own limitations rather than bluffing. `deriveConfidence()` in
[`dimension-scorer.ts`](apps/server/src/scoring/dimension-scorer.ts) centralises
this: when a `VisionResult` is present and `visionUsable()` is true, screenshots
and icon flip to `'observed'` rather than `'inferred'`. The `visionUsable()`
guard in [`dimension-scorer.ts:24-26`](apps/server/src/scoring/dimension-scorer.ts#L24-L26)
is the single shared truth used by all four callsites.

### 4.5 Owned structured output: generate → validate → repair

**What:** [`scoring/score.ts`](apps/server/src/scoring/score.ts) owns the
structured output contract: ask for the JSON, extract it (tolerating code
fences, prose, and reasoning-model `<think>` blocks via
[`scoring/extract.ts`](apps/server/src/scoring/extract.ts)), validate with Zod,
and on a schema miss make exactly **one repair call** with the validation errors
fed back.

**Why:** providers don't reliably enforce a schema via `response_format`. Gemini
in testing returned valid-but-wrong-shaped JSON. The repair loop is capped at
one attempt — a model that can't produce valid JSON on the second try is not
going to improve with more tries, and unlimited retries would be a cost bomb.

### 4.6 Strategy abstractions for the swappable parts

**What:** the LLM and the crawler are behind interfaces with factories.
[`llm/provider.ts`](apps/server/src/llm/provider.ts) defines `LlmProvider`;
[`llm/index.ts`](apps/server/src/llm/index.ts) is the factory.
[`sources/crawler/crawler.ts`](apps/server/src/sources/crawler/crawler.ts) defines
`ListingCrawler`; [`sources/crawler/index.ts`](apps/server/src/sources/crawler/index.ts)
is the factory. `NullCrawler` ([`sources/crawler/none.ts`](apps/server/src/sources/crawler/none.ts))
is the Null Object — callers never branch on "is one configured?".

**Why:** these are the two pieces most likely to change. Swapping a provider
is a config change, not a refactor.

### 4.7 Custom SSE routes over the generic client SDK

**What:** the browser consumes two endpoints (`POST /audit/identify` and
`POST /audit/run`) plus a persistent `GET /audit/stream/:runId` SSE channel.
These are registered via `registerApiRoute` in
[`mastra/routes.ts`](apps/server/src/mastra/routes.ts) and proxied same-origin
through the Vite dev server ([`apps/web/vite.config.ts`](apps/web/vite.config.ts)).

**Why:** the `suspend`/`resume` flow is cleaner with the server controlling the
run lifecycle. Same-origin via Vite proxy means no CORS, no backend URL in the
client bundle. The [`useAudit`](apps/web/src/hooks/useAudit.ts) hook owns the
full state machine in the browser.

### 4.8 Persistent memory with dedup and contradiction guard (Phase A)

**What:** every finished audit is persisted as an immutable snapshot
(`aso_snapshots`) and its recommendations are upserted into a ledger
(`aso_recommendations`). [`memory/dedup.ts`](apps/server/src/memory/dedup.ts)
computes a stable `rec_key = SHA-256(dimension, intent, target_field, value_key)`,
independent of the model's wording. [`memory/audit-memory.ts`](apps/server/src/memory/audit-memory.ts)
drives the full flow: `persistAudit()` → applied-detection → contradiction guard.

**Why:** without memory, every re-audit produces a fresh list of suggestions the
user has already seen. With memory:
- Applied-detection ([`audit-memory.ts:139-164`](apps/server/src/memory/audit-memory.ts#L139-L164))
  marks a prior rec as `applied` when the new listing satisfies its `after_text`
  (a match, not a causal claim).
- The contradiction guard ([`dedup.ts:99-126`](apps/server/src/memory/dedup.ts#L99-L126))
  refuses to silently reverse past advice (`add_keyword` ↔ `remove_wasted_term`
  on the same term, or re-raising a dismissed rec).
- `value_key` normalisation ([`dedup.ts:24-45`](apps/server/src/memory/dedup.ts#L24-L45))
  applies casefold + Unicode NFC + trim + the linter's `s/es` plural rule, so
  "tracker" and "trackers" collapse to one key.

**The StorageClient seam** ([`memory/storage-client.ts`](apps/server/src/memory/storage-client.ts))
only domain types cross it — no SQL dialect, no vendor schema. The LibSQL
implementation ([`memory/libsql-storage-client.ts`](apps/server/src/memory/libsql-storage-client.ts))
shares the same DB Mastra uses for workflow serialisation. The same conformance
suite ([`memory/storage-client.conformance.ts`](apps/server/src/memory/storage-client.conformance.ts))
is what §F/6a says a future Postgres client must also pass — the swap is a
wiring change, proven by the suite, not a migration.

**Schema migrations** are handled by an idempotent runner
([`memory/migrate.ts`](apps/server/src/memory/migrate.ts)) that uses `CREATE TABLE IF NOT
EXISTS` and `ALTER TABLE ADD COLUMN IF NOT EXISTS` — safe to run on every boot,
never destructive.

### 4.9 Function-grounded identity: ID-lite and ID-full (Phase A + B)

**The problem:** the App Store's declared category is unreliable. A charging-station
app might be filed under "Travel" by the developer. Rewriting its listing with
positioning aimed at "Travel apps" would be wrong and potentially harmful.

**ID-lite** ([`identity/resolve.ts`](apps/server/src/identity/resolve.ts)):

A *deterministic* weighted tally of signal families feeding a two-axis
confidence band. Four families derive in code from the iTunes core data; the
fifth (`footprint`) comes from an **off-store web-search probe** (Tavily primary /
Exa fallback, mirror-domain filtered) run concurrently with the Gemini function
classifier in `resolveAppIdentity`:

| Family | Source tier | Weight | What it checks |
|---|---|---|---|
| `developer` | `observed_on_store` | 2 | Developer name always present |
| `bundle_id` | `observed_on_store` | 2 | Reverse-DNS org vs developer/domain |
| `marketing_domain` | `fetched_and_cited` | 2 | Seller URL domain vs bundle org |
| `reviews` | `review_inferred` | 1 | Function vocabulary in review corpus |
| `footprint` | `fetched_and_cited` | 2 | Off-store web-search corroboration (Tavily/Exa) |

`S = Σ(weight of agreeing families)`. The **band** is then:

- `cross_domain` divergence (store category ≠ function) → `low`, always
- `S ≥ 4 + distinct ≥ 2 + tier-2 present + not onStoreOnly` → `high`
- `S ≥ 4 + ... + onStoreOnly` → `medium` (the on-store cap: first-party
  signals aren't independent corroboration)
- `S ≥ 2` → `medium`
- `S < 2` → `low`

`escalate = categoryBand === 'low'` — the hard gate. When it fires, the
`confirm-app` step widens the confirmation card to surface the identity question,
and identity-rewriting recommendations are suppressed from both the visible
report and the ledger ([`audit-workflow.ts:444-448`](apps/server/src/mastra/workflows/audit-workflow.ts#L444-L448)).

**If the user confirms the app but makes no identity decision** (the common
case — see the caveat below), the audit is *not* blocked: `applyHumanDecision`
is skipped, the identity stays the LLM best-guess (`source: 'resolved'`,
`escalate: true`), all ten dimensions are still scored, and the report carries a
limitation note — *"Identity unconfirmed … no human confirmation was given.
Identity-rewriting recommendations were withheld."* Only rejecting the *app*
itself (`confirmed: false`) cancels the run. **Caveat:** the widened
*correct / pick a category* control is backend-ready (`applyHumanDecision`, and
`/audit/run` accepts an `identityDecision`) but **not yet surfaced in the UI**, so
`identityDecision` arrives `null` in practice — meaning every escalated app
currently takes this best-guess-unconfirmed path.

Divergence is classified by [`identity/domains.ts`](apps/server/src/identity/domains.ts)
which clusters Apple's genre strings into function buckets and detects
`cross_domain` / `niche_ambiguous` / `aligned`.

**Human override** ([`identity/human-confirm.ts`](apps/server/src/identity/human-confirm.ts)):
`applyHumanDecision()` stamps a `human_confirmed` source tier onto the identity;
`resolveWithHistory()` respects a stored human-confirmed identity and only
re-asks when its deterministic signals materially change AND the fresh answer
flips domain. This is a sticky override — not just for the current run.

**ID-full** ([`identity/id-full.ts`](apps/server/src/identity/id-full.ts)):
Runs after B1 vision, gated on `visionWasFresh`. Asks the Gemini vision client
whether the icon and first screenshot match the resolved function category.
Does **not** re-run the deterministic tally — it copies `category`,
`categoryBand`, `tally`, `divergence`, and `source` verbatim from ID-lite and
adds `audience` + refined `nicheBand`. May de-escalate a prior niche escalation
if vision confirms function (but never de-escalates `cross_domain` — structural
divergence can't be resolved by creative evidence).

```
litePrior.escalate &&
litePrior.divergence !== 'cross_domain' &&
creativeMatch.creativeMatchesFunction → deEscalate = true
```

De-escalation rule at [`id-full.ts:96-103`](apps/server/src/identity/id-full.ts#L96-L103).
The `maxIdentityVersion()` query ensures version numbers stay strictly monotonic
even when `latestIdentity()` (which prefers `stage='full'` rows for semantic
reads) returns an older full row as the head.

### 4.10 Gemini vision analysis (Phase B — B1)

**What:** [`vision/client.ts`](apps/server/src/vision/client.ts) wraps Gemini's
OpenAI-compat endpoint at `temperature=0` with `reasoning_effort:'none'` (Phase
D hardening — prevents thinking tokens from exhausting the budget and truncating
JSON). Three client implementations:

- `GeminiVisionClient` — the live client; calls `analyzeScreenshots()`,
  `analyzeScreenshotSet()`, `analyzeIcon()`.
- `StubVisionClient` — returns empty/placeholder values and tracks `callCount`
  for zero-LLM tests.
- `NoOpVisionClient` — returned by `getVisionClient()` when no API key is set;
  all existing tests (508 hermetic) are unaffected.

**dHash** ([`vision/phash.ts`](apps/server/src/vision/phash.ts)):
A 64-bit difference hash (not pHash despite the module name — a historical
misnomer retained for backwards compat). Algorithm: resize image to 9×8
greyscale via `jimp`, compare adjacent pixels left-to-right per row → 64-bit
gradient fingerprint → 16-char hex. Hamming distance via `dHashDistance()`.
Falls back to SHA-256 on jimp decode failure (documented as non-perceptually-meaningful).

**Vision runs before the prompt is built**
([`audit-workflow.ts:285-293`](apps/server/src/mastra/workflows/audit-workflow.ts#L285-L293))
so per-slot critiques and icon assessment are included in the prompt and the LLM
can cite them. Vision is part of the prompt hash, so a screenshot change
correctly invalidates the whole-snapshot cache.

**`selectVisionResult()`** ([`vision/select.ts`](apps/server/src/vision/select.ts))
is the zero-LLM reuse path: if screenshot and icon URLs are unchanged since
the prior snapshot, the stored `VisionResult` is returned directly. The stored
JSON is validated with `VisionResultSchema.safeParse()` on read — same discipline
as recs and identity rows.

**B3 secondary uplifts** ([`vision/secondary-uplifts.ts`](apps/server/src/vision/secondary-uplifts.ts)):
Gated on `visionWasFresh`. Produces:
- `screenshotSetAnalysis` — `hasDuplicateMessages`, `duplicateSlots`,
  `promoteCandidateSlot` (pure, no LLM).
- `deviceMatrix` — `ipadMissing` flag comparing iPhone vs iPad slot counts (pure).
- `ppoBrief` — whether the creative treatment count exceeds 3 (PPO independent-
  measurability threshold).

### 4.11 A6: per-dimension and whole-snapshot reuse

**What:** two layers of reuse in `score-listing`:

1. **Whole-snapshot cache** ([`audit-workflow.ts:354-358`](apps/server/src/mastra/workflows/audit-workflow.ts#L354-L358)):
   if `promptHash` and `rubricVersion` match the prior snapshot, return the
   cached report verbatim — zero LLM calls.

2. **Per-dimension cache** ([`audit-workflow.ts:380-409`](apps/server/src/mastra/workflows/audit-workflow.ts#L380-L409)):
   for each dimension, hash its specific inputs (listing fields + signals that
   dimension depends on, via `dimensionInputs()` in
   [`scoring/dimension-scorer.ts`](apps/server/src/scoring/dimension-scorer.ts)).
   If the hash matches the prior run, splice in the prior score + prose without
   calling the model. This eliminates variance for unchanged dimensions while
   re-scoring only what actually changed.

**`scoringVersion()`** ([`scoring/version.ts`](apps/server/src/scoring/version.ts)):
The reuse cache key is `hash(rubric weights + SCORER_VERSION)` — not just the
weights. A `codeScore`/`coarseOrdinalScore` change bumps `SCORER_VERSION`, which
changes the fingerprint, which forces re-scoring even on an unchanged listing.
This was the A7 residual fix: a scorer-code change was previously
served stale cached reports.

### 4.12 Cost governor (Phase B)

**What:** [`cost/governor.ts`](apps/server/src/cost/governor.ts) enforces three
caps via an in-process singleton:

1. **Re-entrancy guard** (2 s window) — if another audit run started less than
   2 seconds ago, `startRun()` returns `err('reentrant')` and the new run is
   refused before any LLM calls are made.
2. **Count cap** (2,000 metered calls/hr rolling window) — `preflight()` checks
   the rolling log before each upstream call.
3. **Wall-clock cap** (10 min) — a single run cannot exceed 10 minutes.

The `try/finally` in the `score-listing` step
([`audit-workflow.ts:571-573`](apps/server/src/mastra/workflows/audit-workflow.ts#L571-L573))
guarantees `endRun()` is called even on error.

**Why:** without a governor, a single misbehaving client could exhaust a daily
API budget in minutes. The governor is designed to be undetectable in tests
(all hermetic tests pass through a reset singleton).

### 4.13 D2 correction: multi-instance theme recommendations

**What:** `fix_complaint_theme` and `respond_to_reviews` are multi-instance
intents — one recommendation per distinct theme, not one global rec. The LLM
emits `{kind:'none'}` for these (per the skill's REFERENT RULES); the code
assigns the correct typed referents from `themeResult` in
[`memory/enrich-referents.ts`](apps/server/src/memory/enrich-referents.ts).

**Why:** without this, all `fix_complaint_theme` recs hashed to the same
`rec_key` (empty value_key for `{kind:'none'}`), so only one would survive
dedup. `enrichThemeReferents()` assigns `{kind:'theme', bucket, text}`
referents from `themeResult` positionally (first rec gets the top theme, second
rec gets the second theme, etc.) — stable across re-audits on unchanged reviews
because the order comes from `themeResult`, not from the model's prose.

For the `other` bucket, a vector-embedding similarity lookup
([`reviews/embedding.ts`](apps/server/src/reviews/embedding.ts)) matches the
theme text against prior `other:*` ledger entries to produce a stable
`resolvedKey`, preventing artificial dedup inflation across re-audits on
similar-but-reworded themes
([`audit-workflow.ts:423-438`](apps/server/src/mastra/workflows/audit-workflow.ts#L423-L438)).

---

## 5. Module deep-dives

### 5.1 Domain types ([`domain/`](apps/server/src/domain/))

The domain is the only layer that every other layer imports. It defines no
business logic — only Zod schemas and TypeScript types.

- **[`domain/result.ts`](apps/server/src/domain/result.ts)** — `Result<T,E>` discriminated
  union (`{ ok: true; value: T } | { ok: false; error: E }`). Expected failures
  (missing app, flaky scraper) live in the return type; exceptions are reserved
  for genuine bugs.
- **[`domain/app-url.ts`](apps/server/src/domain/app-url.ts)** — `parseAppStoreUrl()`
  handles every URL form Apple produces: canonical share URL, short form, legacy
  `itunes.apple.com`, and bare numeric IDs. Country defaults to `us` when the
  URL omits a storefront (Apple's own behaviour). `appStoreUrl()` produces the
  canonical URL from an `AppRef`.
- **[`domain/listing.ts`](apps/server/src/domain/listing.ts)** — `AppListing` is the
  canonical representation that every data source maps *into*. The `provenance`
  object records exactly which sources contributed (`itunes`, `crawler`,
  `reviews`, `competitors`, `observedFromCache`). Nothing downstream ever sees a
  raw API response.
- **[`domain/audit.ts`](apps/server/src/domain/audit.ts)** — `AuditReport`,
  `AuditDraft`, `ScoredDimension`, `Recommendation`, `ThemeResult`. The `Confidence`
  enum is defined here: `'observed' | 'inferred' | 'unavailable'`.
- **[`domain/recommendation.ts`](apps/server/src/domain/recommendation.ts)** —
  `LedgerRecommendation`, `IntentTag` enum, `Referent` discriminated union
  (`keyword | theme | country | reviewId | none`), `SINGLE_INSTANCE_INTENTS` set.
  The `Referent` tagged union is what makes illegal states unrepresentable — a
  `fix_complaint_theme` rec that carries `{kind:'keyword'}` is a type error.
- **[`domain/identity.ts`](apps/server/src/domain/identity.ts)** — `IdentityVersion`,
  `ConfidenceBand` (`high | medium | low`), `IdentitySource` (`resolved | human_confirmed`),
  `SOURCE_TIER_WEIGHT` (tier weights used in the tally), `ON_STORE_TIERS` set
  (used for the on-store cap in the band calculation).
- **[`domain/snapshot.ts`](apps/server/src/domain/snapshot.ts)** — `ListingSnapshot`,
  the immutable audit record. Holds `listing`, `signals`, `report`, `rubricVersion`,
  `promptHash`, `modelId`, plus optional blobs for B1/C4/D3/D-UI/F-K2 results
  (`visionResult`, `candidateResult`, `functionCompetitorSeeds`, `themeResult`,
  `competitorMiningResult`) — all stored as `z.unknown()` to remain forward-
  compatible.

### 5.2 Sources ([`sources/`](apps/server/src/sources/))

- **[`sources/itunes.ts`](apps/server/src/sources/itunes.ts)** — three free Apple
  endpoints: Lookup API (core metadata), Reviews RSS feed (recent customer
  reviews), Search API (category peers → competitor candidates). Maps raw JSON
  into domain types. The iOS keyword field, subtitle, and promotional text are
  deliberately absent — Apple's API never exposes them.
- **[`sources/http.ts`](apps/server/src/sources/http.ts)** — every outbound call
  passes through one helper with an abort-based timeout and bounded exponential-
  backoff retry. Distinguishes retryable (5xx, 429, network) from terminal (404)
  failures so callers don't retry a missing app forever.
- **[`sources/crawler/`](apps/server/src/sources/crawler/)** — `FirecrawlCrawler`
  fetches the App Store page to get subtitle and promotional text (which the
  iTunes API omits). `NullCrawler` is the Null Object. `getCrawler()` is the factory.
- **[`sources/websearch/websearch.ts`](apps/server/src/sources/websearch/websearch.ts)** —
  `WebSearchProbe` result type: `corroborated | searched_and_empty | errored`.
  Used by the ID-lite `footprint` family. `TavilyWebSearch` (primary) /
  `ExaWebSearch` (fallback) query their REST APIs through the gateway (7-day
  cache); `NoopWebSearch` is the stub for tests. Long identity fact-sheet queries
  are length-capped (Tavily 400s otherwise); mirror / aggregator domains
  (`app.sensortower.com` etc.) are suffix-match filtered before a corroboration
  result, and the surviving hostnames are logged for observability.
- **[`sources/function-competitors.ts`](apps/server/src/sources/function-competitors.ts)** —
  D3 function-grounded competitor discovery: seeds keywords from the resolved
  identity, calls AppKittie `getTopApps`, filters tombstoned competitors, then
  batch-looks up the surviving IDs via iTunes. Falls back silently when AppKittie
  is not keyed.
- **[`sources/competitor-tiering.ts`](apps/server/src/sources/competitor-tiering.ts)** —
  pure function that partitions competitors into tiers (direct / adjacent /
  aspirational) and maps per-keyword gaps.
- **[`sources/storefront-sweep.ts`](apps/server/src/sources/storefront-sweep.ts)** —
  optional multi-storefront fetch for localisation audits (runs parallel iTunes
  lookups across configured storefronts).

### 5.3 Scoring ([`scoring/`](apps/server/src/scoring/))

- **[`scoring/rubric.ts`](apps/server/src/scoring/rubric.ts)** — the rubric as a
  data table: 10 dimensions, each with `id`, `label`, `weight`, character limits,
  and checks. The weights, char limits, and checks live here and nowhere else —
  retuning touches no logic.
- **[`scoring/signals.ts`](apps/server/src/scoring/signals.ts)** — `computeSignals()`
  derives the `ListingSignals` object from a listing: title/subtitle char counts
  and utilisation, screenshot counts per device type, rating values, keyword
  field length, etc. All arithmetic, no LLM.
- **[`scoring/prompt.ts`](apps/server/src/scoring/prompt.ts)** — `buildAuditPrompt()`
  assembles the full LLM prompt: the rubric, the listing data, the signals fact
  sheet, the prior-context/identity injection, vision critiques (from B1), keyword
  candidates and gap analysis (from C4), theme analysis (from D2), competitor
  mining (from F-K2), and the ranked keyword opportunities.
- **[`scoring/dimension-scorer.ts`](apps/server/src/scoring/dimension-scorer.ts)** —
  `dimensionInputs()` (per-dimension input hash), `deriveConfidence()` (code-derived
  confidence overrides), `codeScore()` (fully-deterministic scores), and
  `coarseOrdinalScore()` (quantisation for mixed dimensions). `SCORER_VERSION`
  is bumped here when any scoring logic changes.
- **[`scoring/extract.ts`](apps/server/src/scoring/extract.ts)** — JSON extraction
  tolerating code fences, prose, and `<think>` blocks from reasoning models.
  On parse failure, scans backward for the largest valid JSON prefix so a
  mid-JSON truncation produces the best partial result rather than a hard crash.
- **[`scoring/score.ts`](apps/server/src/scoring/score.ts)** — `produceAuditDraft()`:
  calls the agent, extracts and validates the JSON, makes one repair call on
  schema miss.
- **[`scoring/aggregate.ts`](apps/server/src/scoring/aggregate.ts)** — `assembleReport()`:
  merges the agent's draft with code-derived confidence/scores, applies weights,
  normalises, groups recommendations.
- **[`scoring/version.ts`](apps/server/src/scoring/version.ts)** — `scoringVersion()`:
  `SHA-256(rubric weights + SCORER_VERSION)` → `RUBRIC_VERSION`. Used as the
  whole-snapshot cache key.
- **[`scoring/replay.ts`](apps/server/src/scoring/replay.ts)** — `replayOverallScore()`:
  the single definition of the weighted-average formula, shared by live assembly
  and zero-LLM rubric-weight replay.
- **[`scoring/proof-regime.ts`](apps/server/src/scoring/proof-regime.ts)** —
  `assignProofRegime()`: maps intent → proof regime (`ab_test | before_after_measure |
  seo_rank_watch | …`). Intent-level, not dimension-level.
- **[`scoring/candidates.ts`](apps/server/src/scoring/candidates.ts)** — C4 keyword
  candidate generation: integrates AppKittie volume data with title/subtitle gap
  analysis. `selectCandidateResult()` is the zero-LLM reuse path (mirrors
  `selectVisionResult` — returns stored result when listing text + competitor
  set are unchanged).

### 5.4 Memory ([`memory/`](apps/server/src/memory/))

- **[`memory/storage-client.ts`](apps/server/src/memory/storage-client.ts)** — the
  seam. Five methods: `putSnapshot`, `latestSnapshot`, `upsertRecommendation`,
  `recordOccurrence`, `ledger`, `appendIdentity`, `latestIdentity`,
  `maxIdentityVersion`, `tombstoneCompetitor`, `tombstones`.
- **[`memory/libsql-storage-client.ts`](apps/server/src/memory/libsql-storage-client.ts)** —
  LibSQL implementation. Uses the same DB file as Mastra's workflow serialisation.
  `latestIdentity` prefers `stage='full'` rows for semantic reads; `maxIdentityVersion`
  always returns the true MAX so version numbers stay monotonic
  ([`libsql-storage-client.ts`](apps/server/src/memory/libsql-storage-client.ts)).
- **[`memory/migrate.ts`](apps/server/src/memory/migrate.ts)** — idempotent schema
  migrations: `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN IF NOT EXISTS`.
  Each migration is a named step; run on every boot, safe to re-run.
- **[`memory/dedup.ts`](apps/server/src/memory/dedup.ts)** — `computeRecKey()`,
  `valueKeyFor()`, `normalizeValueKey()` (casefold + NFC + trim + plural rule),
  `findContradiction()`.
- **[`memory/audit-memory.ts`](apps/server/src/memory/audit-memory.ts)** —
  `persistAudit()`, `detectApplied()`, `changeDiff()`, `buildPriorContext()`,
  `expandAddKeywordRec()` (splits comma-joined `add_keyword` values into one
  rec per keyword — the LLM sometimes packs multiple keywords into one referent
  despite the single-keyword rule).
- **[`memory/enrich-referents.ts`](apps/server/src/memory/enrich-referents.ts)** —
  `enrichThemeReferents()`: assigns `{kind:'theme'}` and `{kind:'reviewId'}`
  referents from `themeResult` to `fix_complaint_theme` / `respond_to_reviews`
  recs that the LLM emitted with `{kind:'none'}`.
- **[`memory/ids.ts`](apps/server/src/memory/ids.ts)** — `newId(prefix)`: generates
  prefixed IDs (`snap_`, `rec_`, `idv_`) with random hex suffixes.

### 5.5 Identity ([`identity/`](apps/server/src/identity/))

- **[`identity/signals.ts`](apps/server/src/identity/signals.ts)** — `extractIdentitySignals()`:
  extracts `developer`, `developerSlug`, `bundleOrg` (reverse-DNS org from
  bundle ID), `marketingDomain`, `reviewCorpus`, `reviewCount`, `storeCategory`
  from an `AppListing`.
- **[`identity/domains.ts`](apps/server/src/identity/domains.ts)** — function-bucket
  clusters (maps Apple genre strings to function families); `divergenceBetween()`
  classifies the relationship between the store category and the model's function
  category as `cross_domain | niche_ambiguous | aligned`.
- **[`identity/resolve.ts`](apps/server/src/identity/resolve.ts)** — `resolveIdentity()`:
  the weighted-tally band calculator. Pure function of (signals + classification).
  See §4.9 for the algorithm.
- **[`identity/human-confirm.ts`](apps/server/src/identity/human-confirm.ts)** —
  `applyHumanDecision()`, `resolveWithHistory()`, `signalsMateriallyChanged()`.
  The re-ask rule: only re-ask when the stored `human_confirmed` identity's
  deterministic signals materially changed AND the fresh answer would flip the
  domain.
- **[`identity/id-full.ts`](apps/server/src/identity/id-full.ts)** — `runIdFull()`:
  vision-grounded identity augmentation. See §4.9 for the algorithm.
- **[`identity/identity-vision-client.ts`](apps/server/src/identity/identity-vision-client.ts)** —
  `IdentityVisionClient` implementations: `GeminiIdentityVisionClient` (live),
  `NoOpIdentityVisionClient` (stub; returns `creativeMatchesFunction=false` and
  `confidence='inferred'` so it never spuriously de-escalates a real escalation).

### 5.6 Vision ([`vision/`](apps/server/src/vision/))

- **[`vision/types.ts`](apps/server/src/vision/types.ts)** — `VisionResult`,
  `ScreenshotSetVerdict`, `IconVerdict`, `ScreenshotCritique`, `Labelled<T>`,
  `VisionResultSchema` (Zod schema with `passthrough()` on sub-objects for
  forward-compat).
- **[`vision/client.ts`](apps/server/src/vision/client.ts)** — `VisionClient`
  interface; `GeminiVisionClient`, `StubVisionClient`, `NoOpVisionClient`.
  Three call sites: `analyzeScreenshots`, `analyzeScreenshotSet`, `analyzeIcon`.
  Token budgets: `analyzeScreenshots` → 2000 tokens, `analyzeScreenshotSet` →
  1500 tokens (raised from 800 after mid-JSON truncation for 7-screenshot
  listings). All three use `reasoning_effort:'none'` to prevent Gemini 2.5 Flash
  thinking tokens from exhausting the budget.
  `#parseJson()` scans backward for the largest valid JSON prefix on parse failure,
  so the caller's `?? {}` defaults kick in rather than throwing.
- **[`vision/phash.ts`](apps/server/src/vision/phash.ts)** — `computeDHash()`,
  `dHashDistance()`. See §4.10 for algorithm details.
- **[`vision/analyze.ts`](apps/server/src/vision/analyze.ts)** — `runVision()`:
  assembles screenshot + icon URLs, calls the vision client, builds `VisionResult`.
  Competitor image URLs are empty arrays for now (competitor app IDs ≠ image
  URLs; B3/Phase D can enrich when competitor-detail fetches are added).
  Short-circuits when `screenshotUrls.length === 0` (Yahoo JP gap fix — skips
  model call, keeps `visionUsable` false, slot-count fallback).
- **[`vision/select.ts`](apps/server/src/vision/select.ts)** — `selectVisionResult()`:
  pure reuse function. URL-match → return stored `VisionResult`, zero LLM calls.
  The `_currentSignals` parameter is reserved for future signal-keyed reuse.
- **[`vision/secondary-uplifts.ts`](apps/server/src/vision/secondary-uplifts.ts)** —
  `runSecondaryUplifts()`: screenshot set analysis (duplicate detection,
  promotion candidate), device matrix, PPO brief. All pure computations except
  the `analyzeScreenshotSet` vision call.

### 5.7 Keywords ([`keywords/`](apps/server/src/keywords/))

- **[`keywords/asa-client.ts`](apps/server/src/keywords/asa-client.ts)** — the
  `KeywordProvider` seam; `GeminiKeywordProvider` is the implementation; returns
  a `NoopKeywordProvider` when no key is set.
- **[`keywords/appkittie-client.ts`](apps/server/src/keywords/appkittie-client.ts)** —
  AppKittie REST client for top-app lookups (D3) and keyword volume data (C4).
- **[`keywords/candidates.ts`](apps/server/src/keywords/candidates.ts)** — C4 candidate
  generation and gap analysis. `selectCandidateResult()` is the reuse path.
  `suppressCompetitorGapTerms()` removes competitor-gap terms for escalated apps
  when D3 did not provide function-grounded peers (prevents genre-mismatch noise).
- **[`keywords/linter.ts`](apps/server/src/keywords/linter.ts)** — keyword hygiene
  rules: character counts, repetition detection, plural/singular analysis.
- **[`keywords/opportunity.ts`](apps/server/src/keywords/opportunity.ts)** —
  `rankOpportunities()`: pure ranking of keyword candidates by opportunity score
  (volume × relevance / competition).
- **[`keywords/competitor-mining.ts`](apps/server/src/keywords/competitor-mining.ts)** —
  F-K2 competitor review mining: gated on D3 having provided function-grounded
  peers (prevents genre-mismatch noise). Mines competitor reviews for unmet needs
  and feature gaps. `selectCompetitorMining()` is the reuse path.

### 5.8 Reviews ([`reviews/`](apps/server/src/reviews/))

- **[`reviews/themes.ts`](apps/server/src/reviews/themes.ts)** — `analyzeThemes()`:
  one LLM pass over recent reviews → `ThemeAnalysisResult` with buckets, counts,
  exemplar review IDs, and a `versionDelta` flag. `selectThemeResult()` is the
  reuse path (reviews unchanged → no new LLM call). D-UI-2 revision: per-bucket
  synthesis (one insight per bucket sorted by count, exemplar quotes behind
  expander) replaced the previous per-phrasing data dump.
- **[`reviews/embedding.ts`](apps/server/src/reviews/embedding.ts)** — `EmbeddingProvider`
  seam + `resolveOtherThemeKey()`: cosine similarity lookup to match new `other`-
  bucket complaint themes against prior ledger entries for stable `resolvedKey`
  assignment.

### 5.9 Cost ([`cost/`](apps/server/src/cost/))

- **[`cost/governor.ts`](apps/server/src/cost/governor.ts)** — see §4.12.
- **[`cost/gateway.ts`](apps/server/src/cost/gateway.ts)** — `SourceGateway` /
  `PassthroughGateway`: the single chokepoint for **all** external HTTP fetches
  (iTunes, reviews, crawler, vision, AppKittie, embedding, web-search), tagged
  `{kind, upstream}`. Order per call: cache lookup → in-flight coalescing →
  `governor.preflight()` → pacer → real fetch → cache store — so a cache hit is
  genuinely free (no governor count, no pacer wait, no upstream call).
- **[`cost/cache.ts`](apps/server/src/cost/cache.ts)** — `LibSqlCache` (persistent
  `aso_cache` table), entity-keyed by upstream with per-upstream TTLs (iTunes 24h,
  reviews 2h, competitors 7d, web-search 7d). Caches **source HTTP bodies**, not
  LLM responses — the LLM is skipped instead by snapshot / per-dimension reuse
  (§4.11). `--fresh` bypasses via `skipCache`; `NoOpCache` for tests.
- **[`cost/pacer.ts`](apps/server/src/cost/pacer.ts)** — `SerialPacer`: a courtesy
  throttle for iTunes/reviews only (shared Apple IP), ≥3.5s spacing with a
  `Retry-After` floor. Concurrent callers serialise by claiming the slot before
  awaiting (not tied to the governor's window).

### 5.10 Mastra composition root ([`mastra/`](apps/server/src/mastra/))

- **[`mastra/index.ts`](apps/server/src/mastra/index.ts)** — wires together the
  `Mastra` instance with the agent, workflow, SSE routes, and LibSQL storage.
  `FileTransport` is the observability wiring for Studio Logs (added in the D2
  hardening commit; `MastraStorageExporter` was removed because it conflicts with
  LibSQL's suspend/resume — it does not support batch-creating metrics).
- **[`mastra/routes.ts`](apps/server/src/mastra/routes.ts)** — three endpoints:
  `POST /audit/identify` (step 1 + step 2 suspend, returns the confirmation card),
  `POST /audit/run` (step 2 resume + steps 3-4, streams SSE),
  `GET /audit/stream/:runId` (SSE event source).
- **[`mastra/skills/aso-audit.ts`](apps/server/src/mastra/skills/aso-audit.ts)** —
  the audit skill: rubric, scoring bands, output discipline, referent rules
  (REFERENT RULES section explicitly tells the model to emit `{kind:'none'}` for
  `fix_complaint_theme` and `respond_to_reviews` — the code assigns the referents
  from `themeResult`). Loaded as the agent's `instructions`.
- **[`mastra/agents/aso-auditor.ts`](apps/server/src/mastra/agents/aso-auditor.ts)** —
  the `asoAuditor` agent registration. Its instructions are the skill.
- **[`mastra/tools/identify-app.ts`](apps/server/src/mastra/tools/identify-app.ts)** —
  Mastra tool wrapping `fetchITunesCore`. Used as a workflow step via
  `createStep(tool)`.
- **[`mastra/tools/gather-listing.ts`](apps/server/src/mastra/tools/gather-listing.ts)** —
  Mastra tool that fans out across all data sources in parallel (iTunes core, Reviews
  RSS, Firecrawl page, Search API competitors) and assembles the canonical `AppListing`.
- **[`mastra/tools/resolve-identity.ts`](apps/server/src/mastra/tools/resolve-identity.ts)** —
  `buildFactSheet()` (formats the identity signal sheet for the prompt),
  `geminiClassifier()` (calls the LLM for function classification), `toIdentityVersion()`
  (maps `ResolvedIdentity` → `IdentityVersion` row).

---

## 6. Engineering practices

What a senior reviewer should notice:

- **Anti-corruption layer.** Three data sources (iTunes JSON, the reviews RSS
  feed, a Firecrawl page scrape) return wildly different shapes. None leaks
  past [`domain/listing.ts`](apps/server/src/domain/listing.ts) — every source
  maps *into* one canonical `AppListing`. The scoring engine only ever sees the
  domain model.

- **`Result<T,E>` for expected failures.** A missing app or a flaky scraper is
  an expected outcome, not an exception — so it lives in the return type
  ([`domain/result.ts`](apps/server/src/domain/result.ts)), where the compiler
  forces callers to handle it. Exceptions are reserved for genuine bugs.

- **Pattern vocabulary, applied where it earns its place.** Strategy (LLM,
  crawler, web search, vision client), Factory (`getLlmProvider`, `getCrawler`,
  `getVisionClient`), Null Object (`NullCrawler`, `NoOpVisionClient` — callers
  never branch on "is one configured?"), Anti-Corruption Layer, Generate-Validate-Repair.
  No pattern for its own sake.

- **Graceful degradation, with provenance.** iTunes core is the only hard
  dependency; reviews, competitors, the page crawl, vision, keywords, and
  competitor mining are all best-effort and fan out in parallel. What each run
  actually observed is recorded in `provenance`, and the audit is honest about
  the gaps.

- **Discriminated unions over flags.** Chat messages, dimension confidence,
  recommendation referents, and identity source are all tagged unions — rendering
  is one exhaustive `switch`, and illegal states are unrepresentable.

- **Rubric-as-data.** Weights, character limits, and checks live in one table
  ([`scoring/rubric.ts`](apps/server/src/scoring/rubric.ts)), read by the
  scoring engine, the prompt, and the UI. Retuning the framework touches no logic.

- **Strict TypeScript.** `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `verbatimModuleSyntax`, `isolatedModules` — and Zod validation at every
  external boundary (`safeParse`, not casts), so malformed data fails loudly
  at the seam, not deep in the scoring code.

- **Resilient I/O.** Every outbound call goes through one HTTP helper
  ([`sources/http.ts`](apps/server/src/sources/http.ts)) with an abort-based
  timeout and bounded exponential-backoff retry that distinguishes retryable
  (5xx, 429, network) from terminal (404) failures.

- **The pure core is unit-tested.** 508 hermetic tests cover URL parsing,
  signal computation, weighted aggregation, JSON extraction, identity resolution,
  dedup/contradiction, vision analysis, keyword candidates, and review theme
  analysis — the logic that must be correct — without needing the network or
  an LLM.

- **Idiomatic Mastra.** `createStep(tool)` composes tools as workflow steps;
  `suspend`/`resumeStream` drives the human gate; `registerApiRoute` serves the
  SSE endpoints. The framework is used the way its docs intend.

- **Honest, actionable errors.** A failure surfaces a message a user can act
  on — *"Check that LLM_API_KEY (a Google AI Studio key, starting with 'AIza')
  is set in .env"*, not a raw stack trace.

- **Reuse before recompute, everywhere.** Every expensive sub-computation has a
  `select*` companion (`selectVisionResult`, `selectCandidateResult`,
  `selectThemeResult`, `selectFunctionCompetitors`, `selectCompetitorMining`)
  that returns the stored result when the relevant inputs haven't changed.
  The whole-snapshot cache is the outermost ring; per-dimension hashing is the
  next; individual `select*` functions are the innermost. Together they ensure
  a re-audit on an unchanged listing costs zero LLM calls.
