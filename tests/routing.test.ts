import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FakeHarness } from '../src/harness/fake.ts';
import { HarnessError, type AgentSpec, type ProviderSpec } from '../src/harness/port.ts';
import { RoutingHarness } from '../src/harness/routing.ts';

const providers: ProviderSpec[] = [{ name: 'Claude', api: 'claude-code' }, { name: 'OpenAI', api: 'responses' }];
const agent = (name: string, provider: string): AgentSpec => ({ name, instructions: 'x', model: { provider, model: 'm' }, tools: [] });
const make = async () => {
  const routing = new RoutingHarness([
    { harness: new FakeHarness(() => ({ text: 'from claude-code engine' })), serves: (p) => p.api === 'claude-code' },
    { harness: new FakeHarness(() => ({ text: 'from api engine' })), serves: (p) => p.api !== 'claude-code' },
  ]);
  await routing.start({ providers, tools: [] });
  return routing;
};

describe('routing harness', () => {
  it('sends each agent to the engine that serves its provider', async () => {
    const routing = await make();
    await routing.defineAgent(agent('author-v1', 'Claude'));
    await routing.defineAgent(agent('assure-v1', 'OpenAI'));
    assert.equal((await (await routing.startSession('author-v1')).run('go')).output, 'from claude-code engine');
    assert.equal((await (await routing.startSession('assure-v1')).run('go')).output, 'from api engine');
  });

  it('refuses a model override that would cross engines', async () => {
    const routing = await make();
    await routing.defineAgent(agent('author-v1', 'Claude'));
    await assert.rejects(routing.startSession('author-v1', { model: { provider: 'OpenAI', model: 'm' } }),
      (e: HarnessError) => e.code === 'unknown_provider');
  });

  it('rejects a provider that no engine serves', async () => {
    const routing = new RoutingHarness([{ harness: new FakeHarness(() => ({ text: '' })), serves: (p) => p.api === 'claude-code' }]);
    await assert.rejects(routing.start({ providers, tools: [] }), (e: HarnessError) => e.code === 'unknown_provider');
  });
});
