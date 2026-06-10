# Codebase Map — ASO Audit Agent

A full-stack AI agent that audits iOS App Store listings across 10 dimensions, streams results to a chat UI, and produces scored recommendations. Built on Mastra (agent/workflow orchestration), React + Vite (UI), and Ollama-compatible LLMs.

---

## Repository Layout

```
/
├── apps/
│   ├── server/          # Mastra backend — workflow, agent, scoring, data sources
│   └── web/             # React + Vite frontend — chat UI
├── package.json         # Root workspace; concurrently runs both apps
├── tsconfig.base.json   # Shared TS config (ES2022, strict, noUncheckedIndexedAccess)
├── Dockerfile           # Single-container build (Node 22 slim)
├── docker-compose.yml   # Exposes ports 5173 (web) and 4111 (Mastra)
├── .env                 # Runtime secrets (not committed)
├── .env.example         # Required variable template
├── README.md            # Quick-start guide
├── DESIGN.md            # Architecture decisions and pattern vocabulary
└── task.md              # Original brief / requirements
```

---

## How It Works

The audit runs as a four-step Mastra workflow with one human confirmation gate:

```
URL input
    ↓
1. identifyStep   — parse URL → fetch iTunes metadata → AppSummary
    ↓
2. confirmStep    — SUSPEND: send summary to UI; wait for user Yes/No
    ↓ (Yes)
3. gatherStep     — fan-out: iTunes + reviews + competitors + page crawl → AppListing
    ↓
4. scoreStep      — compute signals (pure code) → call LLM agent → validate → assemble
    ↓
AuditReport (0–100 score, 10 dimensions, 9–15 recommendations, competitor table)
```

The UI talks to the workflow over two HTTP calls and one Server-Sent Events stream.

---

## Apps

### `apps/server/` — Backend

**Entry point:** `src/mastra/index.ts`
**Dev script:** `npm run dev` (Mastra dev server on port 4111)

#### Internal Layer Map

| Layer | Path | Responsibility |
|---|---|---|
| Domain | `src/domain/` | Canonical types and error handling |
| LLM | `src/llm/` | LLM provider strategy and factory |
| Scoring | `src/scoring/` | Rubric, signals, prompts, scoring, assembly |
| Sources | `src/sources/` | iTunes API, Firecrawl crawler, HTTP utilities |
| Mastra | `src/mastra/` | Agent, workflow, tools, API routes |

---

### `apps/web/` — Frontend

**Entry point:** `src/main.tsx`
**Dev script:** `npm run dev` (Vite dev server on port 5173; proxies `/audit/*` to 4111)

---

## Server: File-by-File

### `src/domain/`

#### [result.ts](apps/server/src/domain/result.ts)
Railway-oriented error handling.
- **`Result<T, E>`** — discriminated union `{ ok: true, value: T } | { ok: false, error: E }`
- **`ok(value)`**, **`err(error)`** — constructors
- **`isOk(r)`** — type guard

#### [app-url.ts](apps/server/src/domain/app-url.ts)
App Store URL parsing and normalisation.
- **`AppRef`** — `{ appId: string, country: string }`
- **`parseAppStoreUrl(input)`** → `Result<AppRef>` — accepts canonical URLs, short links, legacy iTunes links, and bare numeric IDs
- **`appStoreUrl(ref)`** → canonical URL string

#### [listing.ts](apps/server/src/domain/listing.ts)
Canonical domain model for an app listing (anti-corruption layer over three external sources).
- **`Review`** — customer review (author, rating, title, body, date)
- **`Competitor`** — app metadata for comparison (name, appId, rating, ratingCount, price, screenshotCount)
- **`Provenance`** — tracks which sources contributed (`itunesCore`, `crawler`, `reviews`, `competitors`)
- **`AppListing`** — the full aggregated model (name, developer, icon, genres, price, description, subtitle, promotionalText, screenshots, ratings, reviews, competitors, provenance)
- **`AppSummary`** — thin projection for the confirmation card (name, developer, icon, genre, rating, country)
- **`toSummary(listing)`** → extract AppSummary

