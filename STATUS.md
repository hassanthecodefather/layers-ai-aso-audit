# Build Status — ASO Agent

**Where we stand.** A living dashboard, updated at the end of every phase. The
contracts live elsewhere: [`specification.md`](specification.md) is the *what*,
[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) is the *how-to-build*. This
file is the *where-we-are* — read it first, trust the tests over the prose.

_Last updated: 2026-06-29 · spec v1.3.1 · **Phase B complete**_

Legend: ✅ done & verified · 🚧 in progress · ⬜ not started · ⏸ deferred (by design)

## Phases

| Phase | Scope | Status | DoD gate |
|---|---|---|---|
| **0** | Groundwork: Gemini-only, migration runner | ✅ | suite green + live audit on Gemini |
| **A** | ID-lite identity + P1 persistent memory | ✅ | §F ID-lite **and** §F P1 green; reworded re-raise collapses to one row (typed referent); 2nd audit references 1st, marks applied, never repeats. **A6 score determinism complete** (191 tests) |
| **B** | P2 image analysis + ID-full | ✅ | §F P2 green (vision confidence, zero-LLM reuse, pHash observed, promote-panel non-panoramic-only); ID-full stage=`full` augments identity without mutating ID-lite fields. **209 tests.** |
| **C** | P3 keyword research (160-char linter) | ⬜ | — |
| **D** | P4 deep review analysis | ⬜ | — |
| **E** | P5 cost & courtesy control | ⬜ | — |
| **F** | Net-new uplifts (storefront sweep, export, …) | ⬜ | — |
| **P6+** | Multi-tenant, ASC, write-path, North Star | ⏸ | planned at their tier, not now |

## Phase B — detail (current frontier)

| Task | Status | Lives in |
|---|---|---|
| B0 · Reconciliation §G #1 — rubric.ts:83 OCR wording | ✅ | `apps/server/src/scoring/rubric.ts` |
| B1 · Vision pass — Gemini vision over screenshots + icon | ✅ | `apps/server/src/vision/{types,client,phash,analyze,select}.ts`; `scoring/dimension-scorer.ts`; `domain/snapshot.ts`; `memory/libsql-storage-client.ts`; `memory/migrate.ts` |
| B2 · ID-full — vision-grounded identity, stage=`full` | ✅ | `apps/server/src/identity/{id-full,identity-vision-client}.ts`; `mastra/workflows/audit-workflow.ts` |
| B3 · P2 secondary uplifts — screenshot intelligence, cross-device matrix, PPO ≤3 | ✅ | `apps/server/src/vision/secondary-uplifts.ts`; `vision/client.ts` extended |
| B4 · Phase-A carry-over fixes — applied-detect (previewVideo), escalate gate, reachability guard, efficiency | ✅ | `memory/audit-memory.ts`; `scoring/score.ts`; `mastra/tools/resolve-identity.ts`; `mastra/workflows/audit-workflow.ts` |

**B1 notes:** `SCORER_VERSION` bumped to `'phase-b-v1'` (invalidates Phase A cached scores). Screenshots/icon confidence upgrades to `observed` when vision ran; `codeScore('screenshots')` returns vision coarse-ordinal {0,5,10}. `selectVisionResult` is a pure function — if screenshot/icon URLs match the prior snapshot's, returns stored VisionResult with zero LLM calls. `jimp` added for pHash computation (pure JS). Competitor icon/screenshot URLs are not available in `AppListing.Competitor` — competitor image comparison deferred to Phase D. `getVisionClient()` returns a no-op stub when no API key is set (all hermetic tests unaffected).

**B2 notes:** `runIdFull()` is a pure function — copies `category`, `categoryBand`, `tally`, `divergence`, `source` verbatim from ID-lite; vision adds `audience` and may raise `nicheBand`. De-escalation only fires when `litePrior.escalate && litePrior.divergence !== 'cross_domain' && creativeMatchesFunction`. `getIdentityVisionClient()` returns a no-op stub without API key.

**B4 fixes (carry-overs now closed):**
- `add_preview_video` recs now auto-detected as `applied` when `hasPreviewVideo` flips to true.
- `buildPriorContext` "do not rewrite positioning" note now gates on `escalate && source !== 'human_confirmed'` (not bare `divergence === 'cross_domain'`).
- Identify-step LLM call now has a `reachable()` guard (matches score-listing pattern).
- `buildAuditPrompt` built once per audit; `persistAudit` uses pre-fetched snapshot/ledger when provided.

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

- **209 hermetic tests pass** (`npm test`). Covers (Phase A): StorageClient conformance,
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

## Known gaps / deviations (conscious, not bugs)

- **#3 — IAP names & permission/privacy-label signal families** are modelled but
  report `not observed` (not in the iTunes Lookup response). They're
  corroboration, not load-bearing for the §F gates. *Wire via the crawler later.*
- **#1 (resolved)** — identity is resolved in the `identify-app` *step* (from its
  existing iTunes fetch), not by modifying the `identify-app` *tool*. The §G "no
  re-fetch" intent holds; documented as accepted.
- **Resolved** — the pre-existing `mastra/routes.ts` Hono `Context` type-skew on
  `streamSSE` is fixed with a scoped `c as any`; **`tsc --noEmit` is now fully clean**
  and can gate CI. `npm test` green (191).

## Gotchas

- **Node ≥ 20.12 required** (vitest 4 / rolldown). The shell may default to Node
  18 — `nvm use 24` first, or `npm install` + tests fail on a missing native binding.

## Next up

- **Phase B is complete (B0–B4 ✅, 209 tests).** Phase C next: the 160-char keyword linter (pure, no key needed) + ASA popularity client stub.
- **Phase C (P3 keyword research)** — start with `keywords/linter.ts` (deterministic, no key), then `keywords/asa-client.ts` stub behind the SourceProvider seam. The linter's TDD gate: same input → byte-identical output, no model call; competitor keyword findings labelled `inferred`.
- **Competitor icon/screenshot URLs** — deferred to Phase D when a competitor-detail fetch is added. `analyze.ts` currently passes empty arrays; update when URLs are available.

## Key-arrival follow-ups (drop-in, one file each)

- **Web-search key** → replace `NoopWebSearch` (`sources/websearch/`) with Exa/Tavily.
- **ASA key** → P3 volume/popularity (Phase C).
