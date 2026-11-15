// Governance end to end, on the fake harness. Most of these are negative tests:
// they pass only if an unauthorised action is blocked and the refusal is recorded.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AuditLedger } from '../src/audit/ledger.ts';
import { validateConfig } from '../src/config/load.ts';
import { ModelGateway } from '../src/gateway/gateway.ts';
import { Governance } from '../src/governance/policy.ts';
import { FakeHarness, type FakeStep } from '../src/harness/fake.ts';
import type { Json } from '../src/harness/port.ts';
import { Registry } from '../src/registry/registry.ts';
import { GovernanceError, Workforce, type AgentRunRequest, type Approver, type ToolImplementation } from '../src/runtime/workforce.ts';
import { skillTools } from '../src/tools/skills.ts';
import { agentFile, skillFile, toolFile, writeRegistry } from './support/fixture-registry.ts';

const allTools = ['kb.read', 'kb.secret', 'ops.write', 'ops.publish', 'skills.load', 'skills.propose'];
const fixture = () => ({
  tools: [
    toolFile('kb.read', { limits: { maxCallsPerSession: 2 } }),
    toolFile('kb.secret', { dataClassification: 'confidential' }),
    toolFile('ops.write', { action: 'write' }),
    toolFile('ops.publish', { action: 'write', risk: 'sensitive' }),
    toolFile('skills.load'),
    toolFile('skills.propose', { action: 'write' }),
  ],
  skills: [skillFile('method-a', '1.0.0'), skillFile('method-b', '1.0.0', { dependencies: ['method-a'] }), skillFile('method-x', '1.0.0')],
  agents: [
    agentFile('analyst', 1, { allowedTools: allTools, eligibleSkills: ['method-a', 'method-b'] }),
    agentFile('narrow', 1, { allowedTools: ['kb.read'] }),
    agentFile('drafty', 1, { status: 'draft' }),
  ],
});

const users = [
  { id: 'alice', roles: ['requester', 'approver'] },
  { id: 'bob', roles: ['requester'] },
  { id: 'carol', roles: ['approver'] },
  { id: 'dave', roles: ['requester', 'contributor'] },
];
const roles = { requester: { run: true, actions: ['read' as const] }, contributor: { actions: ['read' as const, 'write' as const] }, approver: { approve: true } };
const models = validateConfig({
  providers: [{ name: 'Mock', api: 'chat-completions' }],
  models: [{ alias: 'primary', provider: 'Mock', modelEnv: 'M1' }, { alias: 'backup', provider: 'Mock', modelEnv: 'M2' }],
  policies: [{ id: 'std', default: 'primary', allowed: ['primary'], fallbacks: ['backup'] }],
});

// The task text selects a script: one step per model call; `failOnPrimary` is a rate limit on the primary model only.
type Script = (FakeStep | 'failOnPrimary')[];
const call = (tool: string, args: Record<string, Json> = {}): FakeStep => ({ tool, args });
const scripts: Record<string, Script> = {
  read: [call('kb.read'), { text: 'read done' }],
  secret: [call('kb.secret'), { text: 'after secret' }],
  write: [call('ops.write'), { text: 'after write' }],
  publish: [call('ops.publish', { title: 'Q3' }), { text: 'after publish' }],
  unregistered: [call('shell.exec', { cmd: 'rm -rf /' }), { text: 'after shell' }],
  'read-many': [call('kb.read'), call('kb.read'), call('kb.read'), { text: 'after reads' }],
  'load-assigned': [call('skills.load', { id: 'method-a' }), { text: 'loaded' }],
  'load-unassigned': [call('skills.load', { id: 'method-x' }), { text: 'tried' }],
  propose: [call('skills.propose', { skill_id: 'method-a', title: 'Tighten step 2', rationale: 'Seen twice', proposed_text: 'New text' }), { text: 'proposed' }],
  'fail-first': ['failOnPrimary'],
  'write-then-fail': [call('ops.write'), 'failOnPrimary'],
  slow: [call('kb.read'), { text: 'slow done' }],
};