#### [audit.ts](apps/server/src/domain/audit.ts)
Shape contracts for the audit pipeline (all validated with Zod).
- **`DIMENSION_IDS`** — const array of 10 dimension string IDs
- **`Confidence`** — `'observed' | 'inferred' | 'unavailable'`
- **`DimensionScore`** — per-dimension result: id, score (0–10), confidence, findings, evidence[]
- **`Recommendation`** — single actionable item: category (`quick-win | high-impact | strategic`), dimension, title, rationale, before/after text, evidence
- **`CompetitorRow`** — one row in the competitor table: name, rating, positioning, edge
- **`AuditDraft`** — raw LLM output before weighting: headline, dimensions[], recommendations[], competitorComparison, limitations[]
- **`ScoredDimension`** — dimension enriched with rubric metadata: label, weight, weightedPoints
- **`AuditReport`** — final report: app name/url, score (0–100), overallConfidence, dimensions[], recommendations{}, competitorComparison, limitations[], metadata

---

### `src/llm/`

#### [provider.ts](apps/server/src/llm/provider.ts)
Strategy interface isolating the agent from any specific LLM backend.
- **`ChatModel`** — AI SDK language model type
- **`LlmProvider`** interface:
  - `id`, `modelId`, `endpoint` — identifiers and diagnostics
  - `model()` → `ChatModel` — returns the AI SDK model instance
  - `reachable()` → `Promise<boolean>` — liveness check

#### [ollama.ts](apps/server/src/llm/ollama.ts)
Concrete LLM implementation for Ollama (both Cloud and local).
- **`OllamaConfig`** — `{ baseUrl, model, apiKey }`
- **`OllamaProvider`** — implements `LlmProvider`
  - Both Ollama Cloud (`https://ollama.com/v1`) and local (`http://localhost:11434/v1`) speak the OpenAI-compatible protocol
  - `reachable()` — 5-second timeout GET to `/models` endpoint

#### [index.ts](apps/server/src/llm/index.ts)
Factory / dependency injection.
- **`getLlmProvider()`** → `LlmProvider` — reads `LLM_PROVIDER` env var, returns the correct implementation; adding a new provider means one class + one `case`

---

### `src/scoring/`

#### [rubric.ts](apps/server/src/scoring/rubric.ts)
The 10-dimension ASO rubric as a data structure.
- **`RubricDimension`** — `{ id, label, weight, charLimit?, checks[] }`
- **`RUBRIC`** — 10-element array, total weight 110 (normalised in `aggregate.ts`):

| ID | Label | Weight | Char Limit |
|---|---|---|---|
| `title` | Title | 20 | 30 |
| `subtitle` | Subtitle | 15 | 30 |
| `keyword-field` | Keyword Field | 15 | 100 |
| `description` | Description | 10 | — |
| `screenshots` | Screenshots | 15 | — |
| `preview-video` | Preview Video | 5 | — |
| `ratings-reviews` | Ratings & Reviews | 15 | — |
| `icon` | Icon | 5 | — |
| `conversion-signals` | Conversion Signals | 5 | — |
| `competitive-position` | Competitive Position | 5 | — |

- **`TOTAL_WEIGHT`** — 110
- **`rubricFor(id)`** — lookup by dimension ID

#### [signals.ts](apps/server/src/scoring/signals.ts)
Pure, deterministic fact-sheet computation. All arithmetic the LLM should not have to do.
- **`ListingSignals`** — comprehensive metrics interface:
  - **Title:** value, length, limit, utilization%, overLimit
  - **Subtitle:** observable, value, length, limit, utilization%, wordsSharedWithTitle
  - **Keyword field:** `observable: false`, note (always inferred)
  - **Description:** charCount, lineCount, aboveFold (first ~230 chars)
  - **Screenshots:** iphoneCount, ipadCount, slotsUsedOf10
  - **Preview video:** observable, present
  - **Ratings:** allTimeAverage, allTimeCount, currentVersionAverage, currentVersionCount, reviewSampleSize, reviewSampleAverage, negativeReviewShare
  - **Icon:** present
  - **Conversion:** promotionalTextObservable, hasPromotionalText, hasReleaseNotes, releaseNotesLength, daysSinceLastUpdate
  - **Competitive:** competitorCount
- **`words(text)`** — deduplicated, lowercased, 3+ character words
- **`computeSignals(listing)`** → `ListingSignals`

#### [aggregate.ts](apps/server/src/scoring/aggregate.ts)
Weighted scoring — all arithmetic in code, never at the mercy of LLM mental math.
- **`assembleReport(app, draft)`** → `AuditReport`
  - Only "assessable" dimensions (`confidence !== 'unavailable'`) contribute to the total
  - Weighted total: `Σ(score × weight) / Σ(assessable weights)` → 0–100
  - Clamps scores 0–10, rounds weighted points to 1 decimal
  - Groups recommendations by category

