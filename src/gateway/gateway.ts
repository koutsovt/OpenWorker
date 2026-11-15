// Model gateway: decides which provider and model a session may use, and
// accounts for what it used. Every decision is written to the audit ledger.
import type { AuditLedger } from '../audit/ledger.ts';
import type { ModelEntry, ModelPolicy, PlatformConfig } from '../config/load.ts';
import type { ModelRef, Usage } from '../harness/port.ts';

export class ModelPolicyError extends Error {}

export interface Selection {
  alias: string;
  ref: ModelRef;
}

export class ModelGateway {
  private readonly models: Map<string, ModelEntry>;
  private readonly policies: Map<string, ModelPolicy>;
  private readonly ledger: AuditLedger;
  private readonly env: Record<string, string | undefined>;

  constructor(config: PlatformConfig, ledger: AuditLedger, env: Record<string, string | undefined> = process.env) {
    this.models = new Map(config.models.map((m) => [m.alias, m]));
    this.policies = new Map(config.policies.map((p) => [p.id, p]));
    this.ledger = ledger;
    this.env = env;
  }

  /** The policy's default model, provided it has every required capability. */
  select(policyId: string, actor: string, requires: string[] = []): Selection {
    const policy = this.policy(policyId);
    const candidates = [policy.default, ...policy.allowed.filter((a) => a !== policy.default)];
    const alias = candidates.find((a) => requires.every((c) => this.models.get(a)!.capabilities.includes(c)));
    if (!alias) {
      this.ledger.append('model.refused', actor, { policy: policyId, reason: 'no_capable_model', requires });
      throw new ModelPolicyError(`Policy ${policyId} has no allowed model with: ${requires.join(', ')}`);
    }
    return this.record('model.selected', policyId, alias, actor, { requires });
  }

  /** An explicit switch. Refused, and logged, unless the policy allows the target. */
  switchTo(policyId: string, alias: string, actor: string): Selection {
    const policy = this.policy(policyId);
    if (!policy.allowed.includes(alias)) {
      this.ledger.append('model.refused', actor, { policy: policyId, requested: alias, reason: 'not_allowed' });
      throw new ModelPolicyError(`Policy ${policyId} does not allow model ${alias}`);
    }
    return this.record('model.switched', policyId, alias, actor, {});
  }

  /** Next approved fallback after `tried` failed, or undefined when none remain. */
  fallback(policyId: string, tried: string[], actor: string, reason: string): Selection | undefined {
    const alias = this.policy(policyId).fallbacks.find((a) => !tried.includes(a));
    if (!alias) {
      this.ledger.append('model.fallback_exhausted', actor, { policy: policyId, tried, reason });
      return undefined;
    }
    return this.record('model.fallback', policyId, alias, actor, { tried, reason });
  }

  /** Cost in USD, or null when usage is incomplete or the model has no price. */
  cost(alias: string, usage: Usage): number | null {
    const price = this.model(alias).price;
    if (!price || !usage.complete) return null;
    return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
  }

  recordUsage(alias: string, usage: Usage, actor: string, instance?: string): void {
    this.ledger.append('model.usage', actor, {
      instance: instance ?? null, model: alias, modelCalls: usage.modelCalls, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      usageComplete: usage.complete, costUsd: this.cost(alias, usage),
    });
  }

  /** The provider behind a model alias, or undefined for an unknown alias. */
  providerOf(alias: string): string | undefined {
    return this.models.get(alias)?.provider;
  }

  private record(type: string, policyId: string, alias: string, actor: string, extra: Record<string, string | string[]>): Selection {
    const ref = this.resolve(alias);
    this.ledger.append(type, actor, { policy: policyId, model: alias, provider: ref.provider, modelId: ref.model, ...extra });
    return { alias, ref };
  }

  private resolve(alias: string): ModelRef {
    const entry = this.model(alias);
    const id = this.env[entry.modelEnv];
    if (!id) throw new ModelPolicyError(`Set ${entry.modelEnv} to the exact model id for ${alias}`);
    return { provider: entry.provider, model: id };
  }

  private model(alias: string): ModelEntry {
    const entry = this.models.get(alias);
    if (!entry) throw new ModelPolicyError(`Unknown model alias ${alias}`);
    return entry;
  }

  private policy(id: string): ModelPolicy {
    const policy = this.policies.get(id);
    if (!policy) throw new ModelPolicyError(`Unknown model policy ${id}`);
    return policy;
  }
}
