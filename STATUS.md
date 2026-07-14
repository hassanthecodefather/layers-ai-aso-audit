# Build Status — ASO Agent

**Where we stand.** A living dashboard, updated at the end of every phase. The
contracts live elsewhere: [`specification.md`](specification.md) is the *what*,
[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) is the *how-to-build*. This
file is the *where-we-are* — read it first, trust the tests over the prose.

_Last updated: 2026-07-11 · spec v1.3.2 · **Phase E complete (400 tests); Phase F base DoD met + F-K5 shipped (437 tests); F-K2 ✅ + F-K3 ✅ shipped (475 tests); F-K4 pending; Identity-confirmation guard (Fix 5) ✅ shipped + live-smoke corrections ✅ — 534 tests; Phase 6a (auth + Postgres swap + shared rate limiter) ✅ shipped — 584 tests, tsc clean both apps; Phase 6a security hardening ✅ (3 review passes, 23 fixes) + websearch probe correctness ✅; Phase 6b (durable queue + observability) ✅ shipped — 613 tests, tsc clean; Post-6b live-run fixes ✅ — suggestedCategory persistence + UI + scoring rule, governor leak, secondary advisory false fire, pacer hot-path overhead, vision token budgets; P7-B (continuous tracking) ✅ shipped — hourly scan, 3 change event types, TrackingCard + ActivityFeed; P7-C (measurement windows) ✅ shipped — 28-day correlational before/after, 5-step scheduler, measurement_verdict card — 676 tests (1 pre-existing failure)**_

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
| **6a** | Auth + Postgres swap + shared rate limiter | ✅ | JWT auth · `PostgresStorageClient` conformance suite green · `PostgresSharedPacer` two-instance serialization. 584 tests, tsc clean. |
| **6b** | Durable queue + observability baseline | ✅ | `aso_audit_jobs` table · worker loop (`SKIP LOCKED`) · SSE → polling · Pino telemetry · gateway/LLM/step logs. 613 tests, tsc clean. |
| **P7-B** | Continuous tracking — hourly scan, change events, UI | ✅ | `aso_tracked_apps` + `aso_change_events` tables · 3 scan checks (version/metadata/reviews) · `go_live` triggers re-audit · TrackingCard + ActivityFeed + Activity tab. 676 tests. |
| **P7-C** | Measurement windows — 28-day correlational before/after | ✅ | `aso_measurement_windows` table · `openWindow`/`getWindowsInState`/`updateWindowState` store · `computeVerdict` pure function · reporter wrapping AscAnalyticsClient · 5-step hourly scheduler · `measurement_verdict` change event + ActivityFeed card. 676 tests. |
| **P7-D+** | Cost economics, write-path, North Star | ⏸ | planned at their tier, not now |

## Identity-confirmation guard (Fix 5) — detail

**Status: ✅ shipped + live-smoke corrections applied** (commits `29b0491..929bcaf`, 16 commits; 534 tests / 3 live-smoke skips; server + web `tsc` clean). Spec [`docs/superpowers/specs/2026-07-07-identity-confirmation-guard-design.md`](docs/superpowers/specs/2026-07-07-identity-confirmation-guard-design.md). Full write-up in [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) (Identity-escalation fixes → Fix 5).

**The bug:** a *wrong* human identity confirmation (operator picks "Travel" for an app whose evidence reads "EV") was obeyed without challenge and never re-validated — a self-contradictory audit (travel competitors + `reposition_identity` rec while the scorer re-derived EV), sticky forever with no re-ask and no reset.

| Part | What shipped | Lives in |
|---|---|---|
| **A · Challenge then obey** | `confirm-app` is a two-stage gate: a contested override (`divergenceBetween(chosen, evidence)==='cross_domain'`) re-suspends with an evidence-backed `conflict` payload; accepted only on revise or `overrideAcknowledged`. | `identity/human-confirm.ts` (`isContestedOverride`), `identity/evidence-explain.ts`, `mastra/workflows/audit-workflow.ts` (`confirmStep`, `ConflictSchema`), `mastra/routes.ts` (conflict SSE), web `ConfirmationCard.tsx` (`ChallengeCard`) + `hooks/useAudit.ts` (`confirmAnyway`) |
| **B · Marker + lifecycle** | `overrodeEvidence:{category,niche,functionTerms}` set by `applyHumanDecision` (+ stale `divergence`/`niche`/`functionTerms` fixes), carried through reuse, **persisted + re-read** (`overrode_evidence_json`), re-surfaced on every run at 0 LLM cost; `reopenIdentity` reset. | `domain/identity.ts`, `identity/resolve.ts`, `identity/human-confirm.ts`, `mastra/tools/resolve-identity.ts`, `memory/{migrate,libsql-storage-client,storage-client.conformance}.ts`, `audit-workflow.ts` (`buildOverrideNotes`, `selectPrior`) |
| **C · Honest competitors** | Multi-signal structured seeds (`niche → category → functionTerms`, Rivian→EVgo/PlugShare guarded); contested-case `fetchEvidenceCompetitors` dual-discovery → evidence-side teaser (≤3) in a mismatch-check note; primary competitor set never mutated. | `sources/function-competitors.ts`, `audit-workflow.ts` |