#### [prompt.ts](apps/server/src/scoring/prompt.ts)
Prompt construction as pure functions — reviewable and testable.
- **`textFields(listing)`** — formats title, subtitle, description, promotional text, etc.
- **`reviewSample(listing)`** → bullet-point rendering of recent reviews
- **`competitors(listing)`** → competitor list with ratings, screenshot counts, prices
- **`rubricChecks()`** → full rubric with dimension checks
- **`AUDIT_JSON_SHAPE`** — exact JSON structure the model must return (kept as a constant)
- **`buildAuditPrompt(listing, signals)`** → complete prompt (header → text fields → signals fact sheet → competitors → reviews → rubric → output format)
- **`buildRepairPrompt(badOutput, errorDetail)`** → follow-up prompt for the single repair attempt

#### [extract.ts](apps/server/src/scoring/extract.ts)
Extracts a JSON object from raw LLM text, tolerating noise.
- **`extractJsonObject(text)`** → `string | null`
  - Strips `<think>` blocks (reasoning models)
  - Strips markdown fences
  - Brace-matches from first `{` to balanced `}`, handling strings and escaped quotes

#### [score.ts](apps/server/src/scoring/score.ts)
Generate → Validate → Repair orchestration.
- **`ParseAttempt`** — `{ draft, error, rawJson }` — tracks each attempt
- **`parseDraft(text)`** → `ParseAttempt` — extract JSON, parse, validate with Zod
- **`generate(agent, prompt)`** → `string` — single LLM generation call
- **`produceAuditDraft(agent, listing)`** → `Promise<AuditDraft>`
  - First pass: generate → extract → validate
  - On failure: one repair attempt (feeds exact Zod errors back to the model)
  - Throws if both attempts fail

---

### `src/sources/`

#### [http.ts](apps/server/src/sources/http.ts)
Centralised HTTP I/O with retry and timeout.
- **`SourceError`** — carries source name, message, `retryable` flag, cause
- **`fetchWithRetry(url, opts)`** → `Promise<Response>`
  - 12s timeout, 2 retries, bounded exponential backoff
  - Retryable: 5xx, 429, network errors
  - Terminal: 4xx (never retries 404)
- **`fetchJson<T>(url, opts)`** → `Promise<T>` — `fetchWithRetry` + JSON parse

#### [itunes.ts](apps/server/src/sources/itunes.ts)
Apple's three free public APIs.
- **`ITunesCore`** — subset of AppListing from iTunes Lookup API
- **`fetchITunesCore(ref)`** → `Result<ITunesCore>` — `/lookup?id=…&country=…`
- **`fetchReviews(ref, limit=25)`** → `Promise<Review[]>` — iTunes RSS feed (best-effort, never throws)
- **`fetchCompetitors(ref, searchTerm, limit=4)`** → `Promise<Competitor[]>` — iTunes Search by primary genre, filters self out

#### [crawler/crawler.ts](apps/server/src/sources/crawler/crawler.ts)
Strategy interface for page scraping.
- **`ListingExtras`** — `{ subtitle, promotionalText, hasPreviewVideo }` — fields only visible on the page
- **`ListingCrawler`** — `{ id, available, scrape(url) }` — never throws; returns null on failure

#### [crawler/firecrawl.ts](apps/server/src/sources/crawler/firecrawl.ts)
Firecrawl integration for page-only metadata.
- **`FirecrawlCrawler`** — implements `ListingCrawler`
  - POSTs to `https://api.firecrawl.dev/v2/scrape` with JSON extraction mode
  - 45s timeout, best-effort (returns null on any error)

#### [crawler/none.ts](apps/server/src/sources/crawler/none.ts)
Null Object for when Firecrawl is not configured.
- **`NullCrawler`** — always returns null; audit proceeds on iTunes data alone

#### [crawler/index.ts](apps/server/src/sources/crawler/index.ts)
Crawler factory.
- **`getCrawler()`** → `ListingCrawler` — Firecrawl if `FIRECRAWL_API_KEY` is set, else NullCrawler

#### [index.ts](apps/server/src/sources/index.ts)
Two public entry points used by the workflow tools.
- **`resolveSummary(ref)`** → `Result<AppSummary>` — one iTunes call; used by `identifyStep`
- **`resolveListing(ref)`** → `Result<AppListing>` — full fan-out
  - iTunes core (required; blocks if fails)
  - Reviews, competitors, crawler extras in parallel (all best-effort)
  - Merges all sources into one listing; validates against `AppListingSchema`
  - Provenance records what was actually observed

