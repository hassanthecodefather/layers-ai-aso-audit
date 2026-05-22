# Design & Engineering Notes

This document covers **what was built**, **how it maps to the take-home
brief**, and the **engineering practices** behind it. For setup, see the
[README](README.md).

---

## 1. What was built

A conversational ASO (App Store Optimization) audit agent. The user pastes an
Apple App Store URL; the app fetches surface metadata, confirms the app with
the user, runs a full ten-dimension audit, and renders a prioritised report.

The flow is a four-step **Mastra workflow** with one human-in-the-loop gate:

```
identify-app ─▶ confirm-app ──suspend──▶ [user confirms] ─▶ gather-listing ─▶ score-listing
```

1. **`identify-app`** — resolves the URL to surface metadata (name, developer,
   icon, category, rating) via Apple's free iTunes Lookup API.
2. **`confirm-app`** — the workflow **`suspend()`s**. Its state serialises to
   LibSQL; the UI shows an *"Is this the app you meant?"* card and waits.
3. **`gather-listing`** — on confirmation the workflow resumes, fanning out
   across every data source into one canonical listing.
4. **`score-listing`** — computes deterministic signals, asks the auditor
   agent for a structured judgement, and assembles the report.

Progress streams to the browser over Server-Sent Events the whole time.

### The Mastra primitives

The brief asked for *"idiomatic use of agents, tools, workflows, and skills."*

| Primitive | Where |
|---|---|
| **Agent** | `aso-auditor` — scores the ten dimensions; its instructions *are* the audit skill |
| **Tools** | `identify-app`, `gather-listing` — composed directly as workflow steps via `createStep(tool)` |
| **Workflow** | `aso-audit` — the four-step pipeline, with `suspend`/`resume` for the human gate |
| **Skill** | `mastra/skills/aso-audit.ts` — the audit framework (rubric, scoring bands, output discipline), loaded as the agent's instructions |

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
| The 10-dimension weighted rubric, scored 0–100 | `scoring/rubric.ts` (rubric-as-data) + `scoring/aggregate.ts` (weighted, normalised) |
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

---

## 3. Architecture

The codebase is a layered monorepo. Each layer has one job and a typed seam to
the next.

```
apps/
  server/
    src/
      domain/      Canonical types — AppListing, AuditReport, URL parsing, Result
      llm/         LLM Strategy — LlmProvider interface + OllamaProvider + factory
      sources/     Data layer — iTunes adapter, HTTP retry, parallel fan-out
        crawler/   Crawler Strategy — ListingCrawler + Firecrawl / Null
      scoring/     Rubric, deterministic signals, prompt, JSON extraction, aggregation
      mastra/      Agent, tools, workflow, skill, SSE routes, composition root
  web/             Vite + React + Tailwind chat UI
```

Two **Strategy seams** isolate the volatile, third-party parts:

- **LLM** (`src/llm/`) — an `LlmProvider` interface; `OllamaProvider` is the
  implementation (covering Ollama Cloud *and* local). `getLlmProvider()` is the
  factory. Adding a backend = one class + one `case`.
- **Crawler** (`src/sources/crawler/`) — a `ListingCrawler` interface;
  `FirecrawlCrawler` is the real one, `NullCrawler` the no-op fallback.

The agent, workflow and data layer depend only on these interfaces — never on
"Ollama" or "Firecrawl" directly.

---

## 4. Key decisions

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
(`scoring/signals.ts`, `scoring/aggregate.ts`). The agent receives those as an
authoritative *fact sheet* and supplies only judgement. Models are unreliable
at counting and averaging — this removes that failure mode entirely.

### 4.3 The rubric sums to 110 — so normalise
The brief's weight column adds to 110, not 100. Rather than silently drop a
dimension, all ten are kept and the score is **normalised**:
`Σ(score·weight) / Σ(weight)`. This is a true 0–100 regardless — and it also
gracefully handles a dimension dropping out when the crawler isn't configured.

### 4.4 Honest confidence levels
The iOS keyword field is **not public** — neither Apple's API nor the web page
exposes it. Each dimension carries a confidence: `observed`, `inferred` (the
keyword field — scored by inference and clearly flagged), or `unavailable`
(excluded from the weighted total). The report states its own limitations
rather than bluffing.

### 4.5 Owned structured output: generate → validate → repair
Providers don't reliably enforce a schema via `response_format` — Ollama, in
testing, returned valid-but-wrong-shaped JSON. So `scoring/score.ts` owns it:
ask for the JSON, extract it (tolerating code fences, prose and reasoning-model
`<think>` blocks), validate with Zod, and on a schema miss make exactly one
repair call with the validation errors fed back.

### 4.6 Strategy abstractions for the swappable parts
The LLM and the crawler are the two pieces most likely to change (and the two
the brief itself left open). Each sits behind an interface with a factory, so
swapping a provider is a config change, not a refactor.

### 4.7 Custom SSE routes over the generic client SDK
The suspend/resume flow is cleaner with the *server* controlling the run; the
browser consumes two endpoints and an SSE stream. Same-origin via a Vite proxy
— no CORS, no backend URL in the client.

---

## 5. Engineering practices that stand out

What a senior reviewer should notice:

- **Anti-corruption layer.** Three data sources (iTunes JSON, the reviews RSS
  feed, a Firecrawl page scrape) return wildly different shapes. None leaks
  past `domain/listing.ts` — every source maps *into* one canonical
  `AppListing`. The scoring engine only ever sees the domain model.

- **`Result<T,E>` for expected failures.** A missing app or a flaky scraper is
  an expected outcome, not an exception — so it lives in the return type,
  where the compiler forces callers to handle it. Exceptions are reserved for
  genuine bugs.

- **Pattern vocabulary, applied where it earns its place.** Strategy (LLM,
  crawler), Factory (`getLlmProvider`, `getCrawler`), Null Object
  (`NullCrawler` — callers never branch on "is one configured?"),
  Anti-Corruption Layer, Generate-Validate-Repair. No pattern for its own sake.

- **Graceful degradation, with provenance.** iTunes core is the only hard
  dependency; reviews, competitors and the page crawl are best-effort and fan
  out in parallel. What each run actually observed is recorded in
  `provenance`, and the audit is honest about the gaps.

- **Discriminated unions over flags.** Chat messages and dimension confidence
  are tagged unions — rendering is one exhaustive `switch`, and illegal states
  are unrepresentable.

- **Rubric-as-data.** Weights, character limits and checks live in one table
  (`scoring/rubric.ts`), read by the scoring engine, the prompt and the UI.
  Retuning the framework touches no logic.

- **Strict TypeScript.** `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `verbatimModuleSyntax`, `isolatedModules` — and Zod validation at every
  external boundary (`safeParse`, not casts), so malformed data fails loudly
  at the seam, not deep in the scoring code.

- **Resilient I/O.** Every outbound call goes through one HTTP helper with an
  abort-based timeout and bounded exponential-backoff retry that distinguishes
  retryable (5xx, 429, network) from terminal (404) failures.

- **The pure core is unit-tested.** 35 tests cover URL parsing, signal
  computation, weighted aggregation and JSON extraction — the logic that must
  be correct — without needing the network or an LLM.

- **Idiomatic Mastra.** `createStep(tool)` composes tools as workflow steps;
  `suspend`/`resumeStream` drives the human gate; `registerApiRoute` serves
  the SSE endpoints. The framework is used the way its docs intend.

- **Honest, actionable errors.** A failure surfaces a message a user can act
  on — *"start Ollama and run `ollama pull …`"*, not a raw stack trace.