function setup(options: { registryDir?: string; readDelayMs?: number } = {}) {
  const registryDir = options.registryDir ?? writeRegistry(fixture());
  const stateDir = mkdtempSync(join(tmpdir(), 'workforce-'));
  const ledger = new AuditLedger(join(stateDir, 'audit.sqlite'));
  const ran: Record<string, number> = {};
  const results: Json[] = [];
  const addenda: (string | undefined)[] = [];
  const builtIn = skillTools(ledger, join(stateDir, 'proposals'));
  const implementations: Record<string, ToolImplementation> = Object.fromEntries(allTools.map((name) => [name, async (args, instance) => {
    ran[name] = (ran[name] ?? 0) + 1;
    if (name === 'kb.read' && options.readDelayMs) await new Promise((ok) => setTimeout(ok, options.readDelayMs));
    const result = builtIn[name] ? await builtIn[name](args, instance) : { ok: true };
    results.push(result);
    return result;
  }]));
  const harness = new FakeHarness((model, toolResults, input, turn) => {
    addenda.push(turn.addendum);
    const step = (scripts[input] ?? [])[toolResults] ?? { text: 'done' };
    if (step === 'failOnPrimary') return model === 'm-primary' ? { error: 'rate_limit' } : { text: 'recovered on backup' };
    return step;
  });
  const workforce = new Workforce({
    harness, ledger, implementations, registry: new Registry(registryDir),
    gateway: new ModelGateway(models, ledger, { M1: 'm-primary', M2: 'm-backup' }),
    governance: new Governance(users, { roles }),
  });
  const types = () => ledger.records().map((r) => r.type);
  const find = (type: string) => ledger.records().filter((r) => r.type === type);
  const run = async (request: Partial<AgentRunRequest> & { input: string }) => {
    await workforce.start(models.providers);
    return workforce.runAgent({ agentId: 'analyst', user: 'alice', ...request });
  };
  return { run, ran, results, addenda, ledger, types, find, stateDir, registryDir };
}
const refused = (code: string) => (e: GovernanceError) => e instanceof GovernanceError && e.code === code;
const approveAs = (approver: string, decision: 'approve' | 'deny' = 'approve'): Approver => async () => ({ approver, decision });

describe('agent instantiation', () => {
  it('runs an approved agent and records who, what and which definition', async () => {
    const t = setup();
    const outcome = await t.run({ input: 'read', skills: ['method-b'] });
    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.output, 'read done');
    assert.match(outcome.instance, /^analyst@1#[0-9a-f]{8}$/);
    const instantiated = t.find('agent.instantiated')[0]!;
    assert.equal(instantiated.actor, 'user:alice');
    const data = instantiated.data as { skills: { id: string }[]; definitionDigest: string };
    assert.deepEqual(data.skills.map((s) => s.id), ['method-a', 'method-b']);
    assert.match(data.definitionDigest, /^[0-9a-f]{64}$/);
    assert.equal(t.find('tool.called')[0]!.actor, `agent:${outcome.instance}`);
    assert.match(t.addenda[0] ?? '', /method-a \(v1\.0\.0\).*\n- method-b/s);
    assert.match(t.addenda[0] ?? '', /grant no tools or permissions/);
    assert.equal(t.ledger.verify().ok, true);
  });

  it('refuses a draft agent, an unknown agent and a tampered agent', async () => {
    const t = setup();
    await assert.rejects(t.run({ input: 'read', agentId: 'drafty' }), refused('REGISTRY_NOT_APPROVED'));
    await assert.rejects(t.run({ input: 'read', agentId: 'ghost' }), refused('REGISTRY_UNKNOWN'));
    assert.deepEqual(t.types(), ['run.refused', 'run.refused']);

    const dir = writeRegistry(fixture());
    const path = join(dir, 'agents', 'narrow', '1.yaml');
    writeFileSync(path, readFileSync(path, 'utf8').replace('- kb.read', '- kb.read\n  - ops.write'));
    await assert.rejects(setup({ registryDir: dir }).run({ input: 'write', agentId: 'narrow' }), refused('REGISTRY_TAMPERED'));
  });

  it('refuses users who may not run agents', async () => {
    const t = setup();
    await assert.rejects(t.run({ input: 'read', user: 'carol' }), refused('USER_MAY_NOT_RUN'));
    await assert.rejects(t.run({ input: 'read', user: 'mallory' }), refused('UNKNOWN_USER'));
    assert.equal(t.ran['kb.read'], undefined);
  });

  it('refuses a skill the agent is not eligible for', async () => {
    await assert.rejects(setup().run({ input: 'read', skills: ['method-x'] }), refused('REGISTRY_NOT_ELIGIBLE'));
  });

  it('will not start with a tool that is unregistered or has no implementation', () => {
    const base = { harness: new FakeHarness(() => ({ text: '' })), ledger: new AuditLedger(':memory:'), gateway: {} as ModelGateway, governance: new Governance([], { roles: {} }) };
    const registry = new Registry(writeRegistry({ tools: [toolFile('kb.read')] }));
    assert.throws(() => new Workforce({ ...base, registry, implementations: {} }), refused('TOOL_WITHOUT_IMPLEMENTATION'));
    assert.throws(() => new Workforce({ ...base, registry, implementations: { 'kb.read': async () => null, 'shell.exec': async () => null } }), refused('UNREGISTERED_TOOL'));
  });
});

