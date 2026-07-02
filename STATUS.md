# Build Status — ASO Agent

**Where we stand.** A living dashboard, updated at the end of every phase. The
contracts live elsewhere: [`specification.md`](specification.md) is the *what*,
[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) is the *how-to-build*. This
file is the *where-we-are* — read it first, trust the tests over the prose.

_Last updated: 2026-07-02 · spec v1.3.2 · **Phase E complete (400 tests); Phase F base DoD met + F-K5 shipped (437 tests); F-K2 ✅ + F-K3 ✅ shipped (475 tests); F-K4 pending**_

Legend: ✅ done & verified · 🚧 in progress · ⬜ not started · ⏸ deferred (by design)

## Phases

| Phase | Scope | Status | DoD gate |
|---|---|---|---|
| **0** | Groundwork: Gemini-only, migration runner | ✅ | suite green + live audit on Gemini |
| **A** | ID-lite identity + P1 persistent memory | ✅ | §F ID-lite **and** §F P1 green; reworded re-raise collapses to one row (typed referent); 2nd audit references 1st, marks applied, never repeats. **A6 score determinism complete** (191 tests) |
| **B** | P2 image analysis + ID-full | ✅ | §F P2 green (vision confidence, zero-LLM reuse, pHash observed, promote-panel non-panoramic-only); ID-full stage=`full` augments identity without mutating ID-lite fields. **Live-verified on the real Rivian listing** (B5 hardening). |
| **C** | P3 keyword research (160-char linter) | ✅ | tsc clean · 365 tests · linter deterministic · stub honest · gap analysis inferred · candidateResult reuse (C4 residual closed) |
| **D** | P4 deep review analysis | ✅ | RSS→500, 15-bucket theme taxonomy + per-version delta, multi-instance graduation; **`other`-bucket embedding dedup** (cosine ≥ 0.85, merge bug fixed); **D3 function-grounded competitors** (identity-seeded → AppKittie topApps → iTunes listings, #1/#2 fixed). §F P4 both paths green. 1 carry-over (#3 re-embed cost) |
| **E** | P5 cost & courtesy control | ✅ | Gateway chokepoint; governor (count 2000/hr, run-entry 2s, wall-clock 5min); pacer (iTunes ≥3.5s, Retry-After); LibSQL `aso_cache` (iTunes 24h, reviews 2h, appkittie 24h); `observedFromCache` provenance. 400 tests, tsc clean. |
| **F** | Net-new uplifts (storefront sweep, export, …) | 🚧 | Base DoD met (415/418 tests): storefront sweep + proof regime + Markdown export + F-K1 keyword ranking. F-K2 (competitor review mining), F-K3 (competitor tiering), F-K4 (competitor visual benchmarking), F-K5 (web-search corroboration) still open. |
| **P6+** | Multi-tenant, ASC, write-path, North Star | ⏸ | planned at their tier, not now |

## Phase D — detail

| Task | Status | Lives in |
|---|---|---|
| D0 · Review fixtures (sample1 + perturbed sample2) | ✅ | `reviews/__fixtures__/rivian.reviews.sample{1,2}.json` |
| D1 · Review schema (`id`, `appVersion`) + RSS pagination to ~500 | ✅ | `domain/listing.ts`; `sources/itunes.ts` |
| D2 · Theme analysis + multi-instance graduation (canonical path) | ✅ | `reviews/themes.ts`; `domain/recommendation.ts` (Referent `theme`/`reviewId`); `memory/dedup.ts`; workflow + prompt |
| D2 · `other`-bucket embedding dedup | ✅ | `reviews/embedding.ts` (`GeminiEmbeddingProvider`, `cosineSimilarity`, `resolveOtherThemeKey`); `memory/dedup.ts` |
| D3 · Function-grounded competitors | ✅ | `sources/function-competitors.ts`; `sources/itunes.ts` (`getTopApps`/`batchLookupCompetitors`); workflow (`selectFunctionCompetitors` reuse) |

**D2 canonical (done):** `analyzeThemes()` is one LLM pass over the 15-bucket taxonomy + per-version sentiment delta (`taxonomy_version: theme-taxonomy@1`). `fix_complaint_theme`/`respond_to_reviews` graduated to multi-instance: `Referent` gained `theme {bucket,text}` and `reviewId`. Feature requests route to human hand-off (not ledgered).

**D2 `other`-bucket (done):** `resolveOtherThemeKey` embeds the complaint and matches cosine ≥ 0.85 against prior `other`-theme texts → reuse that key (equivalent collapses); else a deterministic `other:<sha256[:16]>` content hash (distinct stay separate). `Referent.theme` gained `resolvedKey?`; `valueKeyFor(theme)` → `resolvedKey ?? bucket` — **the literal-`'other'` merge bug is fixed**. §F P4 both paths pinned by the dedup gate test + `resolveOtherThemeKey` unit tests. NoOp provider never fabricates a vector.

**D3 (done):** identity-seeded (`resolved.niche`/`category`) → AppKittie `getTopApps` → tombstone filter → `batchLookupCompetitors` via **iTunes Lookup** (not AppKittie). Egress kept keyword-level; `MAX_SEEDS=2` cap; graceful fallback when unkeyed. **#1** suppression now gates on `!d3ProvidedCompetitors` (flag set on fetch + reuse paths) so cross-domain apps keep their real peers' terms. **#2** `selectFunctionCompetitors` reuses stored competitors on unchanged identity seeds (zero AppKittie calls). Decision #6 recorded as made (AppKittie accepted as load-bearing, swappable seam).

**D1 (done):** `reviewContentId()` — every `Review` always carries a stable id (RSS `<id>`, else `rc:<sha256[:16]>` of title+body+rating+author), so `respond_to_reviews` dedup is sound across the 500-review window.

**D-UI (done):** `ReviewInsights.tsx` panel (version-delta chip, 15-bucket theme breakdown, feature requests, "Based on N reviews" footer) + rec-card badges (bucket on `fix_complaint_theme`, review-ID chip on `respond_to_reviews`). `themeResult` is in the `AuditReport` wire shape (`aggregate.ts`). `selectThemeResult` reuse is **live** — but only after closing the **3rd silent persistence-drop bug** (`themeResult` was in the snapshot type but not the storage layer): fixed by `theme_result_json` (migrate + write/read). **All three snapshot blobs (`vision`/`candidate`/`theme`) now have round-trip conformance guards**, so this bug class is closed; test fixtures build via `makeReview()`/`AppListingSchema.parse()` (type-checked by construction).

**Carry-over (#3, non-blocking):** `resolveOtherThemeKey` re-embeds priors each call (no stored vectors) — fine for the beta (other-themes rare); store the vector + pin the embedding model id later.

## Phase C — detail

| Task | Status | Lives in |
|---|---|---|
| C1 · 160-char keyword linter + CJK/RTL detection | ✅ | `apps/server/src/keywords/linter.ts`; `keywords/linter.test.ts` (28 tests) |
| C2 · Keyword candidate generation + gap analysis | ✅ | `apps/server/src/keywords/candidates.ts`; `keywords/asa-client.ts`; `keywords/candidates.test.ts` (15 tests) |
| C4 · AppKittie interim keyword provider via MCP | ✅ | `apps/server/src/keywords/appkittie-client.ts`; `keywords/appkittie-client.test.ts` (11 tests, 1 live smoke) |
| C4-residual · candidateResult reuse (zero AppKittie on unchanged re-audit) | ✅ | `keywords/candidates.ts: selectCandidateResult`; `domain/snapshot.ts`; `memory/audit-memory.ts`; `audit-workflow.ts` |

**C1 notes:** Pure deterministic linter — no model call. Tokenises title + subtitle, reports cross-field duplicates, plural redundancies, and wasted words using the same `normalizeValueKey` as the dedup layer. CJK/RTL detection: >20% non-Latin codepoints in title → `scriptSupported: false`, all mechanics suppressed. Budget: title(30) + subtitle(30) + keyword-field(100) = 160 chars. Wired into `signals.ts` as `keywordLinter: LinterResult`; injected into prompt via `keywordLinterFacts()` in `prompt.ts`.

**C2 notes:** `generateCandidates()` is a pure async function — no model call. Extracts tokens from description and competitor names using the same plural-normalisation as the linter. Gap analysis: `yours_only` / `theirs_only` / `shared` vs competitor titles (all `inferred`). Volume queries capped at 10 per audit (competitor-source candidates queried first). ASA volume delegates to `AsaClient` seam; `StubAsaClient` returns `{ available: false, label: 'popularity unavailable' }` — never fabricates zeros. Wired into `audit-workflow.ts`; `formatCandidatesForPrompt()` injects gap section into the audit prompt.

**C-FU2 notes (divergence-aware gap suppression, `5ada6af`):** `suppressCompetitorGapTerms()` strips `theirs_only` gap rows when `resolved.escalate || resolved.divergence === 'cross_domain'` (genre-mismatched peers like Expedia/Booking for the Travel-listed Rivian shouldn't seed `add_keyword` recs for a vehicle app). Keeps `yours_only`/`shared`/description candidates. **Store-raw / transform-on-read:** the snapshot persists the *raw* `candidateResult`; suppression is a per-audit view from current `resolved` state — same pattern as vision (raw in DB, identity-aware transform fresh each audit), so an identity flip out of cross-domain restores the terms. Long-term cure (function-grounded competitors via AppKittie `topApps`) stays deferred to Phase D pending the decision-#6 egress review.

**C-FU3 notes (multi-keyword referent split, `76e57e1`):** the LLM sometimes packs several keywords into one `add_keyword` referent (`"electric,vehicle"`), which would mint one `rec_key` for the group and break per-keyword dedup/belief-accumulation. `expandAddKeywordRec()` (in `audit-memory.ts`, run before `toLedgerRec`) splits comma-joined values into one rec per keyword with a stable single-keyword `value_key`, dedups within the split (`tracker,trackers` → one row), and **splits on comma only** — space-separated keyphrases (`"electric vehicle"`) stay intact. Code-side fix (code derives the key, never trusts the model); prompt tightening is a complement. 7 tests incl. the dedup contract (`"a,b"` then standalone `"a"` → same row, not a third).

**C4 notes:** `AppKittieClient` implements `AsaClient` behind the seam. MCP JSON-RPC 2.0 over HTTPS — transport is programmatic (MCP tools never exposed to the agent). Normalises `get_keyword_difficulty` response to the domain volume type (adds `difficulty?: number`). Handles both `application/json` and `text/event-stream` MCP response formats. Graceful degradation: any network/parse error → `available: false` (no throw). `getKeywordProvider()` factory replaces `getAsaClient()`: checks `APP_KITTI_API_KEY` first → `AppKittieClient`; else stub. Provenance label: "AppKittie estimate". Live smoke (gated on `APP_KITTI_API_KEY`) verified against real MCP endpoint.

**C4-residual (closed):** `selectCandidateResult(listing, priorSnap)` returns the stored `CandidateResult` when listing text (name/subtitle/description) + competitor names are unchanged — skipping `generateCandidates` and all AppKittie calls, keeping `promptHash` stable for unchanged re-audits. Mirrors `selectVisionResult` exactly. `CandidateResultSchema` (Zod) validates the stored blob on read-out. Stored in `ListingSnapshot.candidateResult` (opaque blob, backward-compatible optional). 8 new tests: null-when-absent, null-on-schema-drift, name/description/competitor-set change invalidates, competitor order irrelevant. **Result: unchanged re-audits now burn 0 AppKittie credits (was ≤10 × 10 credits every time).**

## Phase B — detail

| Task | Status | Lives in |
|---|---|---|
| B0 · Reconciliation §G #1 — rubric.ts:83 OCR wording | ✅ | `apps/server/src/scoring/rubric.ts` |
| B1 · Vision pass — Gemini vision over screenshots + icon | ✅ | `apps/server/src/vision/{types,client,phash,analyze,select}.ts`; `scoring/dimension-scorer.ts`; `domain/snapshot.ts`; `memory/libsql-storage-client.ts`; `memory/migrate.ts` |
| B2 · ID-full — vision-grounded identity, stage=`full` | ✅ | `apps/server/src/identity/{id-full,identity-vision-client}.ts`; `mastra/workflows/audit-workflow.ts` |
| B3 · P2 secondary uplifts — screenshot intelligence, cross-device matrix, PPO ≤3 | ✅ | `apps/server/src/vision/secondary-uplifts.ts`; `vision/client.ts` extended |
| B4 · Phase-A carry-over fixes — applied-detect (previewVideo), escalate gate, reachability guard, efficiency | ✅ | `memory/audit-memory.ts`; `scoring/score.ts`; `mastra/tools/resolve-identity.ts`; `mastra/workflows/audit-workflow.ts` |

**B1 notes:** `SCORER_VERSION` is `'phase-b-v2'` (invalidates Phase A *and* pre-cap cached scores). Screenshots/icon confidence upgrades to `observed` **only when vision produced real critiques** (the shared `visionUsable` guard); `codeScore('screenshots')` returns the vision coarse-ordinal {0,5,10}, capped at 5 when `< 10` slots are used. `selectVisionResult` is a pure function — if screenshot/icon URLs match the prior snapshot's, returns stored VisionResult with zero LLM calls. `jimp` added for pHash computation (pure JS). Competitor icon/screenshot URLs are not available in `AppListing.Competitor` — competitor image comparison deferred to Phase D. `getVisionClient()` returns a no-op stub when no API key is set, and the no-op result is labelled `inferred` (never a fabricated `observed`).

**B2 notes:** `runIdFull()` is a pure function — copies `category`, `categoryBand`, `tally`, `divergence`, `source` verbatim from ID-lite; vision adds `audience` and may raise `nicheBand`. De-escalation only fires when `litePrior.escalate && litePrior.divergence !== 'cross_domain' && creativeMatchesFunction`. `getIdentityVisionClient()` returns a no-op stub without API key.

**B4 fixes (carry-overs now closed):**
- `add_preview_video` recs now auto-detected as `applied` when `hasPreviewVideo` flips to true.
- `buildPriorContext` "do not rewrite positioning" note now gates on `escalate && source !== 'human_confirmed'` (not bare `divergence === 'cross_domain'`).
- Identify-step LLM call now has a `reachable()` guard (matches score-listing pattern).
- `buildAuditPrompt` built once per audit; `persistAudit` uses pre-fetched snapshot/ledger when provided.

**B5 · Live-integration hardening (surfaced by a manual live audit of the real Rivian listing — the live Gemini-vision path is now exercised end-to-end):**
- **Apple-CDN base64 proxy:** `mzstatic.com` URLs sent straight to Gemini returned empty critiques (Apple blocks the fetch); `client.ts: #fetchAsDataUrl` now fetches each image in Node and inlines it as `data:…;base64`, wrapped in try/catch so a `!res.ok` or thrown network error degrades to the original URL instead of crashing `Promise.all`.
- **Thinking-token truncation:** raised vision `max_tokens` 2000→8000 (identity-vision 400→800) + concise-critique prompt, so the model finishes JSON before the budget runs out.
- **Honest degradation on parse failure (key fix):** the shared `visionUsable(v) = !!v && v.screenshotSetVerdict.critiques.length > 0` guard governs all four scoring/prompt sites in lockstep — on a `{}`/truncated response, `deriveConfidence('screenshots')` → `inferred`, `codeScore('screenshots')` → `slotsUsedOf10` (not a fabricated `5`), and both prompt sites let the limitation surface. 7 regression tests cover the empty-critiques path.
- **Slot-utilisation cap:** `coarseScore` capped at 5 when `< 10` slots used (only a full set of 10 earns 10); stays within {0,5,10}.
- **Identity-ledger head:** `latestIdentity` prefers the `full` row (`CASE WHEN stage='full'…`), and a new stage-blind `maxIdentityVersion` drives the version counter so monotonic numbering holds — a reuse re-audit no longer buries the full row's audience. Pinned by conformance + regression tests.

## Phase A — detail

| Task | Status | Lives in |
|---|---|---|
| A0 · Fixtures (Rivian/TikTok/Spotify/on-store-only) | ✅ | `apps/server/src/identity/__fixtures__/` |
| A1 · StorageClient seam + LibSQL + `aso_*` schema + conformance suite | ✅ | `apps/server/src/memory/{storage-client,libsql-storage-client,migrate}.ts` |
| A2 · ID-lite resolver (tally→band, divergence, websearch stub) | ✅ | `apps/server/src/identity/{signals,domains,resolve}.ts`, `mastra/tools/resolve-identity.ts`, `sources/websearch/` |
| A3 · Dedup + workflow wiring + history injection | ✅ | `apps/server/src/memory/dedup.ts`, `mastra/workflows/audit-workflow.ts` |
| A4 · P1 uplifts (applied-detect, change-diff, contradiction, rubric-replay, evidence) | ✅ | `apps/server/src/memory/audit-memory.ts`, `scoring/replay.ts` |
| A5 · Human-escalation gate + human-confirmed override | ✅ | `apps/server/src/identity/human-confirm.ts`, widened `confirm-app` in `audit-workflow.ts`, `mastra/routes.ts` |
| A6 · Score determinism — confidence code-derived (all 10); reuse (per-dim + whole-snapshot); identity temp-0; code-scored screenshots / preview-video / ratings; title/subtitle coarse-ordinal; `inferred` relabel; docstring cleanup | ✅ | `scoring/dimension-scorer.ts`, `scoring/aggregate.ts`, `mastra/workflows/audit-workflow.ts`, `mastra/tools/resolve-identity.ts`, `memory/audit-memory.ts` — see plan A6 |

**A6 status (✅ complete):** the §F P1 gates (dedup / contradiction / zero-LLM replay) all pass; A6 was a P1 *secondary*-uplift ("deterministic signals solid, LLM scores muted", spec line 173) surfaced when an identical re-audit swung **46 → 30** at temp 0. Now closed: confidence code-derived (no denominator flips), identical re-run reuses the report with zero LLM, screenshots / preview-video / ratings code-scored, and title/subtitle snapped to a coarse ordinal {0, 5, 10}. **Two beta-calibration caveats remain for the 6b retune (not blockers):** coarse-ordinal boundary instability (a 7↔8 model waver flips 5↔10 on title's w20) and the harsh `utilisation < 20%` → 0 floor (zeroes the whole dim on one check). Temperature 0 is correctly wired throughout; residual variance is structural, not the flag. The prompt **echoes the computed scores** (`scoringConstraints`) so the model's findings narrative matches the displayed number — both follow-ups now closed (scores render from `codeScore`; the `utilisation < 20%` floor is a forced `→ 0` bullet + subtitle unobservable inline). One optional residual: the floor threshold `20` is still duplicated between `coarseOrdinalScore` and `scoringConstraints` (extract a shared `coarseOrdinalFloor` helper to fully single-source it). Screenshots score now sources from iTunes `screenshotUrls.length` (authoritative); `crawledScreenshotCount` is a fallback only when iTunes returns 0 — the earlier `Math.max` blend overcounted (mzstatic thumbs include iPad shots / preview posters / related-app icons). Pinned by two regression tests (`signals.test.ts`): iTunes wins over a larger crawler count, and the crawler is the fallback only when iTunes is empty — a `Math.max` revert fails both.

## Tests (the source of truth)

- **365 hermetic tests pass** (`npm test`). Covers (Phase A): StorageClient conformance,
  ID-lite §F gates, P1 §F gates (dedup, contradiction, zero-LLM replay),
  human-confirm reuse/re-ask, memory loop end-to-end, classifier fail-safe
  parsing, dismissal-is-honoured, **reworded re-raise collapses to one row**,
  the Mastra `getStepResult`-across-resume contract, and A6 score stability.
  **Phase B additions:** §F P2 vision tests (`vision/vision.test.ts`) — confidence
  labels, zero-LLM reuse via `selectVisionResult`, pHash observed/confusability
  inferred; §F P2 ID-full tests (`identity/id-full.test.ts`) — stage=`full`,
  audience populated, creative mismatch escalation, de-escalation with cross_domain
  guard; P2 secondary uplifts (`vision/secondary-uplifts.test.ts`) — promote-panel
  non-panoramic-only, duplicate flag, pure `computeDeviceMatrix`, PPO exceeded;
  B4 carry-over fixes — `add_preview_video` applied detection, `buildPriorContext`
  escalate-gate (3 cases), efficiency changes.
  **Phase C additions:** keyword linter (28 tests) — script detection, budget reporting,
  determinism, wasted words, cross-field duplicates, plural redundancy, reclaimableChars;
  keyword candidates + gap analysis (15 tests) — stub path honest "popularity unavailable",
  dedup via same `normalizeValueKey` as linter, gap categories `yours_only`/`theirs_only`/`shared`,
  all gap rows `confidence: 'inferred'`, `formatCandidatesForPrompt` coverage;
  AppKittie MCP client (11 tests incl. 1 live smoke) — normalization, graceful degradation,
  factory precedence, SSE+JSON response handling, live-verified against real endpoint.
  **C4-residual:** `selectCandidateResult` (8 tests) — null-when-absent, null-on-schema-drift,
  name/description/competitor-set change invalidates cache, competitor order irrelevant.
- **Live smokes (gated on a Gemini key, skipped by default):**
  - `scoring/audit-smoke.test.ts` — full audit + identity + persist on real Gemini.
  - `mastra/workflow-smoke.test.ts` — real workflow suspend → resume(decision) → report.
  - Run: `dotenv -e ../../.env -- npx vitest run <path>` (Node ≥ 20.12 — see Gotchas).

## Code review (high-effort pass, 2026-06-25)

Fixed + tested: dismissed recs no longer silently re-open on re-raise; the
identity classifier fails safe instead of throwing on malformed JSON; the
`getStepResult`-across-resume assumption is now guarded (it holds).

**A7 post-review batch (applied & committed):** IntentTag import (build was red —
`tsc` is now fully clean — the `routes.ts` Hono skew was fixed with a scoped
`c as any`); orphaned rec-occurrences (now record against the stored row id,
pinned by a regression test); human-confirmed `nicheBand`; reuse staleness
(`SCORER_VERSION` folded into both the per-dimension hash **and** the
whole-snapshot fingerprint via `scoring/version.ts`, pinned by `version.test.ts`);
replay/aggregate share one formula; classifier logs on parse failure.
**All A7 residuals closed.**

Phase A carry-overs: **all closed in B4** (applied-detection extended, escalate gate fixed, reachability guard added, efficiency improved).

**Post-review fixes (final whole-branch review):** B2/B3 vision calls now gated on `visionWasFresh` — they only run when `selectVisionResult` returned null (images changed), so unchanged re-audits skip B2/B3 calls entirely. `pHashDistance.confidence` is `'inferred'` when competitor icon URLs are empty (placeholder 64 is not an observed measurement). Identity row de-dup is resolved by the same gate. Then the **B5 live-integration hardening** (above) closed the real-vision-path honesty gaps. Suite is now **365 tests** green (3 live smokes skipped).

**Snapshot blob round-trip fix (`4393c35` + `845de56`) — corrects the Phase-B/C reuse record.** Both optional snapshot blobs (`visionResult`, `candidateResult`) were silently writing `null` to their columns (pass-through omission in `persistAudit` + `?? null` in the store), so `selectVisionResult` / `selectCandidateResult` always read empty → **vision reuse was dead through all of Phase B** (every re-audit re-called Gemini vision) and candidate reuse was dead in C4. The unit tests missed it (they pass in-memory snapshots, never the DB round-trip). Now both are correctly persisted, and `storageClientConformance` has explicit **put→latest round-trip guards** for each blob (so it can't silently regress, and the guards run against Postgres at 6a).

## Known gaps / deviations (conscious, not bugs)

- **#3 — IAP names & permission/privacy-label signal families** are modelled but
  report `not observed` (not in the iTunes Lookup response). They're
  corroboration, not load-bearing for the §F gates. *Wire via the crawler later.*
- **#1 (resolved)** — identity is resolved in the `identify-app` *step* (from its
  existing iTunes fetch), not by modifying the `identify-app` *tool*. The §G "no
  re-fetch" intent holds; documented as accepted.
- **Resolved** — the pre-existing `mastra/routes.ts` Hono `Context` type-skew on
  `streamSSE` is fixed with a scoped `c as any`; **`tsc --noEmit` is now fully clean**
  and can gate CI. `npm test` green (365).

## Gotchas

- **Node ≥ 20.12 required** (vitest 4 / rolldown). The shell may default to Node
  18 — `nvm use 24` first, or `npm install` + tests fail on a missing native binding.

## Phase F — detail

| Task | Status | Lives in |
|---|---|---|
| F1 · Connect-to-measure proof regime | ✅ | `scoring/proof-regime.ts`, `domain/audit.ts`, `web/src/components/Recommendations.tsx` (badge) |
| F-K1 · Keyword opportunity ranking | ✅ | `keywords/opportunity.ts`, `scoring/prompt.ts` (injected), `mastra/workflows/audit-workflow.ts` — 15 unit tests |
| Storefront sweep | ✅ | `sources/storefront-sweep.ts`, `/audit/sweep` route, `web/src/components/StorefrontComparison.tsx` |
| Portable Markdown export | ✅ | `export/markdown.ts`, `/audit/export/markdown` route, Export .md button in `ReportView.tsx` |
| **F-K2 · Competitor review mining** | ✅ | `keywords/competitor-mining.ts` (`mineCompetitorReviews`, `formatCompetitorMiningForPrompt`); fetches ≤3 competitors × 50 reviews, filters 1–2★, runs combined `analyzeThemes`; gated on D3 (`d3ProvidedCompetitors`); prompt section injected after theme analysis; 15 tests |
| **F-K3 · Competitor tiering + per-keyword mapping** | ✅ | `sources/competitor-tiering.ts` (`tierCompetitors`, `mapKeywordGapsToCompetitors`, `buildCompetitorTieringResult`, `formatCompetitorTieringForPrompt`); deterministic, no LLM; gated on D3; prompt section injected after competitors block; 23 tests |
| **F-K4 · Competitor visual benchmarking** | ⬜ | Wire competitor first-frames + icons into vision → first-value-prop / color-contrast comparison |
| **F-K5 · Web-search corroboration** | ✅ | `TavilyWebSearch` (primary) + `ExaWebSearch` (fallback) + factory (`TAVILY_API_KEY` → Tavily → `EXA_API_KEY` → Exa → Noop); probe wired into identity tally (`footprint` family); `websearch` added to gateway cache (7d TTL); 22 new tests |

**Base DoD:** one US URL → four storefronts back with one rec per gap + per-rec proof regime badge. Met (415/418 tests, tsc clean).

**F-K DoD (pending):** every keyword/competitor finding carries provenance (`observed | inferred | estimated`). F-K1 ships the ranking; F-K2/K3 add competitor intel; F-K5 activates web-search corroboration (keys already keyed). Sequence: F-K2 → F-K3 → F-K5 → F-K4 (most expensive, deferred).

## Next up

- **F-K5 ✅ + F-K2 ✅ + F-K3 ✅ shipped (475 tests).** F-K4 (competitor visual benchmarking) deferred — requires competitor icon/screenshot URLs from D3 + vision cost. Add `TAVILY_API_KEY` or `EXA_API_KEY` to `.env` to activate real web-search corroboration.
- **Phase D carry-over (non-blocking):** #3 — `resolveOtherThemeKey` re-embeds priors each call (store the vector + pin the embedding model id later).
- **Competitor images** — `analyze.ts` still passes empty competitor icon/screenshot URLs; D3 now provides competitor app ids, so F-K4 competitor visual benchmarking could be wired after F-K5 (mind vision cost + decision-#6 egress).

## Key-arrival follow-ups (drop-in, one file each)

- **Web-search key** → replace `NoopWebSearch` (`sources/websearch/`) with Exa/Tavily.
- **ASA key** → replace `StubAsaClient` (`keywords/asa-client.ts`) with the real OAuth2 client (scope `searchadsorg`, JWT `client_secret`). **Genuine one-file drop-in** — the candidate-gen/gap-analysis consumption path (`generateCandidates` → `getVolume`) already exists, so volume/popularity lights up with no other changes.