**Honesty spine upheld:** scorer LLM's read of the app is never gagged (residual EV findings stay, now explained); evidence competitors are a comparison, never a silent swap. **Determinism upheld:** reuse never re-runs the classifier; marker captured once at decision time.

**Process note:** the whole-branch review caught a Critical the per-task reviews structurally couldn't — the marker was built in-memory but never written to / read from `aso_identity_versions`, so Part B silently failed after the decision run. Fixed (`b8d0832`) with a stash-proven conformance round-trip.

**Live smoke completed (`929bcaf`) — 7 bugs found and fixed:**

| # | Bug | Fix |
|---|---|---|
| 1 | `buildOverrideNotes` hardcoded "Little overlap" regardless of actual overlap | Set-based comparison → 3 distinct notes (identical / no overlap / partial overlap) |
| 2 | `fetchEvidenceCompetitors` seeded from category phrase ("Electric vehicle companion" → Travel in AppKittie) | Seed from `functionTerms` directly; fall back to category only when absent |
| 3 | `runIdFull` re-escalated `human_confirmed` when `visionEscalation` was true | Guard: `source === 'human_confirmed'` → `escalate: false` always |
| 4 | `runIdFull` dropped `overrodeEvidence` on the full row | Carry `litePrior.overrodeEvidence ?? null` to the full row |
| 5 | `latestIdentity` SQL: `full > lite` priority applied globally, so an older full row beat a newer lite row after "Change identity" | Restrict `full > lite` to non-`human_confirmed` rows only |
| 6 | Blank screen from `useCallback` temporal dead zone (`streamHandlers` after `submitUrl`) | Move `streamHandlers` before `submitUrl` |
| 7 | Re-audit silently accepted contested override (challenge never re-fired) | `confirmStep`: re-suspend when `decision === null && overrodeEvidence && !overrideAcknowledged`; fix `confirmAnyway` guard to allow `pendingDecision === null` |

**Also added:** "Previously confirmed" banner (re-audit lightweight card); "Change identity" button (`reopenIdentity` force-fresh resolve).

## Phase 6a — detail

**Status: ✅ shipped** (branch `phase-6a-multi-tenant`, 584 tests / tsc clean). Specs: [`docs/superpowers/specs/2026-07-08-6a-postgres-swap-design.md`](docs/superpowers/specs/2026-07-08-6a-postgres-swap-design.md) + [`docs/superpowers/specs/2026-07-08-6a-shared-limiter-design.md`](docs/superpowers/specs/2026-07-08-6a-shared-limiter-design.md). Plans: [`docs/superpowers/plans/2026-07-08-6a-postgres-swap.md`](docs/superpowers/plans/2026-07-08-6a-postgres-swap.md) + [`docs/superpowers/plans/2026-07-08-6a-shared-limiter.md`](docs/superpowers/plans/2026-07-08-6a-shared-limiter.md).

### 6a Auth (prior session)

JWT-based authentication: signup / login / logout / refresh (token rotation), HMAC-signed JWTs, refresh-token rotation, cross-tenant IDOR fix, timing-attack mitigation via constant-time compare, frontend auth gate. `getUserStore()` stays LibSQL; tenant isolation confirmed by conformance suite.

### 6a Postgres Swap

| Component | What shipped | Lives in |
|---|---|---|
| **Infrastructure** | Docker Compose (`postgres:17`), healthcheck via `pg_isready`; `DATABASE_URL` / `DATABASE_TEST_URL` env vars | `compose.yml`, `.env` |
| **Migration runner** | `runPgMigrations(sql)` applies shared `MIGRATIONS` + `PG_ONLY_MIGRATIONS` (PG-only DDL: `TIMESTAMPTZ`, `ADD COLUMN IF NOT EXISTS` via regex, `aso_competitor_tombstones` PK rebuild to include `tenant_id`) | `memory/pg-migrate.ts` |
| **Storage client** | `PostgresStorageClient` — all 10 `StorageClient` methods via postgres.js tagged-template SQL | `memory/postgres-storage-client.ts` |
| **Conformance suite** | Schema-per-test-run isolation; all conformance tests pass against Postgres | `memory/postgres-storage-client.test.ts` |
| **Factory** | `getStorage()` returns `PostgresStorageClient` when `DATABASE_URL` set, `LibSqlStorageClient` otherwise; `getPgSql()` singleton | `memory/index.ts` |
| **Boot** | Postgres migration runs eagerly at startup from `mastra/index.ts` when `DATABASE_URL` present | `mastra/index.ts` |

