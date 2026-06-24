# ASO Agent — Implementation Plan (Beta)

Companion to `specification.md` / `specification.html` **v1.3.1**. This is the *how-to-build*; the spec is the *contract*. Scope: **the beta in full** — ID-lite + P1–P5 + net-new uplifts, for a single operator. P6 → North Star are sketched at the end and planned in detail when their tier is reached (per the spec's "don't build for a scale you haven't reached").

## Working agreement (decisions locked for this plan)

- **TDD against §F.** Every phase starts by writing its Build-Appendix §F acceptance test (red), then implements to green. `vitest` + `*.test.ts` already exist in `apps/server`.
- **Gemini-only.** Ollama is removed (spec §H #7 overridden). Gemini serves text scoring, vision (P2), and embeddings (P4 fallback).
- **Keys live now:** paid **Gemini**, **Firecrawl**. **Not yet keyed:** web-search (Exa/Tavily), Apple Search Ads. Anything depending on a missing key is **built behind its seam and stubbed**, with the real client a one-task follow-up when the key lands. The spec's confidence ladder + tri-state probe make this honest (a stubbed source reports `searched-and-empty`, never fakes data).
- **Definition of Done, per phase:** its §F acceptance test is green, both editions of the spec already describe it, and no `*.test.ts` regressions.
- **Two spec↔code reconciliations** (spec §G) are scheduled at their phases: Ollama removal (Phase 0) and the `rubric.ts:83` OCR line (Phase B).

Legend: **[live]** builds against a real key · **[stub]** seam built now, real client deferred · **[pure]** no external dependency.

---

## Phase 0 · Groundwork & reconciliation (½–1 day)

**Goal:** Gemini-only, green existing tests, migration runner ready — nothing new yet.

- **0.1 Remove Ollama (reconciliation §G #2).** Delete `llm/ollama.ts`; drop the Ollama branch from the `llm/provider.ts` / `llm/index.ts` switch; **flip the defaults in `llm/index.ts`** — today `LLM_PROVIDER` defaults to `ollama` and `DEFAULT_MODEL = 'gemma3'`, so without this change `getLlmProvider()` resolves to a now-deleted provider and the app won't start. Make Google the only/default provider. Rewrite the `audit-workflow.ts` `score-listing` error text to reference Gemini, not "start Ollama / ollama pull".
- **0.2 Gemini reachability + one beta model.** Confirm `llm/google.ts` reads the key from `.env`; `reachable()`, `modelId`/`endpoint` work. **Pin one beta model** — `gemini-2.5-flash` is already the Google default (`llm/index.ts: DEFAULT_GOOGLE_MODEL`); keep it, or set a more capable id if judgement quality needs it. Add a startup check that the pinned model responds. *(Cheap/capable model-tiering is a **P7** concern — the current `LlmProvider` carries a single `modelId`, so don't build tiering now.)*
- **0.3 Migration runner.** A tiny `memory/migrate.ts` that creates the `aso_*` tables (idempotent, `CREATE TABLE IF NOT EXISTS`). Empty for now; each phase adds its tables.
- **Tests:** existing suite stays green with Ollama gone (the one regression risk); add a smoke test that a full audit runs end-to-end on Gemini.
- **DoD:** `vitest` green; an audit of one real URL completes with Gemini only.

---

## Phase A · ID-lite + P1 Persistent Memory (one build unit)

ID-lite and P1's storage ship together (spec: ID-lite has no standalone existence before `StorageClient`). This is the foundation; everything else writes into it.

**A0 · Capture fixtures [pure].** Freeze real iTunes Lookup + crawler responses for the §F fixtures — **Rivian** (cross-domain → escalate), **TikTok** & **Spotify** (zero asks), an **on-store-only** app (≤ medium), plus a competitor set. These are the red-test inputs for A2/A3; capturing them is real work, so it's the first task, not an assumption. (P4 needs its own two-version review sample — see Phase D.)

**A1 · Storage seam + schema [pure]**
- `memory/storage-client.ts` — the `StorageClient` interface (spec §B) and a **LibSQL implementation** via a raw **`@libsql/client`** pointed at the **same DB Mastra uses** (`file:./aso-audit.db`, per `mastra/index.ts`'s `LibSQLStore`) — add `@libsql/client` as a direct dep; `@mastra/libsql` only wraps it internally. Same file = our `aso_` tables sit beside Mastra's, which is the whole point of the namespace. No ORM.
- Tables (spec §A): `aso_listing_snapshots`, `aso_recommendations` (incl. `value_key`, `taxonomy_version`, `superseded_by`), `aso_identity_versions`, `aso_competitors`, `aso_competitor_tombstones`, `aso_rec_occurrences`.
- Contract guard: only domain types cross the interface — no SQL dialect, no vendor schema (this is what makes the future Postgres swap a config change).
- **TDD first:** a `StorageClient` conformance test suite (put/latest snapshot, upsert-on-`rec_key`, `recordOccurrence`, append/latest identity, tombstone set). This is the *same suite* §F/6a says Postgres must later pass — write it engine-agnostic now.

**A2 · ID-lite resolver [live crawler + Gemini; web-search stub]**
- `domain/identity.ts` (types: IdentityVersion, the signal-family tally, two-axis bands) + `mastra/tools/resolve-identity.ts`. **Modify `mastra/tools/identify-app.ts`** to feed its resolved signals into the resolver (spec §G), rather than resolve-identity re-fetching them.
- Deterministic day-one signals: developer + other apps, bundle-id reverse-DNS, permission/privacy labels, IAP names, marketing-domain match (crawler **[live]**), review-vocabulary. Pure-code matching, no vision (that's ID-full at P2).
- Confidence: weighted tally → band per spec §E (observed=2, fetched=2, cross-store=1, review-inferred=1, world-knowledge=0; on-store-only capped at medium *after* the tally). Two axes (category/niche), conflict→low.
- **Web-search corroboration tier [stub]:** `sources/websearch/` SourceProvider with a `NoopWebSearch` that returns `searched-and-empty`. Real Exa/Tavily client is a drop-in when the key lands. Until then ID-lite simply starts lower on the ladder — which the spec already models.
- Human escalation reuses the existing `confirm-app` suspend step (widened prompt). Writes `aso_identity_versions` stage=`lite`.
- **TDD first (§F ID-lite):** Rivian fixture → cross-domain → **escalate**; TikTok/Spotify → **zero asks**; on-store-only → band **≤ medium**; identity row written.

**A3 · Wire into the workflow + dedup [live]**
- `audit-workflow.ts`: resolve identity **before** `score-listing`; inject the identity fact sheet into the scoring prompt the same way deterministic signals are; read prior history pre-score (`scoring/score.ts`).
- `memory/dedup.ts`: `rec_key = hash(dimension, intent, target_field, value_key)`; `value_key` normalization pinned (casefold + NFC + trim + linter plural rule). Upsert on `rec_key`.
- **TDD first (§F P1):** audit the same app twice → no duplicate ledger row for a re-raise, **yet two distinct `add_keyword` recs for the same field survive as two rows** (assert both directions); contradiction guard fires on a reversed rec; rubric-weight replay recomputes a stored draft with **zero LLM calls** (assert call count = 0).

**A4 · P1 uplifts [live]**
- Applied-detection (status=`applied` = *match, not cause*), change-diff, contradiction guard, snapshot + rubric-replay, clickable evidence trail (`EvidenceRef`, spec §D — frozen into snapshot; `evidence_json` updates on upsert, history reconstructable via `aso_rec_occurrences`).
- **DoD:** §F ID-lite **and** §F P1 green; second audit references the first, marks applied, never repeats.

---

## Phase B · P2 Image Analysis + ID-full

**B0 · Reconciliation §G #1.** `scoring/rubric.ts:83` "Readable on-image text (Apple OCR-indexes it)" → reword to the v1.1.1 contested stance (conversion lever; keyword value a hypothesis).

**B1 · Vision pass [live Gemini vision]**
- `vision/` — Gemini vision over screenshots + icon. Value-prop clarity (first 1–2 frames), on-image-text readability, category cohesion. Icon: downscale the 1024 master to ~80–120px, deterministic fact sheet first (pHash distance = **observed**; "confusable" = **inferred**), then vision critique. Competitor visual benchmarking on top-3 first frames. Fold into `scoring/signals.ts` screenshots/icon dimensions. Confidence-labelled, never flat verdicts.

**B2 · ID-full**
- Vision-grounded identity (does creative match function?) + audience resolution. **Augments** the identity row to stage=`full` **without changing** ID-lite's deterministic fields; raises the previously-suppressed vision-dependent escalations.
- **TDD first (§F P2/ID-full):** each image gets a confidence-labelled critique; ID-full augments without mutating ID-lite fields; pHash `observed`, confusability `inferred`.

---

## Phase C · P3 Keyword Research

**C1 · The 160-char linter [pure] — build fully, no key needed.**
- `keywords/linter.ts` — deterministic title(30)+subtitle(30)+keyword-field(100) mechanics: cross-field token dedupe, plural-redundant flag (same plural rule `value_key` uses), wasted-word catch; per-term reclaimable-character ledger. Keyword field unobservable → findings labelled `inferred`.
- **TDD first (§F P3):** same input → byte-identical output, **no model call**; competitor keyword findings labelled `inferred`.

**C2 · ASA popularity client [stub] — no ASA key yet.**
- `keywords/asa-client.ts` behind the SourceProvider seam; `StubAsaClient` returns `unavailable` (not zero). Candidate generation + gap analysis run on the linter + (stubbed) volume; volume-dependent ranking labelled "popularity unavailable" until the key lands. Real OAuth2 client (scope `searchadsorg`, JWT `client_secret`) is the drop-in follow-up.

**C3 · Script-aware fallback.** CJK/RTL → observation-only path, keyword-mechanics suppressed + labelled "script not yet supported."
- Paid providers (AppKittie etc.) **not built** — optional, behind the seam, deferred.

---

## Phase D · P4 Deep Review Analysis [live Gemini + embeddings]

**D0 · Capture review fixtures [pure].** Freeze a **two-version review sample** (and a perturbed re-sample) so the §F P4 test — *dismissed complaint theme doesn't resurface across samples* — has deterministic inputs for both the canonical-id and `other`-bucket-embedding paths.

**D1 · Fetch.** Raise iTunes RSS fetch 25 → ~500/country with pagination (`sources/itunes.ts`); the ~500 cap labelled industry-observed.

**D2 · Themes + routing.** `reviews/themes.ts` — one LLM pass that extracts themes **and** classifies each to the canonical complaint taxonomy (15 buckets + `other`, spec §C); `value_key` = canonical theme id. `other`-bucket → embedding-similarity fallback (Gemini embeddings, cosine ≥ 0.85), labelled approximate. **Feature requests are disjoint** → human hand-off, no `value_key`, never ledgered. Per-version sentiment delta across the two latest versions. `taxonomy_version` stamped (`theme-taxonomy@1`).
- **TDD first (§F P4):** pagination to cap; per-version delta only above min sample; **dismissed complaint theme does not resurface** across perturbed samples — canonical path (stable id) **and** `other`-bucket path (embedding collapse) both asserted.

---

## Phase E · P5 Cost & Courtesy Control

**E1 · Cache [live].** Wrap `sources/http.ts` and the LLM/vision calls; entity-keyed (`app|competitor|asset`, never per-user); TTLs (iTunes 24h, RSS 1–3h, competitors 7d, vision by screenshot-fingerprint + per-asset SHA-256, ~30-day sanity); provenance stamps `observed_from_cache` + `fetched_at`; `--fresh` bypass. Read-through to `fetched_at` so P1's byte-identity reuse can't be fooled by stale cache.

**E2 · Spend & loop governor [live].** In-process singleton: count-kill at **~2,000 metered calls/hr** (all metered: iTunes + Gemini/vision + crawler), run-entry **<2s** trip, **5-min** wall-clock cap per run. Dollar estimate post-hoc (default $5/day; text from req/resp size, **vision per-image-tile**), alert-only.

**E3 · Courtesy throttle [live].** Process-global serial pacer before all iTunes calls (~3.5s, ~17/min); honour `Retry-After`; full-jitter backoff with `max(Retry-After, min-interval)` floor; in-run same-key coalescing.
- **TDD first (§F P5):** re-audit hits cache (0 upstream, provenance flipped); re-entrant loop killed ~2s; pacer spaces ≥3.5s + honours injected `Retry-After`; one deep audit under the 5-min cap.

---

## Phase F · Net-new uplifts

- **Storefront sweep** — N **sequential per-storefront sub-runs**, each its own audit under its own cap (not one monster run); observe-only, inherits the primary identity. Free iTunes only.
- **Connect-to-measure honesty manifest** — pure-code map of each rec into the four proof regimes.
- **Portable export** (Markdown/PDF) — persistence-independent artifact.
- **Review-vocabulary keyword miner** — counts the full sample in code, hands the ranked gap to the model.
- **DoD:** one US URL → four storefronts back with one rec per gap + per-rec proof regime.

---

## Deferred (planned at their tier, not now)

- **P6 (→1K):** 6a correctness gates (auth, row-level isolation, singletons→Redis shared limiter, LibSQL→Postgres swap *via the same StorageClient suite*, entity-shared cache) then 6b scale-out (durable queue, horizontal workers, observability, golden-set eval). The **6b golden set** is also where §C/§E thresholds get formally retuned.
- **P7 (→5K):** ASC integration (JWT/ES256 + Analytics Reports request→instance→poll — *verify lifecycle at kickoff*), continuous tracking, real measurement, cost/unit-economics.
- **P8:** write path — pending-version bundle, submit→review→rejection state machine, stop-loss, `superseded_by` migration on first taxonomy bump.
- **North Star:** daily digest, PPO-proven visual wins, self-measurement.

## Key-arrival follow-ups (drop-in, no rework)

- **Web-search key** → replace `NoopWebSearch` with Exa/Tavily; ID-lite's external-corroboration tier activates, ladder ceiling rises. (Touches one file.)
- **ASA key** → replace `StubAsaClient` with the OAuth2 client; P3 volume/popularity goes live. (Touches one file.)

## Build order summary

`Phase 0 → A (ID-lite + P1) → B (P2 + ID-full) → C (P3) → D (P4) → E (P5) → F (net-new)`

Each arrow is gated by its §F acceptance test going green. A and E are the load-bearing phases; C1 (the pure linter) and F are the most parallelizable if more than one person builds.