---

### `src/mastra/`

#### [index.ts](apps/server/src/mastra/index.ts)
Composition root — the Mastra instance.
- Registers: `asoAuditor` agent, `asoAuditWorkflow` workflow
- Storage: `LibSQLStore` (`./aso-audit.db`) — persists suspended workflow state
- Logger: `PinoLogger`
- API routes: `auditRoutes` (custom Hono routes)

#### [agents/aso-auditor.ts](apps/server/src/mastra/agents/aso-auditor.ts)
The single LLM agent.
- id: `aso-auditor`
- instructions: `ASO_AUDIT_SKILL` (107-line markdown rubric injected verbatim)
- model: from `getLlmProvider()`
- No tools — all data is pre-gathered by the workflow before the agent is called

#### [skills/aso-audit.ts](apps/server/src/mastra/skills/aso-audit.ts)
The agent's system prompt / skill document.
- Explains the agent's role and expected input/output
- Defines confidence levels: `observed | inferred | unavailable`
- Scoring bands: 9–10 excellent, 7–8 good, 4–6 mediocre, 0–3 poor
- Scoring guidance for all 10 dimensions
- Recommendation discipline: 9–15 total, three categories, cite evidence, before/after text required

#### [tools/identify-app.ts](apps/server/src/mastra/tools/identify-app.ts)
Identifies an app from a URL.
- **`identifyApp(url)`** — pure logic: parse URL → fetch iTunes core → return AppSummary
- **`identifyAppTool`** — `createTool` wrapper (input: URL string; output: AppSummary)

#### [tools/gather-listing.ts](apps/server/src/mastra/tools/gather-listing.ts)
Gathers the full listing data.
- **`gatherListing(appId, country)`** — calls `resolveListing`
- **`gatherListingTool`** — `createTool` wrapper (input: appId + country; output: AppListing)

#### [workflows/audit-workflow.ts](apps/server/src/mastra/workflows/audit-workflow.ts)
The 4-step orchestration pipeline.

| Step | Type | Description |
|---|---|---|
| `identifyStep` | tool-wrapped | Parse URL, fetch iTunes core, return AppSummary |
| `confirmStep` | custom (suspend/resume) | Suspend → UI shows confirmation card → resume on Yes or abandon on No |
| `gatherStep` | tool-wrapped | Fan-out to iTunes, RSS, Firecrawl → merged AppListing |
| `scoreStep` | custom | Check LLM reachable → compute signals → call agent → validate/repair → assemble |

Input schema: `{ url: string }` — Output schema: `AuditReport`

#### [routes.ts](apps/server/src/mastra/routes.ts)
Custom Hono routes registered with the Mastra server.
- **`pendingRuns`** — `Map<runId, run>` — in-process cache of suspended runs

| Route | Method | Purpose |
|---|---|---|
| `/audit/health` | GET | Returns LLM reachability + crawler availability — UI capability probe |
| `/audit/identify` | POST | Start workflow, suspend at confirm step, return `{ runId, summary }` |
| `/audit/run` | POST | Resume workflow, stream SSE events: `progress` → `report` or `error` → `done` |

SSE event types: `progress` `{ phase, message }`, `report` `AuditReport`, `error` `{ message }`, `done`

---

## Web: File-by-File

### `src/lib/`

#### [types.ts](apps/web/src/lib/types.ts)
Wire types for HTTP communication (redeclared from server domain, not imported directly).
- `AppSummary`, `Confidence`, `ScoredDimension`, `Recommendation`, `CompetitorRow`, `AuditReport`, `ProgressEvent`

#### [api.ts](apps/web/src/lib/api.ts)
Client-side API surface.
- **`identifyApp(url)`** → `Promise<{ runId, summary }>`
- **`runAudit(runId, handlers)`** → `Promise<void>` — SSE consumer; dispatches `onProgress`, `onReport`, `onError`
- **`fetchHealth()`** → `Promise<Health>`

#### [format.ts](apps/web/src/lib/format.ts)
Presentation helpers.
- **`scoreTone(0–10)`** → `{ bar, text, badge }` — colour palette per score range
- **`overallTone(0–100)`** → same (normalises to 0–10 first)
- **`formatCount(n)`** → compact notation (39.9M, 1.2K)
- **`formatRating(n)`** → one decimal, or em dash for null
- **`confidenceLabel(confidence)`** → human-readable string

### `src/hooks/`

