// Run budget. Limits are checked before work starts and after every turn;
// wall-clock time is enforced by cancelling the session.
import type { Usage } from '../harness/port.ts';

export interface Budget {
  maxModelCalls?: number;
  maxTokens?: number;
  maxCostUsd?: number;
  maxSeconds?: number;
}

export class BudgetTracker {
  readonly budget: Budget;
  modelCalls = 0;
  tokens = 0;
  costUsd = 0;
  /** True once any charged usage or cost was unknown; cost limits then cannot be relied on. */
  costUnknown = false;
  private readonly startedAt = Date.now();

  constructor(budget: Budget) {
    this.budget = budget;
  }

  charge(usage: Usage, costUsd: number | null): void {
    this.modelCalls += usage.modelCalls;
    this.tokens += usage.inputTokens + usage.outputTokens;
    if (costUsd === null) this.costUnknown = true;
    else this.costUsd += costUsd;
  }

  secondsLeft(): number | undefined {
    return this.budget.maxSeconds === undefined ? undefined : this.budget.maxSeconds - (Date.now() - this.startedAt) / 1000;
  }

  /** The first limit that has been reached, or undefined while within budget. */
  exceeded(): string | undefined {
    const b = this.budget;
    if (b.maxModelCalls !== undefined && this.modelCalls >= b.maxModelCalls) return 'model_calls';
    if (b.maxTokens !== undefined && this.tokens >= b.maxTokens) return 'tokens';
    if (b.maxCostUsd !== undefined && this.costUsd >= b.maxCostUsd) return 'cost';
    // A cost limit with unknown prices would silently never trigger; treat that as a breach.
    if (b.maxCostUsd !== undefined && this.costUnknown) return 'cost_unknown';
    const left = this.secondsLeft();
    if (left !== undefined && left <= 0) return 'time';
    return undefined;
  }
}