**`getUserStore()` and Mastra's `LibSQLStore` remain on LibSQL throughout** — auth + workflow state are not affected by the swap.

**Key bugs caught by conformance suite and final review:**
- `maxIdentityVersion` returned 0 for empty table (should be −1) → `COALESCE(MAX(version), -1)`
- `latestIdentity` sorted by version only → add `human_confirmed`-first + `full`-stage-first ordering
- Nullable recommendation fields returning `undefined` (`.nullable()` rejects `undefined`) → return `null`
- Optional snapshot blobs stored as JSON `"null"` string → stored as SQL NULL
- `aso_competitor_tombstones` PK missing `tenant_id` → cross-tenant tombstone collision → added PK rebuild in `PG_ONLY_MIGRATIONS`
- `#parseIdentity` `niche`/`nicheBand`/`audience` returning `undefined` instead of `null` → Zod `.nullable()` rejection in production → fixed to `null`

### 6a Shared Rate Limiter

`PostgresSharedPacer` replaces the process-local `SerialPacer` when `DATABASE_URL` is set. Uses `SELECT … FOR UPDATE` inside a `sql.begin()` transaction to serialize slot claims across multiple server instances, keeping the aggregate Apple API call rate within the ~20 calls/min ceiling.

| Component | What shipped | Lives in |
|---|---|---|
| **Slot table** | `aso_rate_slots (key TEXT PRIMARY KEY, next_allowed_at TIMESTAMPTZ)` seeded with `'itunes'` row | `memory/pg-migrate.ts` (`PG_ONLY_MIGRATIONS`) |
| **Pacer** | `PostgresSharedPacer` — `wait(retryAfterMs?)` claims a slot atomically, sleeps only after the transaction commits; `reset()` is a no-op | `cost/postgres-pacer.ts` |
| **Factory** | `getPacer()` returns `PostgresSharedPacer` when `DATABASE_URL` set, `SerialPacer` otherwise; pacer uses its own connection pool (does not share `getPgSql()`) | `cost/pacer.ts` |
| **Tests** | Sequential spacing ≥ 3500ms; concurrent callers serialize (the §F DoD gate) | `cost/postgres-pacer.test.ts` |

**Known gaps / deferred:**
- **6a entity-shared cache** — still deferred; cache is process-local for now.

## Phase 6b — detail

**Status: ✅ shipped** (branch `phase-6b-durable-queue`, 613 tests / tsc clean). Specs: [`docs/superpowers/specs/2026-07-09-6b-durable-queue-design.md`](docs/superpowers/specs/2026-07-09-6b-durable-queue-design.md) + [`docs/superpowers/specs/2026-07-09-6b-observability-design.md`](docs/superpowers/specs/2026-07-09-6b-observability-design.md). Plan: [`docs/superpowers/plans/2026-07-09-6b-durable-queue-observability.md`](docs/superpowers/plans/2026-07-09-6b-durable-queue-observability.md).

### Durable queue

Replaces the in-memory SSE/`pendingRuns` approach with a Postgres-backed job queue. The server returns `{ jobId, runId }` immediately on `POST /audit/start`; a worker loop claims and executes jobs; the client polls `GET /audit/status/:runId` every 2500 ms.

| Component | What shipped | Lives in |
|---|---|---|
| **Job table** | `aso_audit_jobs` (id, run_id, tenant_id, url, reopen_identity, status, step, suspend_payload_json, resume_data_json, result_json, error_message, attempt, max_attempts, TIMESTAMPTZ timestamps) + 2 indices | `memory/pg-migrate.ts` (`PG_ONLY_MIGRATIONS`) |
| **Job store** | `insertJob`, `claimNextJob` (`UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED) RETURNING *`), `markJob{Running,Suspended,Done,Failed,Requeued}`, `recoverStaleJobs` (reset `running` jobs with `claimed_at < NOW() - 15 min`) | `queue/job-store.ts` |
| **Worker loop** | `executeJob` (fresh → `run.start()`, resume → `resumeStream`); `startWorker` (recover stale on startup, poll every 5 s); worker launched after migrations complete | `queue/worker.ts`, `mastra/index.ts` |
| **Server routes** | `POST /audit/start` → `{ jobId, runId, status }`; `GET /audit/status/:runId`; `POST /audit/confirm`; old SSE routes `/audit/identify` + `/audit/run` → 410 Gone | `mastra/routes.ts` |
| **Web client** | `startAudit` / `pollStatus` / `confirmAudit` in `api.ts`; `useAudit` rewritten as a polling state machine (`idle → starting → running → confirming → done`) | `web/src/lib/api.ts`, `web/src/hooks/useAudit.ts` |

