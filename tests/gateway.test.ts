import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { AuditLedger } from '../src/audit/ledger.ts';
import { ConfigError, loadConfig, validateConfig } from '../src/config/load.ts';
import { ModelGateway, ModelPolicyError } from '../src/gateway/gateway.ts';
import { runTask } from '../src/gateway/run.ts';
import { FakeHarness } from '../src/harness/fake.ts';
import { scenario } from './support/scenarios.ts';

const config = validateConfig({
  providers: [{ name: 'Mock', api: 'chat-completions' }],
  models: [
    { alias: 'primary', provider: 'Mock', modelEnv: 'M_PRIMARY', capabilities: ['tools'], price: { input: 2, output: 10 } },
    { alias: 'vision', provider: 'Mock', modelEnv: 'M_VISION', capabilities: ['tools', 'vision'] },
    { alias: 'backup', provider: 'Mock', modelEnv: 'M_BACKUP', capabilities: ['tools'] },
    { alias: 'unapproved', provider: 'Mock', modelEnv: 'M_OTHER', capabilities: ['tools'] },
  ],
  policies: [{ id: 'assurance', default: 'primary', allowed: ['primary', 'vision'], fallbacks: ['backup'] }],
});
const env = { M_PRIMARY: 'mock-plain', M_VISION: 'mock-vision', M_BACKUP: 'mock-backup', M_OTHER: 'mock-x' };
const setup = (overrides: Record<string, string> = {}) => {
  const ledger = new AuditLedger(join(mkdtempSync(join(tmpdir(), 'gw-')), 'audit.sqlite'));
  return { ledger, gateway: new ModelGateway(config, ledger, { ...env, ...overrides }) };
};
const types = (ledger: AuditLedger) => ledger.records().map((r) => r.type);

describe('model gateway', () => {
  it('selects the policy default and records it', () => {
    const { gateway, ledger } = setup();
    assert.deepEqual(gateway.select('assurance', 'user:alice'), { alias: 'primary', ref: { provider: 'Mock', model: 'mock-plain' } });
    const record = ledger.records()[0]!;
    assert.equal(record.type, 'model.selected');
    assert.equal(record.actor, 'user:alice');
  });

  it('picks an allowed model that has the required capability', () => {
    assert.equal(setup().gateway.select('assurance', 'system', ['vision']).alias, 'vision');
  });

  it('refuses when no allowed model has the capability, and logs the refusal', () => {
    const { gateway, ledger } = setup();
    assert.throws(() => gateway.select('assurance', 'system', ['audio']), ModelPolicyError);
    assert.deepEqual(types(ledger), ['model.refused']);
  });

  it('refuses a switch to a model outside the policy, and logs the refusal', () => {
    const { gateway, ledger } = setup();
    assert.equal(gateway.switchTo('assurance', 'vision', 'system').alias, 'vision');
    assert.throws(() => gateway.switchTo('assurance', 'unapproved', 'agent:x#1'), ModelPolicyError);
    assert.throws(() => gateway.switchTo('assurance', 'backup', 'agent:x#1'), ModelPolicyError);
    assert.deepEqual(types(ledger), ['model.switched', 'model.refused', 'model.refused']);
  });

  it('walks approved fallbacks in order, then reports exhaustion', () => {
    const { gateway, ledger } = setup();
    assert.equal(gateway.fallback('assurance', ['primary'], 'system', 'rate_limit')?.alias, 'backup');
    assert.equal(gateway.fallback('assurance', ['primary', 'backup'], 'system', 'rate_limit'), undefined);
    assert.deepEqual(types(ledger), ['model.fallback', 'model.fallback_exhausted']);
  });

  it('reports cost only when price and complete usage are known', () => {
    const { gateway } = setup();
    const usage = { modelCalls: 1, inputTokens: 1_000_000, outputTokens: 500_000, complete: true };
    assert.equal(gateway.cost('primary', usage), 7);
    assert.equal(gateway.cost('backup', usage), null);
    assert.equal(gateway.cost('primary', { ...usage, complete: false }), null);
  });

  it('requires the model id to be configured in the environment', () => {
    assert.throws(() => setup({ M_PRIMARY: '' }).gateway.select('assurance', 'system'), /Set M_PRIMARY/);
  });
});

