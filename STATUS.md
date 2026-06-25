# Build Status — ASO Agent

**Where we stand.** A living dashboard, updated at the end of every phase. The
contracts live elsewhere: [`specification.md`](specification.md) is the *what*,
[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) is the *how-to-build*. This
file is the *where-we-are* — read it first, trust the tests over the prose.

_Last updated: 2026-06-25 · spec v1.3.1_

Legend: ✅ done & verified · 🚧 in progress · ⬜ not started · ⏸ deferred (by design)

## Phases

| Phase | Scope | Status | DoD gate |
|---|---|---|---|
| **0** | Groundwork: Gemini-only, migration runner | ✅ | suite green + live audit on Gemini |
| **A** | ID-lite identity + P1 persistent memory | ✅ | §F ID-lite **and** §F P1 green; 2nd audit references 1st, marks applied, never repeats |
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

## Tests (the source of truth)

- **88 hermetic tests pass** (`npm test`). Covers: StorageClient conformance,
  ID-lite §F gates, P1 §F gates (dedup, contradiction, zero-LLM replay),
  human-confirm reuse/re-ask, memory loop end-to-end.
- **Live smokes (gated on a Gemini key, skipped by default):**
  - `scoring/audit-smoke.test.ts` — full audit + identity + persist on real Gemini.
  - `mastra/workflow-smoke.test.ts` — real workflow suspend → resume(decision) → report.
  - Run: `dotenv -e ../../.env -- npx vitest run <path>` (Node ≥ 20.12 — see Gotchas).

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

- **Phase B (P2 + ID-full)** — start with reconciliation §G #1 (`rubric.ts:83`
  OCR wording), then the Gemini vision pass, then ID-full augmenting the identity
  row to stage=`full` without mutating ID-lite's deterministic fields.

## Key-arrival follow-ups (drop-in, one file each)

- **Web-search key** → replace `NoopWebSearch` (`sources/websearch/`) with Exa/Tavily.
- **ASA key** → P3 volume/popularity (Phase C).