**Key correctness fixes applied after adversarial review (2 passes, 12 bugs):**
- Worker poll loop wraps `executeJob` in try/catch — a DB error in the error-handling path no longer kills the worker
- `startWorker` chains after `runPgMigrations` resolves — no migration race on fresh deployment
- `markJobPending` has a `WHERE status = 'awaiting_confirmation'` guard; confirm route returns 409 on concurrent double-tap; client treats 409 as "already confirmed, keep polling"
- Poll loop counts consecutive 500 errors; stops and surfaces an error state after 5
- `recoverStaleJobs` resets `attempt = 0` alongside status
- `markJobDone` / `markJobFailed` add `AND status = 'running'` guard — prevent overwriting a re-queued row
- Fresh-run path now calls `markJobRunning(sql, job.id, 'identify-app')` before `run.start()`
- `telemetry.ts` creates `PinoLogger` with `FileTransport` synchronously (IIFE, try/catch) so Mastra captures the correct logger instance at construction time

### Observability baseline

Structured Pino log lines at every external call boundary. All log output goes to stdout; file transport attached if `ASO_LOG_PATH` or the default path is writable.

| Layer | Log event | Fields |
|---|---|---|
| Provider fetches (gateway) | `provider_call` | provider, operation, durationMs, status (ok/error/timeout), httpStatus, errorMessage, coalesced |
| Postgres rate-slot (pacer) | `provider_call` | provider=`postgres-pacer`, operation=`rate-slot`, status |
| Gemini classify (resolve-identity) | `provider_call` | provider=`gemini`, operation=`classify`, durationMs, status, inputTokens?, outputTokens? |
| Workflow step completion | `step_summary` (info) | step, step-specific fields (escalate, divergence, footprintState, categoryBand, reviewCount, overallScore, accepted, overridden) |
| Workflow step full data | `step_payload` (debug) | step, full payload (silent in production; set `LOG_LEVEL=debug` to activate) |

**Shared logger:** `telemetry.ts` exports a single `PinoLogger` singleton (`logger`) consumed by gateway, pacer, resolve-identity, and audit-workflow. `LOG_LEVEL` env var controls verbosity (default `info`).

**Known limitations / deferred:**
- `estimatedCostUsd` not yet computed in `provider_call` lines for Gemini (no pricing table wired)
- `tenantId` threaded into gateway calls via `GatewayCall.tenantId` but not yet passed from workflow call sites — most `provider_call` lines omit it
- `recoverStaleJobs` runs once at startup (plan-mandated); periodic recovery under a multi-replica worker pool is deferred
- Fresh-run step progress is a single `identify-app` snapshot; full per-step streaming for the fresh path deferred

## Post-6b live-run fixes (2026-07-10)

**Status: ✅ shipped.** Six correctness fixes and one feature landed during live-run testing after 6b.

### `suggestedCategory` persistence + UI + scoring

End-to-end plumbing so the identity classifier's best-fit Apple category travels from classification → DB → UI → scoring LLM without non-determinism:

| Part | What shipped | Lives in |
|---|---|---|
| **Schema** | `suggested_category TEXT` column added to `aso_identity_versions`; migration added | `domain/identity.ts` (`IdentityVersionSchema`), `memory/migrate.ts` |
| **Storage** | `appendIdentity` writes `suggested_category`; `#parseIdentity` reads it back | `memory/postgres-storage-client.ts`, `memory/libsql-storage-client.ts` |
| **Reuse path** | `identityVersionToResolved` now propagates `suggestedCategory` instead of hardcoded `null` | `identity/human-confirm.ts` |
| **Web types** | `suggestedCategory?: string \| null` added to web `ResolvedIdentity` interface | `web/src/lib/types.ts` |
| **UI banner** | Orange "App Store category is X — a better fit may be Y" banner shown whenever `identity.divergence === 'cross_domain'` AND pending AND `primaryGenre` present; uses `suggestedCategory` (Apple category name) when available, falls back to function description | `web/src/components/ConfirmationCard.tsx` |
| **Scoring rule** | CATEGORY RECOMMENDATION RULE added to prompt: when `buildPriorContext` emits a `⚠ CATEGORY MISMATCH` line naming the target Apple category, the scoring LLM MUST use that category verbatim in any `reposition_identity` rec — no independent re-pick | `scoring/prompt.ts` |

**Root cause:** `suggestedCategory` was emitted by the Gemini identity classifier (`resolve.ts` / `resolve-identity.ts`) but never persisted — every re-run re-classified, producing different answers (e.g. "Utilities" vs "Lifestyle"). The scoring LLM then independently re-picked a third answer, making the UI banner, the audit narrative, and the Quick Wins recommendation all disagree.

### Bug fixes (code review batch)

