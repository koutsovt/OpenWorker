// One contract, every adapter. Passing for both the fake and the OpenWorker
// adapter is the evidence that the engine is replaceable behind the port.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { FakeHarness } from '../src/harness/fake.ts';
import { OpenWorkerHarness } from '../src/harness/openworker.ts';
import { HarnessError, type AgentHarness, type AgentSpec, type Json, type ToolSpec } from '../src/harness/port.ts';
import { startMockProvider, type MockProvider } from './support/mock-provider.ts';
import { scenario } from './support/scenarios.ts';

const object = (properties: Record<string, Json>, required: string[]): Json =>
  ({ type: 'object', properties, required, additionalProperties: false });

function contract(name: string, make: () => Promise<{ harness: AgentHarness; baseUrl?: string; cleanup(): void }>) {
  describe(`harness contract: ${name}`, () => {
    let harness: AgentHarness;
    let cleanup: () => void;
    const ran = { lookup: 0, forbidden: 0, sensitive: 0, submitted: [] as Json[] };
    const tool = (toolName: string, schema: Json, run: (args: Record<string, Json>) => Json): ToolSpec =>
      ({ name: toolName, description: `Test tool ${toolName}.`, inputSchema: schema, execute: async (args) => run(args) });
    const tools = [
      tool('app.lookup', object({ q: { type: 'string' } }, ['q']), () => { ran.lookup++; return { hits: ['doc-1#p3'] }; }),
      tool('app.forbidden', object({ target: { type: 'string' } }, ['target']), () => { ran.forbidden++; return { done: true }; }),
      tool('app.sensitive', object({ action: { type: 'string' } }, ['action']), () => { ran.sensitive++; return { done: true }; }),
      tool('app.submit_result', object({ verdict: { type: 'string' }, findings: { type: 'array', items: { type: 'string' } } }, ['verdict', 'findings']),
        (args) => { ran.submitted.push(args); return { accepted: true }; }),
    ];
    const agent = (agentName: string, model: string, extra: Partial<AgentSpec> = {}): AgentSpec =>
      ({ name: agentName, instructions: 'Test agent.', model: { provider: 'Mock', model }, tools: [], ...extra });

    before(async () => {
      process.env.MOCK_KEY = 'sk-dummy';
      const made = await make();
      harness = made.harness;
      cleanup = made.cleanup;
      await harness.start({
        providers: [{ name: 'Mock', api: 'chat-completions', apiKeyEnv: 'MOCK_KEY', ...(made.baseUrl ? { baseUrl: made.baseUrl } : {}) }],
        tools,
        policy: ({ tool: t }) => (t === 'app.forbidden' ? { allow: false, code: 'POLICY_DENY', feedback: 'Not permitted.' } : { allow: true }),
      });
    });
    after(async () => { await harness.shutdown(); cleanup(); });

    it('completes a plain turn and reports usage', async () => {
      await harness.defineAgent(agent('plain-v1', 'mock-plain'));
      const result = await (await harness.startSession('plain-v1')).run('hi');
      assert.equal(result.status, 'completed');
      assert.equal(result.output, 'Hello from mock-plain.');
      assert.equal(result.usage.complete, true);
      assert.equal(result.usage.modelCalls, 1);
      assert.equal(result.usage.inputTokens, 100);
    });

    it('runs allowed tools and blocks a tool the policy denies', async () => {
      await harness.defineAgent(agent('tools-v1', 'mock-tools', { tools: ['app.lookup', 'app.forbidden', 'app.submit_result'] }));
      const result = await (await harness.startSession('tools-v1')).run('assess');
      assert.equal(result.status, 'completed');
      assert.equal(ran.lookup, 1);
      assert.equal(ran.forbidden, 0);
      assert.deepEqual(ran.submitted, [{ verdict: 'pass', findings: ['ok'] }]);
    });

    it('never runs a tool that is not in the agent definition', async () => {
      await harness.defineAgent(agent('narrow-v1', 'mock-unlisted', { tools: ['app.lookup'] }));
      const result = await (await harness.startSession('narrow-v1')).run('assess');
      assert.ok(['completed', 'failed'].includes(result.status));
      assert.equal(ran.forbidden, 0);
    });

    it('pauses a sensitive tool for approval; deny blocks it, approve runs it', async () => {
      await harness.defineAgent(agent('sensitive-v1', 'mock-sensitive', { tools: ['app.sensitive'], approvalRequired: ['app.sensitive'] }));
      const denied = await harness.startSession('sensitive-v1');
      const paused = await denied.run('do it');
      assert.equal(paused.status, 'needs_approval');
      assert.equal(paused.approvals[0]?.tool, 'app.sensitive');
      assert.equal(ran.sensitive, 0);
      await assert.rejects(denied.resume(), HarnessError);
      await denied.respond(paused.approvals[0]!.id, 'deny');
      assert.equal((await denied.resume()).status, 'completed');
      assert.equal(ran.sensitive, 0);

      const approved = await harness.startSession('sensitive-v1');
      const again = await approved.run('do it');
      await approved.respond(again.approvals[0]!.id, 'approve');
      assert.equal((await approved.resume()).status, 'completed');
      assert.equal(ran.sensitive, 1);
    });

    it('reports a retryable failure when the provider is rate limited', async () => {
      await harness.defineAgent(agent('limited-v1', 'mock-429'));
      const result = await (await harness.startSession('limited-v1')).run('hi');
      assert.equal(result.status, 'failed');
      assert.deepEqual(result.failure, { category: 'rate_limit', retryable: true });
    });

    it('lets a session override the model', async () => {
      const session = await harness.startSession('plain-v1', { model: { provider: 'Mock', model: 'mock-other' } });
      assert.equal((await session.run('hi')).output, 'Hello from mock-other.');
    });

    it('resumes a session from its reference', async () => {
      const session = await harness.startSession('plain-v1');
      await session.run('first');
      const resumed = await harness.resumeSession('plain-v1', session.reference());
      assert.equal(resumed.id, session.id);
      assert.equal((await resumed.run('second')).status, 'completed');
    });

    it('rejects a changed definition under an existing name', async () => {
      await harness.defineAgent(agent('plain-v1', 'mock-plain'));
      await assert.rejects(harness.defineAgent({ ...agent('plain-v1', 'mock-plain'), instructions: 'Changed.' }),
        (e: HarnessError) => e.code === 'definition_conflict');
    });

    it('rejects an agent that lists an unregistered tool, and an unknown agent', async () => {
      await assert.rejects(harness.defineAgent(agent('ghost-v1', 'mock-plain', { tools: ['app.missing'] })),
        (e: HarnessError) => e.code === 'unknown_tool');
      await assert.rejects(harness.startSession('nobody'), (e: HarnessError) => e.code === 'unknown_agent');
      await assert.rejects(harness.defineAgent({ ...agent('lost-v1', 'mock-plain'), model: { provider: 'Nowhere', model: 'm' } }),
        (e: HarnessError) => e.code === 'unknown_provider');
    });
  });
}

contract('fake', async () => ({ harness: new FakeHarness(scenario), cleanup: () => {} }));

let mock: MockProvider;
contract('openworker (mock provider)', async () => {
  mock = await startMockProvider();
  return {
    harness: new OpenWorkerHarness({ stateDir: mkdtempSync(join(tmpdir(), 'ow-contract-')) }),
    baseUrl: mock.url,
    cleanup: () => mock.close(),
  };
});
