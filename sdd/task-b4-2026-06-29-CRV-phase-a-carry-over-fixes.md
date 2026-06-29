# Code Review: Task B4 — Phase-A Carry-Over Fixes

**Work Item**: task-b4
**Created**: 2026-06-29
**Type**: Code Review
**Related To**: task-b4-brief.md
**Reviewer**: Claude Sonnet 4.6
**Review Status**: Complete

---

## Purpose

Code review for Task B4: Phase-A carry-over fixes (applied-detection, escalate gate,
reachability guard, efficiency). Four targeted fixes flagged in the STATUS.md code review
that were unblocked by Phase B's new vision scoring.

---

## What Was Reviewed

**Scope**:
- **Source**: branch diff
- **Reference**: 422d457..52bd88c
- **Branch**: worktree-phase-b-vision-id-full
- **Base**: 422d457 (post-B3)
- **Files Changed**: 5
- **Lines Changed**: +114/-10

**Files**:
- `apps/server/src/mastra/tools/resolve-identity.ts`
- `apps/server/src/mastra/workflows/audit-workflow.ts`
- `apps/server/src/memory/audit-memory.test.ts`
- `apps/server/src/memory/audit-memory.ts`
- `apps/server/src/scoring/score.ts`

---

## Spec Compliance

### Fix 1 — applied-detection (`add_preview_video` → `applied`)

**Status**: PASS

The non-text block is inserted **before** the `!afterText` guard, exactly as specified.
`add_preview_video` + `hasPreviewVideo: true` → `flipped.push(…applied…)`. Two tests
cover the positive and negative cases; the implementer report notes 5 new tests total.

### Fix 2 — escalate gate in `buildPriorContext`

**Status**: PASS

Condition changed from `identity.divergence === 'cross_domain'` to
`identity.escalate && identity.source !== 'human_confirmed'`. All three required cases
are tested:
- (a) `escalate: true, source: 'resolved'` → note appears
- (b) `escalate: true, source: 'human_confirmed'` → note absent
- (c) `escalate: false, divergence: 'cross_domain'` → note absent (the old bug)

### Fix 3 — reachability guard in identify step

**Status**: PASS

`getLlmProvider().reachable()` is checked at the top of `geminiClassifier` before any
network call. Error message matches the spec template exactly. No new test required per
spec (noted in brief).

### Fix 4a — `produceAuditDraft` accepts `prebuiltPrompt`

**Status**: PASS

`prebuiltPrompt?: string` added as 5th parameter. `buildAuditPrompt` is called exactly
once at the workflow level (`builtPrompt`), hash is computed from it, and the same value
is passed into `produceAuditDraft`. The `??` fallback ensures backward compatibility when
called without the argument.

### Fix 4b — `persistAudit` uses pre-fetched snapshot/ledger

**Status**: PASS

`PersistInput` extended with `priorSnapshot?: ListingSnapshot | null` and
`priorLedger?: LedgerRecommendation[]`. `persistAudit` short-circuits via
`!== undefined` checks (correctly handles `null` for "first audit" case). Workflow
passes `priorSnap` and `priorLedgerR.ok ? priorLedgerR.value : []`.

### Test Count

**Status**: PASS

Report states 209 passed (204 prior + 5 new), 2 skipped. No regressions.

### Typecheck

**Status**: PASS — reported clean by implementer.

---

## Summary Assessment

| Category | Rating | Comment |
|----------|--------|---------|
| **Code Quality** | Excellent | Clean, minimal diffs; each fix is surgical and self-contained |
| **Security** | N/A | No auth or secret-handling changes |
| **Performance** | Good | Fix 4a/4b remove real duplicate I/O; no regressions introduced |
| **Testing** | Good | 5 new tests; coverage matches spec requirements exactly |
| **Documentation** | Good | Inline comments explain rationale clearly (B4 tags, guard explanations) |

---

## Code Quality Review

### Architecture & Design

**Strengths**:
- All four fixes are surgical — minimum lines changed per fix.
- `prebuiltPrompt ?? buildAuditPrompt(…)` is an idiomatic optional override that
  maintains full backward compatibility without changing the call signature meaning.
- The `priorSnapshot !== undefined` guard correctly differentiates between
  "caller didn't pass it" (`undefined`) and "first audit, no prior snapshot" (`null`),
  which is the right semantic distinction.
- Non-text applied detection is gated precisely on `add_preview_video`; the comment
  explicitly calls out why icon/screenshots are excluded, preventing future
  over-extension.
- Reachability guard in `geminiClassifier` is placed before any network call and
  produces a human-actionable error message.

**Concerns**:
- None.

---

## Security Review

**Implemented**:
- Reachability check prevents silent failure when the LLM endpoint is unreachable;
  the error surface is appropriate (no secrets in message, actionable guidance).

**Missing or Needs Review**:
- None identified.

---

## Performance Review

**Optimizations**:
- Fix 4a eliminates one `buildAuditPrompt` call per audit run (string construction
  + concatenation; low cost individually but consistent).
- Fix 4b eliminates two storage round-trips (`latestSnapshot` + `ledger`) per audit
  when the workflow has already fetched them — meaningful for any latency-sensitive
  path.

**Potential Issues**:
- None. The short-circuit logic is clean; the else branches preserve existing
  behavior for callers that don't pass pre-fetched values.

---

## Testing Review

**Coverage Assessment**:
- **Status**: Adequate — matches spec requirements exactly.

**Test Quality**:
- Fix 1 tests cover both positive (video present → applied) and negative (video absent
  → not flipped) cases. Good symmetry.
- Fix 2 tests cover all three branches of the new condition, explicitly calling out
  the old bug in the test description (`old bug`). This is good test hygiene.
- Fix 3 has no new test, which is explicitly permitted by the brief ("no new test
  required").
- Fix 4a/4b have no new tests, also explicitly permitted ("pure efficiency changes;
  existing tests verify observable behavior").
- `buildPriorContext` is now exported and directly unit-tested — this is a net
  improvement to the test surface vs. testing it only indirectly.

---

## Documentation Review

**Present**:
- Inline `// B4:` comments in each changed file explain the rationale concisely.
- Guard comment in `detectApplied` explains why icon/screenshots are excluded.
- `PersistInput` JSDoc comments for the two new optional fields are clear.

**Missing**:
- None.

---

## Requested Changes

### Must Fix (Blocking)

None.

### Should Fix (Recommended)

None.

### Nice to Have (Polish)

**Minor — `persistAudit` double-fetch on `null` path** (confidence: low, non-blocking):

The spec example for the `priorSnapshot !== undefined` pattern in the brief showed a
double-call: `await storage.latestSnapshot(…)` twice in the else branch. The
implemented code correctly avoids this by assigning to a local variable in the else
branch — no action needed. This note is for the record only.

---

## Approval Status

**Current Status**: **Approved**

All 7 acceptance criteria from the brief are satisfied:
1. `detectApplied` marks `add_preview_video` applied — test green.
2. `buildPriorContext` gates on `escalate && source !== 'human_confirmed'` — 3 tests.
3. `geminiClassifier` throws a clear error when unreachable.
4. `produceAuditDraft` accepts pre-built prompt — no double call.
5. `persistAudit` accepts pre-fetched snapshot/ledger — no duplicate reads.
6. All 209 tests pass (204 prior + 5 new), 0 regressions.
7. Typecheck passes.

---

## Related Documents

- TSK: task-b4-brief.md
- RPT: task-b4-report.md
- DIFF: review-422d457..52bd88c.diff