| # | Bug | Fix | Lives in |
|---|---|---|---|
| 1 | **Governor leak** — `startRun()` called before `try/finally`; the tenantId guard between them could throw, leaving the governor slot permanently locked with no `endRun()` | Moved the tenantId guard inside the `try` block; `endRun()` in `finally` now always runs | `mastra/workflows/audit-workflow.ts` |
| 2 | **Secondary advisory false fire** — `⚠ SECONDARY CATEGORY MISSING` note fired even when the primary category was absent (no genres at all → spurious note) | Added `hasPrimary` guard: only fires when primary genre exists but secondary is absent | `memory/audit-memory.ts` |
| 3 | **Pacer hot-path INSERT overhead** — self-healing upsert in `PostgresSharedPacer.wait()` executed a full INSERT ON CONFLICT on every iTunes API call as pure overhead | Removed self-healing upsert; the migration's `INSERT` seeds the row at DB creation; `wait()` is now SELECT FOR UPDATE + UPDATE only | `cost/postgres-pacer.ts` |

### Vision `max_tokens` increases

Gemini 2.5 Flash thinking tokens consume the call's token budget before JSON output begins, truncating responses to ~300 chars → unparseable.

| Call site | Before | After |
|---|---|---|
| `analyzeScreenshotSet` | 1 500 | 8 000 |
| `analyzeIcon` | 400 | 1 500 |
| Identity vision (`analyzeCreativeMatch`) | 800 | 2 000 |

`analyzeScreenshots` was already raised to 8 000 in B5. `reasoning_effort: 'none'` also added to all three vision calls to disable thinking entirely for structured-extraction calls.

### Infrastructure / ops

- **Disk full recovery** — Docker host ran out of space (~37 GB reclaimable images + ~11 GB build cache). Fixed with `docker system prune -af --volumes`. **Side effect: `pgdata` volume wiped → DB reset to empty.** ⚠️ **Rebuild required** to re-deploy all current code.
- **`aso_rate_slots` seed** — The `'itunes'` row must exist before `PostgresSharedPacer.wait()` is called. After the volume wipe it was absent; inserted manually via: `docker exec layers-ai-aso-audit-db-1 psql -U aso -d aso_audit -c "INSERT INTO aso_rate_slots (key, next_allowed_at) VALUES ('itunes', NOW()) ON CONFLICT (key) DO NOTHING;"`. A clean rebuild re-seeds via the migration automatically.
- **Two compose files** — `compose.yml` (db only) and `docker-compose.yml` (app + db). Docker Compose picks `compose.yml` by default when both are present; use `docker compose -f docker-compose.yml up -d` for the full stack. Low-priority cleanup: merge db service into `docker-compose.yml` and delete `compose.yml`.

## P7-C — Measurement Windows — detail

**Status: ✅ shipped** (8 commits `f20cd70..92fbbb3`, 676 tests / 1 pre-existing failure / 5 skipped). Plan: [`docs/superpowers/plans/2026-07-11-p7c-measurement-windows.md`](docs/superpowers/plans/2026-07-11-p7c-measurement-windows.md).

28-day correlational before/after measurement for ASO recommendations. When a tracked app goes live, a window opens, fetches baseline and after-period analytics via Apple Search Ads Analytics API, runs `computeVerdict`, and emits a `measurement_verdict` change event shown in the web Activity feed.

| Component | What shipped | Lives in |
|---|---|---|
| **DB migration** | `aso_measurement_windows` table + `aso_measurement_windows_tenant_state` index + `aso_measurement_windows_uniq_version` unique index | `memory/pg-migrate.ts` (`PG_ONLY_MIGRATIONS`) |
| **Types** | `MeasurementWindow`, `WindowState`, `VerdictMetrics`, `VerdictJson` | `measurement/types.ts` |
| **Store** | `openWindow` (null on duplicate), `getWindowsInState` (all tenants, ORDER BY updated_at ASC), `updateWindowState` (COALESCE partial updates) | `measurement/store.ts` |
| **Verdict** | `computeVerdict(baseline, after, mixedAuthorship?)` — pure function; deltaPercent formula with zero-baseline guard; `windowDays: 28` literal; `regime: 'correlational'` literal | `measurement/verdict.ts` |
| **Reporter** | `requestReport` / `pollReport` thin adapters over `AscAnalyticsClient`; `analytics-client.ts` updated to include `startTime`/`endTime` in POST body | `measurement/reporter.ts`, `asc/analytics-client.ts` |
| **Scheduler** | `startMeasurementScheduler(mastra, sql): SchedulerHandle` — 5-step hourly tick: openWindows → submitBaseline → pollBaseline → submitAfter → pollAfterAndClose; per-step + per-window try/catch; `failWindow` helper; `isStale` (7-day timeout) applied to both pending polls and creds-revoked skip path | `measurement/scheduler.ts` |
| **Change event type** | `measurement_verdict` added to `ChangeEventType` and `ActivityEvent.eventType` | `tracking/types.ts` |
| **Server wire-up** | `startMeasurementScheduler` started after migrations; `measurer.stop()` on SIGTERM/SIGINT | `mastra/index.ts` |
| **Web UI** | `measurement_verdict` added to web `ActivityEvent.eventType`; blue card variant in `ActivityFeed.tsx` with metric deltas + disclaimer + mixedAuthorship note | `web/src/lib/api.ts`, `web/src/components/ActivityFeed.tsx` |

