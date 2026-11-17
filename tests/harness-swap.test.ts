// Harness swap: the whole proof-of-concept scenario, unchanged, on each engine behind the port.
// The scripted model is the same; only the engine differs. If the outcomes match the fake
// harness, nothing above the port depends on which engine is underneath.
//  - claude-code: the Claude Code adapter driving a scripted stand-in for the Agent SDK
//  - openworker: the real OpenWorker runtime calling a local mock provider over HTTP
//  - routed: both at once, split by provider, as the command line wires them
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ClaudeCodeHarness } from '../src/harness/claude-code.ts';
import { OpenWorkerHarness } from '../src/harness/openworker.ts';
import type { AgentHarness, ProviderSpec } from '../src/harness/port.ts';
import { RoutingHarness } from '../src/harness/routing.ts';
import { fakeClaudeEngine } from './support/fake-claude-engine.ts';
import { startMockProvider, type MockProvider } from './support/mock-provider.ts';
import { platform, script } from './support/scenario-platform.ts';

type Platform = Awaited<ReturnType<typeof platform>>;

/** Everything about a finished run that should not depend on the engine. */
async function outcome(t: Platform) {
  const runId = await t.start();
  const summary = await t.orchestrator.execute(runId);
  const count = (type: string) => t.find(type).length;
  return {
    status: summary.status,
    tasks: summary.tasks.map(({ id, agent, status, attempts, model, tried, result }) => ({ id, agent, status, attempts, model, tried, result })),
    evidence: t.evidence.list(runId).map((e) => [e.id, e.document, e.anchor, e.contentHash]),
    verdicts: t.find('assurance.verdict').map((r) => { const { run: _run, ...rest } = r.data as Record<string, unknown>; return rest; }),
    ledger: Object.fromEntries(['tool.called', 'tool.denied', 'evidence.recorded', 'skill.loaded', 'run.task_completed', 'assurance.rework_requested',
      'model.fallback', 'plan.accepted', 'report.written'].map((type) => [type, count(type)])),
    reportWritten: existsSync(t.orchestrator.reportPath(runId)!),
    ledgerIntact: t.ledger.verify().ok,
  };
}

describe('harness swap', () => {
  let mock: MockProvider;
  let baseline: Awaited<ReturnType<typeof outcome>>;
  const started: AgentHarness[] = [];
  const viaMock = (p: ProviderSpec): ProviderSpec => ({ name: p.name, api: 'chat-completions', baseUrl: mock.url, apiKeyEnv: 'MOCK_KEY' });
  const viaClaudeCode = (p: ProviderSpec): ProviderSpec => ({ name: p.name, api: 'claude-code' });
  const openworker = () => new OpenWorkerHarness({ stateDir: mkdtempSync(join(tmpdir(), 'ow-swap-')) });
  const run = async (harness: AgentHarness, provider: (p: ProviderSpec) => ProviderSpec) => {
    started.push(harness);
    return outcome(await platform({ harness, provider }));
  };

  before(async () => {
    process.env.MOCK_KEY = 'sk-dummy';
    mock = await startMockProvider(script);
    baseline = await outcome(await platform());
  });
  after(async () => {
    for (const harness of started) await harness.shutdown();
    mock.close();
  });

  it('completes on the fake harness, as the baseline', () => {
    assert.equal(baseline.status, 'completed');
    assert.equal(baseline.tasks.length, 10);
    assert.equal(baseline.reportWritten, true);
  });

  it('gives the same outcome on the Claude Code adapter', async () => {
    assert.deepEqual(await run(new ClaudeCodeHarness({ engine: fakeClaudeEngine(script) }), viaClaudeCode), baseline);
  });

  it('gives the same outcome on the real OpenWorker runtime', async () => {
    assert.deepEqual(await run(openworker(), viaMock), baseline);
    assert.ok(mock.requests.length > 20, 'the runtime made real HTTP model calls');
  });

  it('gives the same outcome with both engines routed by provider', async () => {
    const routed = new RoutingHarness([
      { harness: new ClaudeCodeHarness({ engine: fakeClaudeEngine(script) }), serves: (p) => p.api === 'claude-code' },
      { harness: openworker(), serves: (p) => p.api !== 'claude-code' },
    ]);
    // Authors on the Claude Code adapter, the reviewer and the fallback on OpenWorker.
    assert.deepEqual(await run(routed, (p) => (p.api === 'claude-code' ? p : viaMock(p))), baseline);
  });
});
