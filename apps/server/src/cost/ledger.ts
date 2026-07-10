export type TaskName =
  | 'identity'
  | 'vision'
  | 'themes'
  | 'competitor_mining'
  | 'scoring';

type LedgerEntry = {
  task: TaskName;
  promptTokens: number;
  completionTokens: number;
  estimatedCents: number;
};

export const CENTS_PER_1K: Record<'fast' | 'capable', { prompt: number; completion: number }> = {
  fast:    { prompt: 0.0075, completion: 0.030 },
  capable: { prompt: 0.125,  completion: 0.375 },
};

export class BudgetExceededError extends Error {
  constructor(public spentCents: number, public limitCents: number) {
    super(`Budget exceeded: $${(spentCents / 100).toFixed(2)} spent of $${(limitCents / 100).toFixed(2)} limit`);
    this.name = 'BudgetExceededError';
  }
}

export class CostLedger {
  private entries: LedgerEntry[] = [];

  constructor(private readonly limitCents: number) {}

  record(
    task: TaskName,
    tier: 'fast' | 'capable',
    usage: { promptTokens: number; completionTokens: number },
  ): void {
    const rates = CENTS_PER_1K[tier];
    const estimatedCents =
      (usage.promptTokens     / 1000) * rates.prompt +
      (usage.completionTokens / 1000) * rates.completion;
    this.entries.push({
      task,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      estimatedCents,
    });
  }

  checkBudget(): void {
    const total = this.totalCents();
    if (total > this.limitCents) throw new BudgetExceededError(total, this.limitCents);
  }

  totalCents(): number {
    return this.entries.reduce((sum, e) => sum + e.estimatedCents, 0);
  }

  toJSON(): { totalCents: number; breakdown: LedgerEntry[] } {
    return { totalCents: this.totalCents(), breakdown: this.entries };
  }
}
