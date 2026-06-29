# Build Status — ASO Agent

**Where we stand.** A living dashboard, updated at the end of every phase. The
contracts live elsewhere: [`specification.md`](specification.md) is the *what*,
[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) is the *how-to-build*. This
file is the *where-we-are* — read it first, trust the tests over the prose.

_Last updated: 2026-06-26 · spec v1.3.1_

Legend: ✅ done & verified · 🚧 in progress · ⬜ not started · ⏸ deferred (by design)

## Phases

| Phase | Scope | Status | DoD gate |
|---|---|---|---|
| **0** | Groundwork: Gemini-only, migration runner | ✅ | suite green + live audit on Gemini |
| **A** | ID-lite identity + P1 persistent memory | ✅ | §F ID-lite **and** §F P1 green; reworded re-raise collapses to one row (typed referent); 2nd audit references 1st, marks applied, never repeats. **A6 score determinism complete** (186 tests) |
| **B** | P2 image analysis + ID-full | ⬜ | — |
| **C** | P3 keyword research (160-char linter) | ⬜ | — |
| **D** | P4 deep review analysis | ⬜ | — |
| **E** | P5 cost & courtesy control | ⬜ | — |
| **F** | Net-new uplifts (storefront sweep, export, …) | ⬜ | — |
| **P6+** | Multi-tenant, ASC, write-path, North Star | ⏸ | planned at their tier, not now |

## Phase A — detail (current frontier)

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

- **186 hermetic tests pass** (`npm test`). Covers: StorageClient conformance,
  ID-lite §F gates, P1 §F gates (dedup, contradiction, zero-LLM replay),
  human-confirm reuse/re-ask, memory loop end-to-end, classifier fail-safe
  parsing, dismissal-is-honoured, **reworded re-raise collapses to one row**,
  **reworded re-raise of a dismissed rec is still caught** (referent stability
  makes dismissals sticky across rewordings), the Mastra
  `getStepResult`-across-resume contract A5 relies on, and **A6 score
  stability** (`a6-score-stability.test.ts`, `dimension-scorer.test.ts`):
  code-derived confidence/scores override the model, single-field edit moves
  only that dimension, deterministic-dimension scores are pure functions of
  signals.
- **Live smokes (gated on a Gemini key, skipped by default):**
  - `scoring/audit-smoke.test.ts` — full audit + identity + persist on real Gemini.
  - `mastra/workflow-smoke.test.ts` — real workflow suspend → resume(decision) → report.
  - Run: `dotenv -e ../../.env -- npx vitest run <path>` (Node ≥ 20.12 — see Gotchas).

## Code review (high-effort pass, 2026-06-25)

Fixed + tested: dismissed recs no longer silently re-open on re-raise; the
identity classifier fails safe instead of throwing on malformed JSON; the
`getStepResult`-across-resume assumption is now guarded (it holds).

Still open (tracked, not yet fixed — fold into Phase B):
- **applied-detection coverage** — `listingField()` only maps title/subtitle/
  description, so keywordField/icon/screenshots/reviews recs never flip to
  `applied`.
- **stale divergence in prompt** — a human-confirmed cross-domain identity still
  triggers the "do not rewrite positioning" warning in `buildPriorContext`
  (gate on `escalate`/`source`, not `divergence`).
- **reachability/error labelling** — the identify-step LLM call has no
  `reachable()` guard, so a down model surfaces as a 422 "bad URL".
- **efficiency** — `buildAuditPrompt` built twice per audit; `persistAudit`
  re-reads snapshot/ledger already fetched in the score step.

## Known gaps / deviations (conscious, not bugs)

- **#3 — IAP names & permission/privacy-label signal families** are modelled but
  report `not observed` (not in the iTunes Lookup response). They're
  corroboration, not load-bearing for the §F gates. *Wire via the crawler later.*
- **#1 (resolved)** — identity is resolved in the `identify-app` *step* (from its
  existing iTunes fetch), not by modifying the `identify-app` *tool*. The §G "no
  re-fetch" intent holds; documented as accepted.
- **Pre-existing** — one typecheck error in `mastra/routes.ts` (a Hono `Context`
  type-skew on `streamSSE`) predates this work and is untouched. `npm test` is green.

## Gotchas

- **Node ≥ 20.12 required** (vitest 4 / rolldown). The shell may default to Node
  18 — `nvm use 24` first, or `npm install` + tests fail on a missing native binding.

## Next up

- **Phase A is complete (A0–A6 ✅).** When starting Phase B, remember **B1 must supersede A6's screenshot/preview Phase-A placeholder scores** and upgrade their confidence `inferred → observed` once vision actually assesses quality.
- **Phase B (P2 + ID-full)** — start with reconciliation §G #1 (`rubric.ts:83`
  OCR wording), then the Gemini vision pass, then ID-full augmenting the identity
  row to stage=`full` without mutating ID-lite's deterministic fields.

## Key-arrival follow-ups (drop-in, one file each)

- **Web-search key** → replace `NoopWebSearch` (`sources/websearch/`) with Exa/Tavily.
- **ASA key** → P3 volume/popularity (Phase C).
