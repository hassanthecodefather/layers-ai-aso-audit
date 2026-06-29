# ASO Agent — Implementation Plan (Beta)

Companion to `specification.md` / `specification.html` **v1.3.1**. This is the *how-to-build*; the spec is the *contract*. Scope: **the beta in full** — ID-lite + P1–P5 + net-new uplifts, for a single operator. P6 → North Star are sketched at the end and planned in detail when their tier is reached (per the spec's "don't build for a scale you haven't reached").

## Working agreement (decisions locked for this plan)

- **TDD against §F.** Every phase starts by writing its Build-Appendix §F acceptance test (red), then implements to green. `vitest` + `*.test.ts` already exist in `apps/server`.
- **Test doubles — freeze the world *and* the judgment.** Unit tests use two doubles so the deterministic logic (signal counting, confidence bands, escalation, dedup) is fully repeatable: (1) **input fixtures** — frozen iTunes/crawler/RSS responses (tasks A0/D0); (2) a **`StubLlmProvider`** injected via the existing `llm/provider.ts` seam, returning a canned judgment **paired to its fixture** (Rivian fixture ⇒ "EV companion"). Because the stub is controllable, tests can **assert LLM call counts** — which is what makes §F's "zero LLM calls" replay assertion writable. The real Gemini call is exercised **only** in the Phase-0 live smoke test, plus a **schema-contract check** that real-provider output validates against the same shape the stub satisfies — that contract test is the one guard a pure-stub suite can't provide (it catches the stub drifting from reality).
- **Gemini-only.** Ollama is removed (spec §H #7 overridden). Gemini serves text scoring, vision (P2), and embeddings (P4 fallback).
- **Keys live now:** paid **Gemini**, **Firecrawl**. **Not yet keyed:** web-search (Exa/Tavily), Apple Search Ads. Anything depending on a missing key is **built behind its seam and stubbed**, with the real client a one-task follow-up when the key lands. The spec's confidence ladder + tri-state probe make this honest (a stubbed source reports `searched-and-empty`, never fakes data).
- **Definition of Done, per phase:** its §F acceptance test is green, both editions of the spec already describe it, no `*.test.ts` regressions, **and [`STATUS.md`](STATUS.md) is refreshed** (phase row, file map, test counts, known gaps) — the dashboard is not allowed to drift from reality, so updating it is the *last step of every phase*, not an afterthought.
- **Two spec↔code reconciliations** (spec §G) are scheduled at their phases: Ollama removal (Phase 0) and the `rubric.ts:83` OCR line (Phase B).

Legend: **[live]** builds against a real key · **[stub]** seam built now, real client deferred · **[pure]** no external dependency.

---

## Phase 0 · Groundwork & reconciliation (½–1 day)

**Goal:** Gemini-only, green existing tests, migration runner ready — nothing new yet.

- **0.1 Remove Ollama (reconciliation §G #2).** Delete `llm/ollama.ts`; drop the Ollama branch from the `llm/provider.ts` / `llm/index.ts` switch; **flip the defaults in `llm/index.ts`** — today `LLM_PROVIDER` defaults to `ollama` and `DEFAULT_MODEL = 'gemma3'`, so without this change `getLlmProvider()` resolves to a now-deleted provider and the app won't start. Make Google the only/default provider. Rewrite the `audit-workflow.ts` `score-listing` error text to reference Gemini, not "start Ollama / ollama pull".
- **0.2 Gemini reachability + one beta model.** Confirm `llm/google.ts` reads the key from `.env`; `reachable()`, `modelId`/`endpoint` work. **Pin one beta model** — `gemini-2.5-flash` is already the Google default (`llm/index.ts: DEFAULT_GOOGLE_MODEL`); keep it, or set a more capable id if judgement quality needs it. Add a startup check that the pinned model responds. **Pin scoring temperature ≈ 0** — necessary for run-to-run stability; it collapses the recommendation-set drift (the ledger that P1's belief-accumulation / applied-detection read must be stable for an unchanged listing, not a union of noisy samples). *(Correction from live testing: temp 0 is necessary but **not sufficient** for **score** stability. It is correctly wired — `score.ts` passes `modelSettings: { temperature: 0 }`, verified against Mastra 1.46 — yet two identical re-runs still swung the overall **46 → 30**, because per-dimension scores are left to the model. Temp 0 stabilises the **rec set**; **score** stability needs the structural fix in **A6**. Do not assume ±1–2.)* *(Cheap/capable model-tiering is a **P7** concern — the current `LlmProvider` carries a single `modelId`, so don't build tiering now.)*
- **0.3 Migration runner.** A tiny `memory/migrate.ts` that creates the `aso_*` tables (idempotent, `CREATE TABLE IF NOT EXISTS`). Empty for now; each phase adds its tables.
- **Tests:** existing suite stays green with Ollama gone (the one regression risk); add a smoke test that a full audit runs end-to-end on Gemini.
- **DoD:** `vitest` green; an audit of one real URL completes with Gemini only; `STATUS.md` refreshed.

---

## Phase A · ID-lite + P1 Persistent Memory (one build unit)

ID-lite and P1's storage ship together (spec: ID-lite has no standalone existence before `StorageClient`). This is the foundation; everything else writes into it.

**A0 · Capture fixtures [pure].** Freeze real iTunes Lookup + crawler responses for the §F fixtures — **Rivian** (cross-domain → escalate), **TikTok** & **Spotify** (zero asks), an **on-store-only** app (≤ medium), plus a competitor set. These are the red-test inputs for A2/A3; capturing them is real work, so it's the first task, not an assumption. (P4 needs its own two-version review sample — see Phase D.)

**A1 · Storage seam + schema [pure]**
- `memory/storage-client.ts` — the `StorageClient` interface (spec §B) and a **LibSQL implementation** via a raw **`@libsql/client`** pointed at the **same DB Mastra uses** (`file:./aso-audit.db`, per `mastra/index.ts`'s `LibSQLStore`) — add `@libsql/client` as a direct dep; `@mastra/libsql` only wraps it internally. Same file = our `aso_` tables sit beside Mastra's, which is the whole point of the namespace. No ORM.
- Tables (spec §A): `aso_listing_snapshots`, `aso_recommendations` (incl. `value_key`, `taxonomy_version`, `superseded_by`), `aso_identity_versions`, `aso_competitors`, `aso_competitor_tombstones`, `aso_rec_occurrences`.
- Contract guard: only domain types cross the interface — no SQL dialect, no vendor schema (this is what makes the future Postgres swap a config change).
- **TDD first:** a `StorageClient` conformance test suite (put/latest snapshot, upsert-on-`rec_key`, `recordOccurrence`, append/latest identity, tombstone set). This is the *same suite* §F/6a says Postgres must later pass — write it engine-agnostic now.

**A2 · ID-lite resolver [live crawler + Gemini; web-search stub] — ✅ built**
- `domain/identity.ts` (types: IdentityVersion, the signal-family tally, two-axis bands) + `identity/{signals,domains,resolve}.ts` + `mastra/tools/resolve-identity.ts`. **As-built note (deviation accepted):** rather than modifying `identify-app.ts`, the workflow's `identify-app` *step* resolves identity from the single iTunes-core fetch it already makes — so the resolver is **fed** the signals and never re-fetches (the §G intent), without touching the `identify-app` tool. Functionally equivalent.
- Deterministic day-one signals that fire today: developer, bundle-id reverse-DNS, marketing-domain match, review-vocabulary. Pure-code matching, no vision (that's ID-full at P2). **Deferred (deviation #3):** permission/privacy labels and IAP names aren't in the iTunes Lookup response, so those families are modelled but report `not observed` (honest absence) until a crawler-backed source is wired — they're corroboration, not load-bearing for the §F gates.
- Confidence: weighted tally → band per spec §E (observed=2, fetched=2, cross-store=1, review-inferred=1, world-knowledge=0; on-store-only capped at medium *after* the tally). Two axes (category/niche), conflict→low.
- **Web-search corroboration tier [stub]:** `sources/websearch/` SourceProvider with a `NoopWebSearch` that returns `searched-and-empty`. Real Exa/Tavily client is a drop-in when the key lands. Until then ID-lite simply starts lower on the ladder — which the spec already models.
- Human escalation reuses the existing `confirm-app` suspend step (widened prompt). Writes `aso_identity_versions` stage=`lite`.
- **TDD first (§F ID-lite):** Rivian fixture → cross-domain → **escalate**; TikTok/Spotify → **zero asks**; on-store-only → band **≤ medium**; identity row written.

**A3 · Wire into the workflow + dedup [live] — ✅ built**
- `audit-workflow.ts`: resolve identity **before** `score-listing` and inject the **identity fact sheet** into the scoring prompt (this grounds scoring and is fine). **Do NOT inject the prior-recommendation ledger into generation** — it makes the model diversify away from past recs, drifting the set every run (observed live). Generation is a pure function of `(listing + identity)`; the ledger is read **after**, in code (`memory/` reconciliation: dedup, applied-detection, contradiction-guard, belief-accumulation). The current listing already encodes applied changes, so stateless generation won't re-propose them.
- **Constrain rec *existence* to deterministic candidates (residual temp-0 variance).** Which recs exist should derive from signal thresholds + rubric in code; the LLM ranks/phrases, it doesn't free-invent the set. Do this for **structural dimensions now** (preview-video present?, char utilisation, screenshot count). **Keyword-rec determinism is P3** — the deterministic candidate engine (linter + ASA) doesn't exist until Phase C, so keyword recs stay model-driven (and noisy) until then; don't try to force keyword stability at Phase A.
- **Typed referent in the schema (the live-bug fix).** Extend the `AuditDraft` recommendation with `intent` (closed `IntentTag` enum) **plus a typed referent** — `keyword` for `add_keyword`/`remove_wasted_term`, `themeId` (∈ the 15-bucket enum) for `fix_complaint_theme`, `reviewId` for `respond_to_reviews`, `country` for `localise_storefront`; all other intents single-instance. `memory/dedup.ts` then computes `rec_key = hash(dimension, intent, target_field, value_key)` where **`value_key` is derived in code from the typed referent** (pinned casefold + NFC + trim + plural rule) — **never from the model's `after`/`title` prose**. Deriving from prose is what minted duplicate rows on the feature branch: Gemini reworded the same suggestion on a second cold run → different prose-hash → new row. Upsert on `rec_key`.
- **TDD first (§F P1):** audit the same app twice → no duplicate row for a re-raise **including a *reworded* re-raise** (stub returns differently-worded outputs across the two runs with the **same referent** → must still collapse to one row; this is the case a fixed-text stub would have hidden); **yet two distinct `add_keyword` recs for the same field survive as two rows** (assert all directions); contradiction guard fires on a reversed rec; rubric-weight replay recomputes a stored draft with **zero LLM calls** (assert call count = 0).
- **Phase-A-blocking.** Broken multi-instance dedup corrupts the ledger from day one (belief-accumulation, applied-detection, contradiction-guard all read it), so this is the completion of A3 — *not* a deferral to Phase B. Phase A isn't done until a reworded re-raise dedups **live**, not just under the stub.

**A3-fixup · referent shape + the `other`-bucket trap.** Implementation detail for the above:
- **Referent union** the model emits in `AuditDraft` (target shape; variants land in the phase that first *fans out* that intent):
  ```
  intent: IntentTag
  referent:
    | { kind: 'keyword'; value: string }          // add_keyword / remove_wasted_term   [A3]
    | { kind: 'country';  value: string }          // localise_storefront                [A3]
    | { kind: 'theme';   bucket: ComplaintTheme; text: string }  // fix_complaint_theme  [PHASE D]
    | { kind: 'reviewId'; value: string }          // respond_to_reviews                 [PHASE D]
    | { kind: 'none' }                             // every other intent (single-instance)
  ```
- **`value_key` derivation** wired at **A3** (`dedup.ts`):
  ```
  none     → ''
  keyword  → normalizeValueKey(value)          // casefold + NFC + trim + depluralize
  country  → value
  ```
- **A3 placeholders — `fix_complaint_theme` and `respond_to_reviews` are single-instance (`none`) *for now*.** They don't fan out until Phase D's review analysis: at Phase A the ratings dimension emits at most one coarse "address top complaint" / "respond to reviews" rec, so a single row is correct and the collapse can't bite. **They MUST be re-classified to multi-instance in Phase D** (their referents + `value_key` derivation move there, below) — leaving them single-instance once Phase D fans them out would silently merge distinct complaints/reviews into one row. The `theme` variant deliberately carries **both `bucket` and raw `text`** for the Phase-D `other`-bucket fallback.
- **Validate the emitted enum (reject + retry).** `intent` and `bucket` must validate against the closed sets via the draft's Zod schema; on an out-of-enum value, reject and retry — a hallucinated `intent`/`bucket` must never reach `value_key`.
- **Test both halves of the goal.** Beyond the reworded-re-raise (proposed → upsert, one row, occurrences=2), add: a reworded suggestion whose referent matches a **`dismissed`** row is caught by the **contradiction guard and not re-emitted** (the "don't re-nag" half — only safe now because the key is stable).
- **DoD — validate from a clean DB.** The key scheme changed, so rows written under the old prose-derived keys are abandoned (fine in the beta dev DB). Verify on a **fresh** `aso-audit.db`: two consecutive live Rivian audits, asserting the **second adds no rows** for already-proposed recs. (Don't assert "no new rows on the 3rd audit" against a DB that holds old-scheme rows — it will falsely fail.)

**A4 · P1 uplifts [live] — ✅ built**
- Applied-detection (status=`applied` = *match, not cause*), change-diff, contradiction guard, snapshot + rubric-replay, clickable evidence trail (`EvidenceRef`, spec §D — frozen into snapshot; `evidence_json` updates on upsert, history reconstructable via `aso_rec_occurrences`).
- **DoD:** §F ID-lite **and** §F P1 green; second audit references the first, marks applied, never repeats; `STATUS.md` refreshed. *(All green; verified hermetically and via a live end-to-end audit on Gemini.)*

**A5 · Human-escalation gate + human-confirmed override [live] — ✅ built**
The interactive half of the spec's identity-escalation logic (the A2 line above only handled the *non-engagement* fallback — suppress identity-rewriting recs + stamp "unconfirmed"). A5 makes the **ask** real and lights up the **override** path.
- `identity/human-confirm.ts` (pure): `applyHumanDecision` (confirm / correct / pick → a `human_confirmed` identity, sticky, `escalate` cleared, recorded as the categorical `source=human_confirmed` tier, never a fake 100%); `resolveWithHistory` (respects a stored human-confirmed identity — **re-asked only when the signals it rested on materially change *and* the fresh answer flips domain**, per spec ID); `signalsMateriallyChanged`.
- **Widened `confirm-app` suspend step:** `identify-app` now resolves ID-lite from its existing iTunes-core fetch and the step suspends with `{ summary, identity, identityNeedsConfirm }`; resume accepts `{ confirmed, identityDecision? }`. The `score-listing` step reads the decision via `getStepResult` and applies it; an `human_confirmed` identity **allows** the identity-rewriting recs that an unconfirmed one suppresses. One human round-trip — no second suspend — reusing the existing machinery.
- **Routes:** `/audit/identify` surfaces `identity` + `identityNeedsConfirm`; `/audit/run` accepts an `identityDecision` and threads it into the resume.
- **Tests:** human-confirm logic (confirm/correct, reuse-vs-re-ask, flip detection) hermetic; `human_confirmed` persistence + rec-allowance in the memory suite; a **live workflow smoke** drives the real suspend → resume(decision) → report path.

**A6 · Score determinism — honour "deterministic signals solid, LLM scores muted" (spec line 173) [live] — ✅ complete.** *Surfaced by live testing (identical re-runs swung **46 → 30** at temp 0); the §F P1 gates already passed — this closed a P1 secondary-uplift gap by pushing the code/LLM split from the total down to each dimension.*
- ✅ **Code-derived confidence** for all 10 dims (`dimension-scorer.ts: deriveConfidence`, applied in `aggregate.ts`) — the model can no longer flip a dimension `unavailable` and silently re-weight the score.
- ✅ **Code-scored deterministic dims** (`codeScore`): screenshots = slots-used-of-10; previewVideo = present→8 / absent→0; ratings = `(allTimeAverage / 5)·10` + ±1 recent-trend nudge (rubric checks 1–2; themes/responses → P4).
- ✅ **Coarse-ordinal for mixed dims** (title/subtitle, `coarseOrdinalScore`): `utilisation < 20%` floor → 0, else snap to {0, 5, 10}. Idempotent, so the reuse/cache path stays stable. `description` / `icon` / `conversion` / `competitive` stay free 0-10 (reuse re-rolls them only on their own edits).
- ✅ **Screenshots source = iTunes** (`signals.ts`): `slotsUsedOf10 = screenshotUrls.length || crawledScreenshotCount` (crawler is fallback only when iTunes returns 0). Pinned by two regression tests (`signals.test.ts`) — a `Math.max` revert fails both.
- ✅ **`inferred` relabel** — screenshots/previewVideo report `inferred` (count/presence observed, quality needs vision); upgraded to `observed` at **B1**.
- ✅ **Reuse, don't recompute** (`audit-workflow.ts`): whole-snapshot byte-identical ⇒ reuse the report, zero LLM; else a per-dimension splice reuses unchanged dims (input hash carries `SCORER_VERSION`).
- ✅ **Identity at temp 0** (`resolve-identity.ts`); ✅ **prompt echoes the computed scores** (`scoringConstraints`) so the model's narrative matches the displayed number; ✅ **`buildPriorContext` docstring** corrected (stateless generation).
- **Beta-calibration caveats (6b golden-set retune, spec §C/§E — not blockers):** coarse-ordinal boundary instability (a 7↔8 model waver flips 5↔10 on title's w20); the `utilisation < 20%` → 0 floor is harsh (a short brand title like "Hulu" scores 0).

**A7 · Post-review correctness fixes (code-review batch) — ✅ applied, committed & verified.** `tsc` is clean (the pre-existing `routes.ts` Hono skew is fixed with a scoped `c as any`), the occurrences regression test is added, suite green.
- ✅ **IntentTag import** — was a `tsc` TS2304 build break; fixed. With `routes.ts` resolved, **`tsc --noEmit` can now gate CI** (vitest strips types, so it can't replace this).
- ✅ **Orphaned rec occurrences** — `recordOccurrence` now records against the stored row id (`priorIdByRecKey`), not a freshly-minted one, so re-raised recs no longer log under orphan ids and belief-accumulation counts correctly. **Pinned** by `audit-memory.test.ts` ("re-raised rec logs 2 occurrences under the canonical stored id").
- ✅ **Human-confirmed `nicheBand`** — `resolveWithHistory`'s no-flip reuse now sets `nicheBand`, mirroring `applyHumanDecision`.
- ✅ **Replay drift** — `assembleReport` delegates `overallScore` to `replayOverallScore` (one normalization formula for live + replay).
- ✅ **Classifier logging** — `parseClassificationText` logs on JSON-parse / schema failure (a broken classifier is no longer indistinguishable from a legit "Unknown").
- ✅ **Reuse staleness (per-dimension)** — `SCORER_VERSION` folded into `dimensionInputHash`; `rubricVersion` checked in `listingUnchanged`.
- ✅ **Reuse staleness (whole-snapshot) — closed.** `rubricVersion` is now the **scoring fingerprint** = hash(rubric weights + `SCORER_VERSION`) via `scoring/version.ts: scoringVersion`, and `listingUnchanged` checks it — so a `coarseOrdinalScore`/`codeScore` change bumps `SCORER_VERSION` → changes the fingerprint → invalidates the whole-snapshot cache (no stale report). Folded into the existing stamp rather than a new column, so **no DB migration**. Pinned by `scoring/version.test.ts` (scorer-version change ⇒ different fingerprint); the misleading comment is corrected. **All A7 residuals are now closed.**
- **Reviewed & rejected (not bugs):** "domain-flip buries human confirmation forever" (it's the escalate/re-ask path); "contradiction guard leaves both proposed" (spec §C: flag, don't suppress).

---

## Phase B · P2 Image Analysis + ID-full — ✅ built & live-verified (219 tests, tsc clean)

**B0 · Reconciliation §G #1 — ✅ built.** `scoring/rubric.ts:83` "Readable on-image text (Apple OCR-indexes it)" → reworded to the v1.1.1 contested stance: "Readable on-image text (conversion lever; keyword indexing value a hypothesis)". The OCR-as-fact assertion is gone.

**B1 · Vision pass [live Gemini vision] — ✅ built**
- ✅ `vision/{types,client,phash,analyze,select,index}.ts` — Gemini vision over screenshots + icon (value-prop clarity, on-image-text readability, category cohesion), confidence-labelled (`Labelled<T> = {value, confidence}`), never flat verdicts. Icon: `phash.ts` dHash (jimp, pure-JS/ESM-safe) → 64-bit fingerprint + Hamming distance. `analyze.ts` orchestrates; folds into `scoring/signals.ts` screenshots/icon dimensions via `dimension-scorer.ts`.
- ✅ **Superseded A6's Phase-A placeholders.** `codeScore('screenshots')` now returns `visionResult.screenshotSetVerdict.coarseScore`; screenshots/icon confidence upgrades **`inferred` → `observed`** when a `visionResult` is present (`deriveConfidence`). *(previewVideo stays `inferred` — vision doesn't assess video; documented in-code, consistent with B1 scope.)*
- ✅ **Kept A6's determinism (critical).** The vision verdict is **coarse-ordinal `{0,5,10}`** — the client snaps any raw model number to an anchor (`client.ts`, temp 0), so a fresh re-judge can't swing the overall score. **Per-dimension reuse:** `select.ts: selectVisionResult` returns the stored verdict with **zero LLM** when screenshot+icon URLs are unchanged (pinned by `vision.test.ts`: `callCount === 0`). Vision verdict **+ model id stored in the snapshot** (`vision_result_json`, append-only `ALTER TABLE`); `SCORER_VERSION` bumped to `phase-b-v2` (was `phase-a-v1`), which (via `scoring/version.ts`) invalidates the whole-snapshot reuse cache so pre-B and un-capped snapshots re-score.

**B2 · ID-full — ✅ built**
- ✅ `identity/{id-full,identity-vision-client}.ts`. Vision-grounded identity (does creative match function?) + audience resolution. **Augments** the identity row to stage=`full` and **copies category / categoryBand / tally / divergence / source / niche verbatim** from the ID-lite prior — no re-tally, ID-lite's deterministic fields are never overwritten (pinned by `id-full.test.ts`).
- ✅ **De-escalation guard (safety-critical).** A vision "creative matches function" verdict clears an escalation **only** when `litePrior.escalate && litePrior.divergence !== 'cross_domain' && creativeMatchesFunction` — so vision can **never** override a hard cross-domain conflict (tested). `nicheBand` is raise-only. Appended via append-only `appendIdentity`; gated on `visionWasFresh` so an unchanged re-audit writes no duplicate full row.

**B3 · P2 secondary uplifts (spec §P2 "Secondary uplifts") — ✅ built.** `vision/secondary-uplifts.ts`.
- ✅ **Screenshot-set intelligence:** role-tag each panel (hero/feature/social-proof/cta), flag duplicate messages, and — **for non-panoramic sets only** — propose promoting the strongest panel into the search-visible slots (`promoteCandidateSlot` is `null` for panoramic sets; pinned).
- ✅ **Cross-device matrix:** `computeDeviceMatrix` is **pure code, no LLM** — iPhone/iPad slots used + `ipadMissing` (≥3-slot gap).
- ✅ **PPO ≤3-treatment brief:** `exceeded: treatmentCount > 3`.

**B4 · Phase-A carry-over fixes — ✅ fixed (were "tracked, not yet fixed" in STATUS).**
- ✅ **Applied-detection extended to `add_preview_video`** — auto-marks applied when `newListing.hasPreviewVideo === true`, placed **before** the `!afterText` early-return (preview-video recs have no `afterText`), so it actually fires.
- ✅ **Escalate-gate fix** — `buildPriorContext`'s "do not rewrite positioning" note now gates on `identity.escalate && identity.source !== 'human_confirmed'` (was `divergence === 'cross_domain'`), so a human-confirmed cross-domain identity is no longer warned.
- ✅ **Reachability guard** — the identify-step classifier calls `getLlmProvider().reachable()` before the LLM call, matching the score-listing pattern.
- ✅ **Efficiency** — `produceAuditDraft` accepts a `prebuiltPrompt` (prompt built once, reused for hashing + generation); `persistAudit` accepts pre-fetched `priorSnapshot`/`priorLedger` (no duplicate storage reads).

**B5 · Live-integration hardening — ✅ done (surfaced by a manual live audit of the real Rivian listing; the live Gemini-vision path is now exercised end-to-end, closing the "stub-can't-prove-reality" ship-gate).**
- ✅ **Apple-CDN base64 proxy.** Sending `mzstatic.com` URLs straight to Gemini returned empty critiques (Apple blocks the fetch). `client.ts: #fetchAsDataUrl` now fetches each image in Node and inlines it as a `data:…;base64` URL; wrapped in try/catch so a `!res.ok` **or** a thrown network error degrades to the original URL with a warning instead of crashing `Promise.all`.
- ✅ **Thinking-token truncation.** Gemini 2.5 Flash's reasoning consumed the `max_tokens` budget before emitting JSON → truncated response → backward-scan recovery returned `{}` → empty critiques. Raised vision `max_tokens` 2000 → 8000 (and identity-vision 400 → 800) and made the prompt request concise one-phrase critiques.
- ✅ **Honest degradation on parse failure (the key correctness fix).** A `{}`/truncated vision response must never surface as a confident number. Single shared guard `visionUsable(v) = !!v && v.screenshotSetVerdict.critiques.length > 0` now governs **all four** scoring/prompt sites in lockstep: `deriveConfidence('screenshots')` → `inferred` (not `observed`); `codeScore('screenshots')` → falls back to `slotsUsedOf10` (not the fabricated `5`); both `prompt.ts` sites (score-line + limitation-suppression) gate on it — so on failure the score is the honest slot count, the label is `inferred`, and the limitation surfaces, all consistent. **7 regression tests** cover the previously-uncovered empty-critiques path.
- ✅ **Screenshot slot-utilisation cap.** Gemini scores only the screenshots that exist, ignoring unused slots; `analyze.ts` caps `coarseScore` at 5 when `< 10` slots are used (only a full set of 10 can earn 10). Stays within `{0,5,10}` — determinism intact.
- ✅ **All per-slot critiques cited.** Prompt instructs the report LLM to include every per-slot vision critique as a separate evidence item (was citing only Slot 1).

**B-residuals (post-build review — ✅ all three resolved & tested):**
- ✅ **NoOp honesty — fixed.** Added `readonly isLive` to the `VisionClient` interface (Gemini/Stub `true`, `NoOpVisionClient` `false`); `analyze.ts` derives `resultConfidence = client.isLive ? 'observed' : 'inferred'` (and ANDs it into the pHash label), so a no-key vision result is never labelled `observed`. `NoOpIdentityVisionClient` now returns `creativeMatchesFunction: false, confidence: 'inferred'`, so an absent vision pass can no longer silently de-escalate a non-cross-domain escalation.
- ✅ **Vision schema-validation — fixed.** `VisionResultSchema` (Zod, `.passthrough()` sub-objects for forward-compat) added to `vision/types.ts`; `select.ts` uses `safeParse` and returns `null` on validation failure instead of a bare cast — a corrupt/drifted `vision_result_json` row no longer flows through unchecked.
- ✅ **Identity-ledger head — fixed (two mechanisms, decoupled).** `latestIdentity` now orders `CASE WHEN stage='full' THEN 0 ELSE 1 END, version DESC`, so a B2 `full` row stays the semantic head across lite-only re-audits (audience never buried). The version *counter* is decoupled: new `maxIdentityVersion` (`SELECT COALESCE(MAX(version), -1)`, stage-blind) drives `persistAudit`'s next-version, so monotonic numbering holds (no duplicate versions) even though the read prefers an older full row. Pinned by two conformance tests (full-preferred read; true-MAX counter) **+** a regression test (three unchanged re-audits → versions distinct, head stays `full`, audience preserved).

**Vision cost note:** vision is the most expensive call and its cache lands in **E1** (P5), so Phase B runs vision **uncached** — acceptable at single-user beta, but don't fan competitor vision out broadly until E1, and consider pulling a lightweight per-asset vision cache forward if B-phase iteration cost bites. *(Competitor visual benchmarking is deferred: the `Competitor` schema carries no image URLs yet, so pHash competitor-distance is a placeholder labelled `inferred` until Phase D wires competitor images.)*

**TDD first (§F P2 / ID-full) — ✅ all green:** each image gets a confidence-labelled critique; **identical image set ⇒ same vision score, zero LLM** (A6's reuse sub-bar, extended to vision); ID-full augments the identity row (stage=`full`) **without mutating** ID-lite's deterministic fields; pHash `observed`, confusability `inferred`; the promote-panel suggestion fires **only** on non-panoramic sets.

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

**D2 · Themes + routing — and the A3-deferred re-classification.** This is where `fix_complaint_theme` and `respond_to_reviews` **graduate from their A3 single-instance placeholders to multi-instance** (they fan out here, so their referents + `value_key` derivation land now):
- `reviews/themes.ts` — one LLM pass that extracts themes **and** classifies each to the canonical complaint taxonomy (15 buckets + `other`, spec §C). **`resolveThemeKey`:** a named bucket → the **bucket id** (no embedding needed); only **`other` → embedding-similarity fallback** (Gemini embeddings, cosine ≥ 0.85, labelled approximate). ⚠️ Never return literal `'other'` as the key — it would merge every uncategorized complaint into one row.
- **`respond_to_reviews` → `reviewId` referent.** First **verify Apple's RSS `<id>` is stable** across fetches (a given review's id should persist even as the 25→~500 window shifts); if it proves unreliable, `value_key` = a **content hash** (author + date + body). Decide here, with the 500-review fetch in hand.
- **Feature requests are disjoint** → human hand-off, no `value_key`, never ledgered. Per-version sentiment delta across the two latest versions. `taxonomy_version` stamped (`theme-taxonomy@1`).
- **TDD first (§F P4):** pagination to cap; per-version delta only above min sample; **dismissed complaint theme does not resurface** across perturbed samples (canonical-id **and** `other`-embedding paths). **Plus the de-placeholder guard — distinct items must produce distinct rows:** two genuinely different complaint themes → **two** `fix_complaint_theme` rows; two different review responses → **two** `respond_to_reviews` rows. If either still collapses, the A3 placeholder was never re-classified and Phase D isn't done.

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
- **DoD:** one US URL → four storefronts back with one rec per gap + per-rec proof regime; `STATUS.md` refreshed.

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