describe('tool permissions', () => {
  it('blocks a write when the user holds only read permission, and records it once', async () => {
    const t = setup();
    const outcome = await t.run({ input: 'write' });
    assert.equal(outcome.status, 'completed');
    assert.equal(t.ran['ops.write'], undefined);
    const denials = t.find('tool.denied');
    assert.equal(denials.length, 1);
    assert.equal((denials[0]!.data as { code: string }).code, 'ACTION_NOT_PERMITTED');
  });

  it('allows the same write for a user whose role permits it', async () => {
    const t = setup();
    await t.run({ input: 'write', user: 'dave' });
    assert.equal(t.ran['ops.write'], 1);
  });

  it('blocks a tool whose data classification is above the agent ceiling', async () => {
    const t = setup();
    await t.run({ input: 'secret' });
    assert.equal(t.ran['kb.secret'], undefined);
    assert.equal((t.find('tool.denied')[0]!.data as { code: string }).code, 'DATA_CLASSIFICATION');
  });

  it('never runs a tool outside the agent definition or outside the registry', async () => {
    const t = setup();
    await t.run({ input: 'write', agentId: 'narrow', user: 'dave' });
    await t.run({ input: 'unregistered', user: 'dave' });
    assert.equal(t.ran['ops.write'], undefined);
    assert.deepEqual(Object.keys(t.ran), []);
  });

  it('enforces the per-session call limit', async () => {
    const t = setup();
    const outcome = await t.run({ input: 'read-many' });
    assert.equal(outcome.status, 'completed');
    assert.equal(t.ran['kb.read'], 2);
    assert.equal(t.find('tool.limit_reached').length, 1);
  });
});

describe('approval gates', () => {
  it('runs a sensitive tool only after an approver approves, and records the approver', async () => {
    const t = setup();
    await t.run({ input: 'publish', user: 'dave', approver: approveAs('carol') });
    assert.equal(t.ran['ops.publish'], 1);
    assert.equal(t.find('approval.granted')[0]!.actor, 'user:carol');
    assert.deepEqual(t.types().filter((x) => x.startsWith('approval.')), ['approval.requested', 'approval.granted']);
  });

  it('does not run it when the approver denies', async () => {
    const t = setup();
    const outcome = await t.run({ input: 'publish', user: 'dave', approver: approveAs('carol', 'deny') });
    assert.equal(outcome.status, 'completed');
    assert.equal(t.ran['ops.publish'], undefined);
  });

  it('rejects an approval from someone without the approver role', async () => {
    const t = setup();
    await t.run({ input: 'publish', user: 'dave', approver: approveAs('bob') });
    assert.equal(t.ran['ops.publish'], undefined);
    assert.equal((t.find('approval.rejected')[0]!.data as { code: string }).code, 'NOT_AN_APPROVER');
  });

  it('rejects an approval that names the agent itself as approver', async () => {
    const t = setup();
    await t.run({ input: 'publish', user: 'dave', approver: async (_request, instance) => ({ approver: instance.id, decision: 'approve' }) });
    assert.equal(t.ran['ops.publish'], undefined);
    assert.equal((t.find('approval.rejected')[0]!.data as { code: string }).code, 'UNKNOWN_USER');
  });

  it('denies when nobody is available to approve', async () => {
    const t = setup();
    await t.run({ input: 'publish', user: 'dave' });
    assert.equal(t.ran['ops.publish'], undefined);
    assert.equal((t.find('approval.denied')[0]!.data as { reason: string }).reason, 'no_approver_available');
  });

  it('still applies the permission check before asking anyone', async () => {
    const t = setup();
    await t.run({ input: 'publish', user: 'alice', approver: approveAs('alice') });
    assert.equal(t.ran['ops.publish'], undefined);
    assert.equal(t.find('approval.requested').length, 0);
    assert.equal(t.find('tool.denied').length, 1);
  });
});