**Known deferred items:**
- `awaiting_baseline` and `awaiting_after` states have no timeout (a window stuck before step 2 can linger indefinitely — creds-revoked skip path covered for `polling_*` states but not `awaiting_*`).
- Step 5's `updateWindowState('closed')` and `insertChangeEvent` are two sequential awaits — not wrapped in a transaction (transient DB error between them leaves window in inconsistent closed/error state).

## P7-B — Continuous Tracking — detail

**Status: ✅ shipped** (7 commits `a3afdaf..8b83427`). Plan: earlier session.

Hourly scan of tracked apps for version changes, metadata drift, and review shifts. Emits typed change events; re-queues a full audit on go-live.

| Component | What shipped | Lives in |
|---|---|---|
| **DB migration** | `aso_tracked_apps` + `aso_change_events` tables + 2 indices | `memory/pg-migrate.ts` (`PG_ONLY_MIGRATIONS`) |
| **Store** | `upsertTrackedApp`, `getTrackedApp`, `getDueApps`, `updateLastScanned`, `disableTrackedApp`, `insertChangeEvent`, `getLastChangeEvent`, `getChangeEvents` | `tracking/store.ts` |
| **Types** | `TrackedApp`, `ChangeEventType` (`go_live | metadata_changed | reviews_shifted | version_status | measurement_verdict`), `ActivityEvent` | `tracking/types.ts` |
| **Routes** | `POST /tracking`, `GET /tracking`, `DELETE /tracking/:appId`, `GET /activity` | `tracking/routes.ts` |
| **Scan** | `runScan(app, tenantId, sql, mastra)` — 3 independent checks: (1) version status via App Store Connect, (2) iTunes metadata diff (title/description/icon/screenshots), (3) RSS review rating/count shift; each check independently try/caught; `go_live` triggers `insertJob`; latest version sorted by `createdDate` descending | `tracking/scan.ts` |
| **Scheduler** | `startTrackingScheduler(mastra, sql): SchedulerHandle` — hourly tick, immediate first pass; per-app try/catch; `updateLastScanned` called even when scan throws | `tracking/scheduler.ts` |
| **Web UI** | `TrackingCard` (enable/disable per report), `ActivityFeed` (go_live / metadata_changed / reviews_shifted cards), Activity tab in `App.tsx` | `web/src/components/TrackingCard.tsx`, `web/src/components/ActivityFeed.tsx`, `web/src/App.tsx` |