describe('task run with fallback', () => {
  const agent = { name: 'assure-v1', instructions: 'Review.', tools: [] };
  const run = async (overrides: Record<string, string>) => {
    const { gateway, ledger } = setup(overrides);
    const harness = new FakeHarness(scenario);
    await harness.start({ providers: [{ name: 'Mock', api: 'chat-completions' }], tools: [] });
    return { outcome: await runTask(harness, gateway, ledger, { agent, policy: 'assurance', input: 'check', actor: 'user:alice' }), ledger };
  };

  it('uses the default model when it works', async () => {
    const { outcome, ledger } = await run({});
    assert.equal(outcome.result.output, 'Hello from mock-plain.');
    assert.deepEqual(outcome.tried, ['primary']);
    assert.deepEqual(types(ledger), ['model.selected', 'task.started', 'model.usage', 'task.finished']);
    assert.equal(ledger.verify().ok, true);
  });

  it('falls back to the approved model after a retryable failure', async () => {
    const { outcome, ledger } = await run({ M_PRIMARY: 'mock-429' });
    assert.equal(outcome.result.status, 'completed');
    assert.equal(outcome.model, 'backup');
    assert.deepEqual(outcome.tried, ['primary', 'backup']);
    assert.ok(types(ledger).includes('model.fallback'));
  });

  it('stops with a failure when every approved model fails', async () => {
    const { outcome, ledger } = await run({ M_PRIMARY: 'mock-429', M_BACKUP: 'mock-429' });
    assert.equal(outcome.result.status, 'failed');
    assert.deepEqual(outcome.tried, ['primary', 'backup']);
    assert.equal(types(ledger).at(-1), 'model.fallback_exhausted');
  });
});

describe('configuration', () => {
  it('loads the committed config', () => {
    const loaded = loadConfig(resolve('config'));
    assert.deepEqual(loaded.policies.find((p) => p.id === 'assurance'), { id: 'assurance', default: 'openai-assurance', allowed: ['openai-assurance'], fallbacks: ['deepseek-fallback'] });
    assert.deepEqual(loaded.policies.find((p) => p.id === 'author'), { id: 'author', default: 'claude-author', allowed: ['claude-author'], fallbacks: ['deepseek-fallback'] });
  });
  it('rejects a key written into config', () => {
    assert.throws(() => validateConfig({ providers: [{ name: 'X', api: 'responses', apiKey: 'sk-live' }], models: [], policies: [] }), ConfigError);
  });
  it('rejects a policy that names an unknown model or a default outside allowed', () => {
    const providers = [{ name: 'X', api: 'responses' }];
    const models = [{ alias: 'a', provider: 'X', modelEnv: 'A' }, { alias: 'b', provider: 'X', modelEnv: 'B' }];
    assert.throws(() => validateConfig({ providers, models, policies: [{ id: 'p', default: 'zzz', allowed: ['zzz'] }] }), ConfigError);
    assert.throws(() => validateConfig({ providers, models, policies: [{ id: 'p', default: 'a', allowed: ['b'] }] }), ConfigError);
  });
});

describe('engine boundary', () => {
  it('each engine SDK is imported only by its own adapter', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (path.endsWith('.ts')) {
          const source = readFileSync(path, 'utf8');
          if (source.includes('@openworkerai/') && !path.endsWith(join('harness', 'openworker.ts'))) offenders.push(path);
          if (source.includes('@anthropic-ai/') && !path.endsWith(join('harness', 'claude-code.ts'))) offenders.push(path);
        }
      }
    };
    walk(resolve('src'));
    assert.deepEqual(offenders, []);
  });
});