describe('skills at runtime', () => {
  it('loads an assigned skill and refuses an unassigned one', async () => {
    const t = setup();
    await t.run({ input: 'load-assigned', skills: ['method-a'] });
    assert.match((t.results[0] as { method: string }).method, /Method text for method-a/);
    assert.equal(t.find('skill.loaded').length, 1);

    const other = setup();
    await other.run({ input: 'load-unassigned', skills: ['method-a'] });
    assert.match((other.results[0] as { error: string }).error, /not assigned/);
    assert.equal(other.find('skill.load_denied').length, 1);
  });

  it('records a skill proposal without touching the registry', async () => {
    const t = setup();
    const snapshot = () => JSON.stringify(readdirSync(t.registryDir, { recursive: true }).sort().map((f) => {
      const path = join(t.registryDir, String(f));
      return [f, statSync(path).isFile() ? readFileSync(path, 'utf8') : ''];
    }));
    const before = snapshot();
    await t.run({ input: 'propose', user: 'dave' });
    assert.equal(snapshot(), before);
    assert.equal(t.find('skill.proposed').length, 1);
    assert.equal(readdirSync(join(t.stateDir, 'proposals')).length, 1);
  });

  it('does not let a read-only user file a proposal', async () => {
    const t = setup();
    await t.run({ input: 'propose', user: 'alice' });
    assert.equal(t.find('skill.proposed').length, 0);
    assert.equal(existsSync(join(t.stateDir, 'proposals')), false);
  });
});

describe('budgets and fallback', () => {
  it('stops at the model-call limit and withholds the output', async () => {
    const t = setup();
    const outcome = await t.run({ input: 'read', budget: { maxModelCalls: 2 } });
    assert.equal(outcome.status, 'budget_exceeded');
    assert.equal(outcome.failure, 'model_calls');
    assert.equal(outcome.output, null);
    assert.equal(t.find('budget.exceeded').length, 1);
  });

  it('stops at the token limit', async () => {
    assert.equal((await setup().run({ input: 'read', budget: { maxTokens: 200 } })).failure, 'tokens');
  });

  it('treats a cost limit as breached when cost cannot be known', async () => {
    assert.equal((await setup().run({ input: 'read', budget: { maxCostUsd: 5 } })).failure, 'cost_unknown');
  });

  it('cancels the session when the time limit passes', async () => {
    const t = setup({ readDelayMs: 80 });
    const outcome = await t.run({ input: 'slow', budget: { maxSeconds: 0.02 } });
    assert.equal(outcome.status, 'budget_exceeded');
    assert.equal(outcome.failure, 'time');
  });

  it('leaves a run within budget alone', async () => {
    assert.equal((await setup().run({ input: 'read', budget: { maxModelCalls: 10, maxTokens: 10_000, maxSeconds: 30 } })).status, 'completed');
  });

  it('falls back to the approved model after a retryable failure', async () => {
    const t = setup();
    const outcome = await t.run({ input: 'fail-first' });
    assert.equal(outcome.output, 'recovered on backup');
    assert.deepEqual(outcome.tried, ['primary', 'backup']);
  });

  it('does not fall back once the task has written something', async () => {
    const t = setup();
    const outcome = await t.run({ input: 'write-then-fail', user: 'dave' });
    assert.equal(outcome.status, 'failed');
    assert.deepEqual(outcome.tried, ['primary']);
    assert.equal(t.ran['ops.write'], 1);
    assert.equal(t.find('model.fallback_blocked').length, 1);
  });
});