**Post-ship fixes (same branch):** dropped `subtitle` from iTunes metadata diff (Apple API doesn't return it); sort versions by `createdDate` descending before taking `[0]`; independently wrap each iTunes check in try/catch; TS2367 cast in `store.test.ts`.

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

- **676 tests pass** (1 pre-existing failure in `scan.test.ts` / 5 live-smoke skips). Covers (Phase A): StorageClient conformance,
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

## Code review — Phase 6a security pass (2026-07-08)

11 findings reviewed (1 refuted); 8 fixed, 2 documented as known limitations:

| # | File | Severity | Fix |
|---|---|---|---|
| 1 | `mastra/routes.ts:260` | Critical | Reject unknown `runId` — `pendingRuns` is in-memory; post-restart rehydration would let any tenant resume any run. Users must re-identify after a restart. |
| 2 | `auth/token.ts:16` | Critical | `jwtVerify` now passes `{ algorithms: ['HS256'] }` — prevents algorithm substitution attacks. |
| 3 | `memory/migrate.ts:162` | High | Added `CREATE UNIQUE INDEX aso_refresh_tokens_token_hash` — prevents duplicate token_hash rows from surviving revocation. |
| 4 | `cost/postgres-pacer.ts:19` | High | **By design.** Global `'itunes'` slot is correct: Apple bans the server IP, not per-tenant. One burst from any tenant counts against the shared ceiling. Fairness queuing is a future feature. |
| 5 | `audit-workflow.ts:322` | High | `tenantId ?? 'default'` replaced with an explicit throw — a missing `identifyStep` result now fails loudly instead of silently writing all data to a phantom `'default'` tenant. |
| 6 | `libsql-storage-client.ts:346` | High | **LibSQL limitation.** `aso_competitor_tombstones` PK is `(app_id, country, competitor_app_id)` and SQLite cannot rebuild it. The Postgres path already has the correct 4-col PK via `PG_ONLY_MIGRATIONS`. On LibSQL, a tombstone from any tenant blocks the same competitor for all tenants (beta single-tenant path, acceptable). |
| 7 | `libsql-storage-client.ts:237` | Medium | `INSERT OR IGNORE` → `ON CONFLICT DO UPDATE SET was_dismissed = MAX(was_dismissed, excluded.was_dismissed)` — dismissal state is no longer silently dropped on an existing row. Same fix applied to `postgres-storage-client.ts` using `GREATEST()`. |
| 8 | `libsql-storage-client.ts:141` | Medium | Added `target_field = excluded.target_field` to `upsertRecommendation` DO UPDATE — stale slot label no longer persists. Same fix applied to `postgres-storage-client.ts`. |
| 9 | `memory/pg-migrate.ts:20` | Medium | Replaced two separate ALTER TABLE statements with a single PL/pgSQL DO block — the `IF NOT EXISTS` + `EXCEPTION WHEN others` guard makes concurrent startup idempotent. |
| 10 | `cost/pacer.ts:65` | Medium | `postgres(dbUrl, { max: 2 })` — limits the pacer's independent pool to 2 connections (one active FOR UPDATE tx + one queued) vs. the default 10, keeping combined pool count bounded. |

## Code review — Phase 6a security pass 2 (2026-07-08)

7 findings reviewed (1 refuted); 6 fixed, 1 known structural limitation:

| # | File | Severity | Fix |
|---|---|---|---|
| 1 | `auth/user-store.ts:findAndConsumeRefreshToken` | Critical | TOCTOU in refresh-token rotation: two concurrent requests could both pass `revoked_at IS NULL`. Fixed with atomic `UPDATE … RETURNING … WHERE revoked_at IS NULL AND expires_at > ?` — no transaction needed; SQLite's row-level compare-and-swap ensures only one caller wins. |
| 2 | `auth/routes.ts:49` | High | Concurrent signup race (both requests pass `findUserByEmail` before either INSERT commits): wrapped `createUser` in try/catch, maps UNIQUE constraint violation → 409. |
| 3 | `memory/migrate.ts` | High | `getCache()` opened a new LibSQL connection without running migrations — `aso_cache` table absent in Postgres mode. Added `runMigrations(db)` fire-and-forget call in `cost/cache.ts:getCache`. |
| 4 | `sources/function-competitors.ts` | High | `tenantId: string = 'default'` silent fallback replaced with required `tenantId: string` in both `fetchFunctionGroundedCompetitors` and `fetchEvidenceCompetitors`. `audit-workflow.ts` updated to pass real tenantId; call sites in `function-competitors.test.ts` updated with `'test-tenant'`. |
| 5 | `compose.yml` | Medium | Hardcoded `POSTGRES_PASSWORD: aso` replaced with `${PGPASSWORD:-aso}` (and same for `PGUSER`, `PGDATABASE`) — credentials overrideable via env without editing the file. |
| 6 | `auth/token.ts` | **Refuted** | The dummy bcrypt hash `$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345` is a valid `$2b$12$` string — `verifyPassword` runs a full bcrypt comparison and the login timing guard works correctly. No fix needed. |
| 7 | `memory/libsql-storage-client.ts` + `postgres-storage-client.ts` | Medium | `upsertRecommendation` ON CONFLICT DO UPDATE was missing `target_field`, `superseded_by`, `applied_at`, `proof_regime` columns — stale values persisted after an update. Added all four to both clients. |

## Code review — Phase 6a security pass 3 (2026-07-08)

8 findings reviewed (1 plausible, 2 refuted); 8 fixed:

| # | File | Severity | Fix |
|---|---|---|---|
| 1 | `auth/user-store.ts:87` | Critical | Reuse-detection SELECT fired on legitimately concurrent refresh (two tabs racing on the same token) → forced logout of all sessions. Fixed with 30-second grace window: `AND revoked_at < graceCutoff` distinguishes concurrent refresh (revoked_at just now) from genuine stale-token replay. |
| 2 | `memory/pg-migrate.ts:33` | High | `EXCEPTION WHEN others THEN NULL` swallowed ALL Postgres errors — constraint violations from pre-existing dirty data silently left the PK unrebuilt. Narrowed to `EXCEPTION WHEN duplicate_object OR duplicate_table OR lock_not_available THEN NULL` (concurrent-startup races only). Applied to both DO blocks. |
| 3 | `memory/migrate.ts:171` | High | `CREATE UNIQUE INDEX` halted migration runner on dirty-data DBs with pre-existing duplicate token_hash rows, skipping all subsequent steps. Added `DELETE … WHERE id NOT IN (SELECT id FROM (ROW_NUMBER() OVER PARTITION BY token_hash …) WHERE rn = 1)` immediately before the index — works on both SQLite and Postgres, no-op on clean DBs. |
| 4 | `cost/cache.ts:95` | High | `runMigrations(db)` fire-and-forget — first-request `cache.set()` calls raced the migration and silently failed. Threaded the migration promise into `LibSqlCache` constructor; `set()` now awaits `#ready` before writing. `get()` is unaffected (a miss on a missing table is equivalent to a miss). |
| 5 | `auth/routes.ts:62` | Medium | SQLite-only error string check (`UNIQUE constraint failed`) missed Postgres UNIQUE violations (error code `23505`) — concurrent signup race still returned 500 in Postgres mode. Added `code === '23505'` branch. |
| 6 | `libsql-storage-client.ts:141` + `postgres-storage-client.ts:77` | Medium | `upsertRecommendation` ON CONFLICT SET was missing `dimension` and `intent` — a recommendation re-raised after a taxonomy reclassification retained stale `dimension`/`intent`. Added both columns to both clients. |
| 7 | `cost/pacer.ts:67` | Medium (plausible) | Pacer Postgres pool `max:2` could leave a 3rd concurrent caller queueing without a FOR UPDATE lock. Increased to `max:10` (postgres.js default); the FOR UPDATE tx is fast (sleep is outside the transaction), so connections return quickly. |
| 8 | `memory/postgres-storage-client.ts:108` + `pg-migrate.ts` | Medium | `recordOccurrence` ON CONFLICT `(rec_id, snapshot_id)` missing `tenant_id` — two tenants with the same `(rec_id, snapshot_id)` (rec_id is a UUID from a per-tenant table, so astronomically unlikely but structurally wrong) would share one row. Added PK rebuild `DO` block in `pg-migrate.ts` and updated ON CONFLICT to `(tenant_id, rec_id, snapshot_id)`. |

## Websearch probe correctness fixes (2026-07-08)

3 issues found and fixed in `sources/websearch/websearch.ts` (both `TavilyWebSearch` and `ExaWebSearch`):

| # | Issue | Fix |
|---|---|---|
| 1 | Cache key hashed the uncapped query while the API call sent the capped query — two queries >400 chars sharing the same 400-char prefix produced different cache keys but made identical API calls, paying double. | `queryKey(cappedQuery)` instead of `queryKey(query)` in both providers. |
| 2 | Non-OK response body was never drained — repeated 429s/5xxs progressively exhausted the HTTP connection pool (undici marks the connection as "response body pending"). | Added `await res.body?.cancel()` before the errored return in both providers. |
| 3 | `state` was derived for the log but the return statements re-evaluated `genuine.length` independently — adding a third state would produce a log/return mismatch. | `state` is now used directly in both the log and the returns (`if (state === 'searched_and_empty') return ok({ state })`). |

## Known gaps / deviations (conscious, not bugs)

- **#3 — IAP names & permission/privacy-label signal families** are modelled but
  report `not observed` (not in the iTunes Lookup response). They're
  corroboration, not load-bearing for the §F gates. *Wire via the crawler later.*
- **#1 (resolved)** — identity is resolved in the `identify-app` *step* (from its
  existing iTunes fetch), not by modifying the `identify-app` *tool*. The §G "no
  re-fetch" intent holds; documented as accepted.
