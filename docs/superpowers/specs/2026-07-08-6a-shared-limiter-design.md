# Phase 6a — Shared Rate Limiter Design

## Goal

Replace the in-process `SerialPacer` with a Postgres-backed `PostgresSharedPacer` so that multiple server instances coordinate Apple API calls through a single shared slot table, keeping the aggregate call rate across all instances within Apple's ~20 calls/min ceiling.

## Context

The existing `SerialPacer` is a process-local singleton: it enforces a 3.5-second minimum gap between Apple API calls within one process, but knows nothing about other instances. Two instances running concurrently each enforce their own 17 calls/min limit, combining to 34 calls/min — above Apple's ceiling and a ban risk. The fix is to share state through the same Postgres database added in the Postgres swap sub-spec.

The `Pacer` interface (`cost/pacer.ts`) is already an abstraction. The swap is wiring-only from the gateway's perspective — `getPacer().wait()` in `gateway.ts` is unchanged.

---

## Section 1: Data Model

### New migration (in `PG_ONLY_MIGRATIONS` in `pg-migrate.ts`, NOT the shared `MIGRATIONS` array)

```sql
CREATE TABLE IF NOT EXISTS aso_rate_slots (
  key             TEXT PRIMARY KEY,
  next_allowed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO aso_rate_slots (key, next_allowed_at)
  VALUES ('itunes', NOW())
  ON CONFLICT (key) DO NOTHING;
```

`TIMESTAMPTZ` is Postgres-specific and must not be added to the shared `MIGRATIONS` array (which LibSQL also reads). It lives in `PG_ONLY_MIGRATIONS` exported from `pg-migrate.ts` and applied only by `runPgMigrations`.

One row per rate-limited upstream. Only `'itunes'` is seeded — Apple's iTunes and Review RSS endpoints share the same slot (both are `upstream === 'itunes' || upstream === 'reviews'` in the gateway, matching the existing pacer condition).

`next_allowed_at` means: "the earliest moment the next Apple API call may go out."

---

## Section 2: Slot-Claim Algorithm

### Invariant

Only one instance may update `next_allowed_at` at a time. PostgreSQL row-level locking (`SELECT ... FOR UPDATE`) serialises concurrent callers — the second caller blocks until the first transaction commits, then reads the updated timestamp.

### Transaction (per call)

```
BEGIN
  prev ← SELECT next_allowed_at FROM aso_rate_slots WHERE key = 'itunes' FOR UPDATE
  wait_ms ← max(prev - now(), 0)
  new_next ← max(prev, now()) + 3500ms
  UPDATE aso_rate_slots SET next_allowed_at = new_next WHERE key = 'itunes'
COMMIT
sleep(wait_ms)
```

**Why this is correct:**

- If `prev <= now()` (slot is free): `wait_ms = 0`, caller proceeds immediately. `new_next = now() + 3500ms` reserves the next slot.
- If `prev > now()` (slot is taken): `wait_ms = prev - now()`, caller sleeps until the slot opens. `new_next = prev + 3500ms` queues the next slot after this one.
- The `FOR UPDATE` lock means two concurrent callers serialize: the second sees the updated `prev` written by the first.

### Retry-After support

When `retryAfterMs > 0` (Apple returned a `429`), the interval used is `max(retryAfterMs, MIN_INTERVAL_MS)` instead of `3500ms` — same behaviour as `SerialPacer`.

---

## Section 3: PostgresSharedPacer

### File

`apps/server/src/cost/postgres-pacer.ts`

### Implementation

```typescript
import postgres from 'postgres';

const MIN_INTERVAL_MS = 3500;

export class PostgresSharedPacer implements Pacer {
  constructor(private sql: postgres.Sql) {}

  async wait(retryAfterMs = 0): Promise<void> {
    const intervalMs = Math.max(retryAfterMs, MIN_INTERVAL_MS);
    const rows = await this.sql.begin(async (tx) => {
      const [{ next_allowed_at }] = await tx`
        SELECT next_allowed_at FROM aso_rate_slots
        WHERE key = 'itunes' FOR UPDATE
      `;
      const now = new Date();
      const waitMs = Math.max(next_allowed_at.getTime() - now.getTime(), 0);
      const newNext = new Date(Math.max(next_allowed_at.getTime(), now.getTime()) + intervalMs);
      await tx`
        UPDATE aso_rate_slots SET next_allowed_at = ${newNext} WHERE key = 'itunes'
      `;
      return [{ waitMs }];
    });
    if (rows[0].waitMs > 0) await sleep(rows[0].waitMs);
  }

  reset(): void { /* no-op for distributed pacer */ }
}
```

### Factory wiring

`apps/server/src/cost/pacer.ts` — `getPacer()` updated:

```typescript
export function getPacer(): Pacer {
  if (!_pacer) {
    const dbUrl = process.env.DATABASE_URL;
    _pacer = dbUrl
      ? new PostgresSharedPacer(postgres(dbUrl))  // own connection; postgres.js pools lazily
      : new SerialPacer();                         // single-instance fallback
  }
  return _pacer;
}
```

`getPgClient()` returns the same `postgres.Sql` singleton used by `PostgresStorageClient` — one connection pool for both.

---

## Section 4: Testing

### Unit test

`apps/server/src/cost/postgres-pacer.test.ts`

Two tests against a real Postgres instance (`DATABASE_TEST_URL`):

1. **Sequential calls respect the interval**: call `wait()` twice in quick succession; assert total elapsed time ≥ `MIN_INTERVAL_MS`.
2. **Concurrent callers serialize**: call `wait()` concurrently from two `PostgresSharedPacer` instances pointing at the same DB; assert calls are spaced ≥ `MIN_INTERVAL_MS` apart (not overlapping).

The second test is the 6a Definition of Done gate for the limiter: it directly exercises the "two instances share one limiter" requirement.

### SerialPacer unchanged

Existing `pacer.test.ts` continues to pass — `SerialPacer` is not modified.

---

## Definition of Done (6a shared limiter)

From `specification.md §F`:
> two instances share one limiter (aggregate iTunes rate ≤ ceiling)

Specific test: two `PostgresSharedPacer` instances pointing at the same `DATABASE_TEST_URL`, firing `wait()` concurrently, produce calls spaced ≥ 3500ms apart in aggregate.

---

## Dependencies

No new packages. Uses the same `postgres` client added for the Postgres swap.
