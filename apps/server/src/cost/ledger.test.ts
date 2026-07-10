import { describe, it, expect } from 'vitest';
import { CostLedger, BudgetExceededError, CENTS_PER_1K } from './ledger';

describe('CostLedger', () => {
  it('record() accumulates entries and totalCents', () => {
    const ledger = new CostLedger(10_000);
    ledger.record('themes', 'fast', { promptTokens: 1000, completionTokens: 200 });
    const json = ledger.toJSON();
    expect(json.breakdown).toHaveLength(1);
    expect(json.breakdown[0]!.task).toBe('themes');
    expect(json.breakdown[0]!.promptTokens).toBe(1000);
    expect(json.breakdown[0]!.completionTokens).toBe(200);
    expect(json.totalCents).toBeCloseTo(
      (1000 / 1000) * CENTS_PER_1K.fast.prompt +
      (200  / 1000) * CENTS_PER_1K.fast.completion,
      5,
    );
  });

  it('checkBudget() throws BudgetExceededError when over limit', () => {
    const ledger = new CostLedger(1); // 1 cent limit
    ledger.record('scoring', 'capable', { promptTokens: 100_000, completionTokens: 10_000 });
    expect(() => ledger.checkBudget()).toThrow(BudgetExceededError);
  });

  it('checkBudget() does not throw when under limit', () => {
    const ledger = new CostLedger(10_000);
    ledger.record('themes', 'fast', { promptTokens: 100, completionTokens: 50 });
    expect(() => ledger.checkBudget()).not.toThrow();
  });

  it('toJSON() serialises all breakdown entries', () => {
    const ledger = new CostLedger(10_000);
    ledger.record('themes', 'fast', { promptTokens: 500, completionTokens: 100 });
    ledger.record('scoring', 'capable', { promptTokens: 1000, completionTokens: 300 });
    const json = ledger.toJSON();
    expect(json.breakdown).toHaveLength(2);
    expect(json.breakdown[1]!.task).toBe('scoring');
  });

  it('pricing constants smoke-test: fast tier values match documented rates', () => {
    // Canary — fails if someone accidentally changes the pricing constants.
    // Update this test when rates actually change.
    expect(CENTS_PER_1K.fast.prompt).toBe(0.0075);
    expect(CENTS_PER_1K.fast.completion).toBe(0.030);
    expect(CENTS_PER_1K.capable.prompt).toBe(0.125);
    expect(CENTS_PER_1K.capable.completion).toBe(0.375);
  });
});