#### [useAudit.ts](apps/web/src/hooks/useAudit.ts)
State machine hook for the chat flow.
- **`ChatMessage`** discriminated union — `user | agent | confirmation | progress | report | error`
- **`AuditStatus`** — `'idle' | 'identifying' | 'confirming' | 'auditing' | 'done'`
- **`useAudit()`** returns:
  - `messages`, `status`, `busy`
  - **`submitUrl(url)`** — add user message → call `identifyApp` → add confirmation card
  - **`confirm()`** — call `runAudit`, stream SSE to message handlers
  - **`reject()`** — reset to idle

### `src/components/`

| File | Purpose |
|---|---|
| [App.tsx](apps/web/src/components/App.tsx) | Top-level shell: Header (title + health status), scrolling conversation, Composer, auto-scroll |
| [Composer.tsx](apps/web/src/components/Composer.tsx) | URL input field, Audit button, Spotify example link |
| [ConfirmationCard.tsx](apps/web/src/components/ConfirmationCard.tsx) | Shows app icon, name, developer, genre, rating, country; Yes/Not That buttons |
| [ProgressTrace.tsx](apps/web/src/components/ProgressTrace.tsx) | Ordered list of SSE progress events; pulsing dot for active phase |
| [ScoreCard.tsx](apps/web/src/components/ScoreCard.tsx) | SVG progress ring (overall 0–100 score) + dimension bars with confidence badges |
| [Recommendations.tsx](apps/web/src/components/Recommendations.tsx) | Three sections (Quick Wins, High-Impact, Strategic); before/after diffs with red/green highlights |
| [CompetitorTable.tsx](apps/web/src/components/CompetitorTable.tsx) | Summary prose + table: Competitor, Rating, Positioning, Their edge |
| [ReportView.tsx](apps/web/src/components/ReportView.tsx) | Composes ScoreCard + Recommendations + CompetitorTable + limitations + metadata |

---

## Environment Variables

From [.env.example](.env.example):

| Variable | Required | Description |
|---|---|---|
| `LLM_PROVIDER` | Yes | Provider identifier (`ollama`) |
| `LLM_BASE_URL` | Yes | Ollama Cloud `https://ollama.com/v1` or local `http://localhost:11434/v1` |
| `LLM_MODEL` | Yes | Model name e.g. `gemma4:31b-cloud` or `gemma3:12b` |
| `LLM_API_KEY` | Cloud only | API key from `ollama.com/settings/keys` |
| `FIRECRAWL_API_KEY` | Optional | Enables subtitle/promotional text extraction; audit works without it |
| `PORT` | Optional | Mastra server port (default `4111`) |

---

## Tests

Located in `apps/server/src/` alongside source files, run with `vitest`.

| File | Coverage |
|---|---|
| `domain/app-url.test.ts` | URL parsing — canonical, short, legacy, bare ID, invalid inputs |
| `scoring/signals.test.ts` | Signal computation — character counts, utilization, word overlap, rating averages |
| `scoring/aggregate.test.ts` | Weighted scoring — normalization, unavailable dimension exclusion, clamping |
| `scoring/extract.test.ts` | JSON extraction — markdown fences, `<think>` blocks, balanced braces |

All 35 tests cover deterministic logic only (no network, no LLM calls).

---

## Key Architectural Decisions

**Workflow over pure agent** — The audit is a fixed pipeline with a human gate, not an open-ended agent loop. Mastra's suspend/resume handles the confirmation step cleanly.

**Facts in code, judgment in LLM** — All character counts, utilization percentages, rating averages, and screenshot counts are computed before the prompt is built. The model receives these as "AUTHORITATIVE" signals and supplies only interpretation and recommendations.

**Generate → Validate → Repair** — The agent output is validated against a Zod schema. On failure, the exact validation errors are fed back for one repair attempt before the workflow throws.

**Strategy seams** — `LlmProvider` and `ListingCrawler` are interfaces with factory functions. Adding a new LLM backend or scraper means one class + one factory case; nothing else changes.

**Anti-corruption layer** — Three external data sources (iTunes Lookup API, iTunes RSS, Firecrawl) all map into `AppListing`. Nothing outside `src/sources/` knows about any of them.

**Best-effort sources** — Reviews, competitors, and the page crawler are all best-effort. The audit proceeds with reduced confidence if any fail; `Provenance` records what was actually observed.

**Weighted scoring in code** — The 0–100 headline is computed with `assembleReport`, not by asking the LLM to add up numbers. The 10 dimension weights sum to 110; only "assessable" dimensions contribute, normalizing the denominator automatically.
