# Phase 6B: Observability Baseline Design

## Context

Mastra already emits structured JSON logs (Pino) for every workflow step — start, end, error, timing. This spec does not replace that. It layers three additions on top: gateway-level provider metrics, step payload logging, and `tenantId` context injection so every log line for an audit is filterable by tenant and run.

---

## Section 1: Architecture

### Foundation: Mastra's existing logger

Mastra's Pino logger already handles:
- Step start / end / error per workflow run
- Step timing
- Workflow and run IDs on every line
- OTel hooks if a collector is wired up later

**We do not touch Mastra's step logging.**

### What we add

Three targeted additions, each at a specific chokepoint:

| Addition | Where | What it covers |
|----------|-------|----------------|
| Gateway metrics | `gateway.ts`, `postgres-pacer.ts`, `resolve-identity.ts` | Provider latency, error rate, LLM token cost |
| Step payload logs | Each workflow step | Data flowing through the audit (debug detail, info summary) |
| `tenantId` context | `executeJob` in worker | Threads `tenantId` + `runId` through all log lines for an audit |

### What this does NOT include

- No metrics server, Prometheus, or Grafana — structured log lines only
- No distributed tracing spans (OpenTelemetry) — `traceId`/`runId` are correlation IDs
- No alerting
- No new logging library

**Goal:** when an audit fails in production, diagnose it from logs alone without SSH-ing into the container.

---

## Section 2: Gateway instrumentation

### Chokepoints

Every external call already flows through two chokepoints:

- **`gateway.ts`** — all provider fetches (iTunes, reviews, Tavily, Exa) via `getGateway().fetch()`
- **`postgres-pacer.ts`** — rate-slot DB calls
- **`resolve-identity.ts`** — LLM calls via `agent.generate()`

After each call completes (success or failure), emit one structured log line using Mastra's logger.

### Provider call log line

```json
{
  "level": "info",
  "event": "provider_call",
  "provider": "itunes",
  "operation": "lookup",
  "durationMs": 342,
  "status": "ok",
  "httpStatus": 200,
  "runId": "run_abc123",
  "tenantId": "tenant_xyz"
}
```

`status` is one of: `ok` | `error` | `timeout`. On error, an `errorMessage` field is added.

### LLM call log line

```json
{
  "level": "info",
  "event": "provider_call",
  "provider": "gemini",
  "operation": "classify",
  "durationMs": 1820,
  "status": "ok",
  "inputTokens": 480,
  "outputTokens": 62,
  "estimatedCostUsd": 0.0004,
  "runId": "run_abc123",
  "tenantId": "tenant_xyz"
}
```

### What this enables

- `grep provider=gemini` → all LLM calls with durations and costs
- `grep runId=xxx` → full timeline for one audit including every external call
- Total cost per audit = sum of `estimatedCostUsd` where `runId=xxx`
- `grep status=error provider=itunes` → all iTunes failures across all audits

---

## Section 3: Step payload logging

### Log levels

**`info` level — short summary per step.** Emitted in all environments. Enough to understand the audit's outcome without the bulk.

**`debug` level — full payload per step.** Silent in production (`LOG_LEVEL=info`). Set `LOG_LEVEL=debug` in dev to see the complete data flow.

### Step coverage

| Step | `info` summary fields | `debug` detail |
|------|-----------------------|----------------|
| `identify-app` | `escalate`, `divergence`, `footprintProbe.state`, `categoryBand` | Full fact sheet, classification JSON, web evidence block |
| `fetch-reviews` | `reviewCount`, `country` | Review text excerpt (first 500 chars) |
| `score-app` | `overallScore`, `band` | Full scoring breakdown per dimension |
| `confirm-app` | `accepted` (bool), `overridden` (bool) | Full identity payload before/after |

### Example info line

```json
{
  "level": "info",
  "event": "step_summary",
  "step": "identify-app",
  "escalate": true,
  "divergence": "cross_domain",
  "footprintState": "corroborated",
  "categoryBand": "high",
  "runId": "run_abc123",
  "tenantId": "tenant_xyz"
}
```

### Example debug line

```json
{
  "level": "debug",
  "event": "step_payload",
  "step": "identify-app",
  "factSheet": "Developer: Rivian\nBundle id org segment: rivian\n...",
  "classification": { "functionCategory": "Electric vehicle companion", "functionNiche": "EV companion", "functionTerms": ["truck", "vehicle", "charge"] },
  "runId": "run_abc123",
  "tenantId": "tenant_xyz"
}
```

---

## Section 4: `tenantId` context injection

### The problem

Mastra's step logs include `runId` and step names but not `tenantId` — our concept. Without it, you cannot filter logs to one tenant's audits.

### Injection point

In the worker's `executeJob`, before calling `run.start()`, create a child logger with the audit's context:

```typescript
const auditLogger = logger.with({ tenantId: job.tenantId, runId: job.runId });
```

Pino's child logger includes these fields on every line it emits. Pass `auditLogger` into gateway calls and step payload log sites.

### `GatewayCall` type

Add `tenantId?: string` to the `GatewayCall` type in `gateway.ts` so the gateway instrumentation can include it on every `provider_call` line without requiring a separate logger argument.

### Result

Every log line for an audit — Mastra step logs, gateway metrics, step payload summaries — carries the same `runId` and `tenantId`. Filter by either to reconstruct the full audit story.