- **Resolved** — the pre-existing `mastra/routes.ts` Hono `Context` type-skew on
  `streamSSE` is fixed with a scoped `c as any`; **`tsc --noEmit` is now fully clean**
  and can gate CI. `npm test` green.
- **#8 — pre-prod migration caveat (`respond_to_reviews` key scheme).** Phase D
  graduated `respond_to_reviews` to multi-instance, so its `value_key` changed
  from `''` to the `reviewId`. Fine on the **fresh beta dev DB** (old-scheme rows
  are abandoned by design, per the plan's A3-fixup DoD). **But if ever promoted
  against a *populated* DB**, previously-`applied` `respond_to_reviews` rows
  (keyed `''`) won't match the new `recKey` → they'd be re-raised as `proposed`
  (re-nagging the operator). Needs a one-time `value_key` migration before any
  non-fresh promotion. (Same class applies to any future key-scheme change.)

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

- **P7-C shipped.** Deferred minor items: `awaiting_*`-state timeout (no expiry if creds never show up before step 2); `updateWindowState` + `insertChangeEvent` in step 5 are not in a single transaction (atomicity gap on transient DB error). Both are low-probability at beta scale.
- **P7-D (cost economics)** — spec at `docs/superpowers/specs/2026-07-10-p7d-cost-economics-design.md`. Not yet planned or started.
- **F-K4** (competitor visual benchmarking) still deferred — requires competitor icon/screenshot URLs from D3 + vision cost guard.
- **Phase D carry-over (non-blocking):** #3 — `resolveOtherThemeKey` re-embeds priors each call (store the vector + pin the embedding model id later).
- **D-UI-2** (per-section review synthesis — one entry per bucket with summary + exemplars) — scoped but not yet built.

## Key-arrival follow-ups (drop-in, one file each)

- **Web-search key** → replace `NoopWebSearch` (`sources/websearch/`) with Exa/Tavily.
- **ASA key** → replace `StubAsaClient` (`keywords/asa-client.ts`) with the real OAuth2 client (scope `searchadsorg`, JWT `client_secret`). **Genuine one-file drop-in** — the candidate-gen/gap-analysis consumption path (`generateCandidates` → `getVolume`) already exists, so volume/popularity lights up with no other changes.
