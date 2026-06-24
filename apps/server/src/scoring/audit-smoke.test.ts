import { describe, it, expect } from 'vitest';
import { parseAppStoreUrl } from '../domain/app-url';
import { resolveListing } from '../sources';
import { toSummary } from '../domain/listing';
import { AuditReportSchema } from '../domain/audit';
import { asoAuditor } from '../mastra/agents/aso-auditor';
import { produceAuditDraft } from './score';
import { computeSignals } from './signals';
import { assembleReport } from './aggregate';
import { getLlmProvider } from '../llm';
import { openDb, runMigrations } from '../memory/migrate';
import { LibSqlStorageClient } from '../memory/libsql-storage-client';
import { resolveAppIdentity } from '../mastra/tools/resolve-identity';
import { persistAudit } from '../memory/audit-memory';

/**
 * Phase 0 DoD: "an audit of one real URL completes with Gemini only."
 *
 * This is a *live* end-to-end smoke test — real iTunes + crawler fetches and a
 * real Gemini generation — so it is gated on a key being present. `npm test`
 * runs without loading `.env`, so it skips by default and the suite stays
 * hermetic. To run it for real:
 *
 *   dotenv -e ../../.env -- npx vitest run src/scoring/audit-smoke.test.ts
 */
const HAS_KEY = Boolean(
  process.env.LLM_API_KEY?.trim() ||
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim(),
);

const suite = HAS_KEY ? describe : describe.skip;

suite('Phase 0 smoke: full audit on Gemini', () => {
  it('resolves the pinned Gemini model, then audits a real URL end-to-end', async () => {
    // 1. The pinned model must actually respond (Phase 0.2).
    const llm = getLlmProvider();
    expect(llm.id).toBe('google');
    const check = await llm.verifyModel();
    expect(check.ok, check.detail).toBe(true);

    // 2. Gather a real listing (iTunes + crawler) — Spotify, a stable app.
    const ref = parseAppStoreUrl('https://apps.apple.com/us/app/spotify/id324684580');
    expect(ref.ok).toBe(true);
    if (!ref.ok) return;
    const listing = await resolveListing(ref.value);
    expect(listing.ok, listing.ok ? '' : listing.error).toBe(true);
    if (!listing.ok) return;

    // 3. Score it with Gemini and assemble the report — the real pipeline.
    const draft = await produceAuditDraft(asoAuditor, listing.value);
    const report = assembleReport(toSummary(listing.value), draft);

    // 4. The report is well-formed and scored.
    const parsed = AuditReportSchema.safeParse(report);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(report.overallScore).toBeGreaterThanOrEqual(0);
    expect(report.overallScore).toBeLessThanOrEqual(100);
    expect(report.dimensions.length).toBeGreaterThan(0);

    // 5. The new ID-lite + P1 wiring, end-to-end on live Gemini: resolve the
    //    identity with the real classifier, then persist into a fresh DB.
    const resolved = await resolveAppIdentity(listing.value);
    expect(resolved.category.length).toBeGreaterThan(0);
    expect(['high', 'medium', 'low']).toContain(resolved.categoryBand);

    const db = openDb(':memory:');
    await runMigrations(db);
    const storage = new LibSqlStorageClient(db);
    const memo = await persistAudit(storage, {
      listing: listing.value,
      signals: computeSignals(listing.value),
      report,
      resolved,
      identityFactSheet: 'smoke',
      rubricVersion: 'smoke',
      promptHash: 'smoke',
      modelId: llm.modelId,
      now: '2026-06-24T00:00:00.000Z',
    });
    // The snapshot + identity row were written; ledger reads back.
    const idRow = await storage.latestIdentity(listing.value.appId, listing.value.country);
    expect(idRow.ok && idRow.value?.stage).toBe('lite');
    const led = await storage.ledger(listing.value.appId, listing.value.country);
    expect(led.ok).toBe(true);
    expect(memo.identityVersion).toBe(0);
    db.close();
  }, 120_000);
});
