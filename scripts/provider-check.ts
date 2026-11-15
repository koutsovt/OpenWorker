// Live check of one API-key provider through the OpenWorker adapter.
//
//   CHECK_PROVIDER=DeepSeek CHECK_MODEL=<model id> \
//     node --env-file=/path/to/private.env --disable-warning=ExperimentalWarning scripts/provider-check.ts
//
// The provider must exist in config/providers.yaml and its key must be in the environment.
// Optional: CHECK_BASE_URL overrides the provider's URL (for scripts/proxy-relay.ts).
// Makes a handful of small real model calls.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config/load.ts';
import { OpenWorkerHarness } from '../src/harness/openworker.ts';
import type { AgentSpec, Json, ToolSpec } from '../src/harness/port.ts';

const providerName = process.env.CHECK_PROVIDER;
const model = process.env.CHECK_MODEL;
const provider = loadConfig(resolve('config')).providers.find((p) => p.name === providerName);
if (!provider || !model || provider.api === 'claude-code') {
  console.error('Set CHECK_PROVIDER to an API-key provider from config/providers.yaml and CHECK_MODEL to its model id.');
  process.exit(2);
}
if (provider.apiKeyEnv && !process.env[provider.apiKeyEnv]) {
  console.error(`Set ${provider.apiKeyEnv}.`);
  process.exit(2);
}

const ran = { lookup: 0, forbidden: 0, sensitive: 0, submitted: [] as Json[] };
const object = (properties: Record<string, Json>, required: string[]): Json => ({ type: 'object', properties, required, additionalProperties: false });
const tool = (name: string, description: string, schema: Json, run: (args: Record<string, Json>) => Json): ToolSpec =>
  ({ name, description, inputSchema: schema, execute: async (args) => run(args) });
const tools = [
  tool('app.lookup', 'Look up a document id for a query.', object({ q: { type: 'string' } }, ['q']), () => { ran.lookup++; return { id: 'DOC-7741' }; }),
  tool('app.forbidden', 'Delete a record.', object({ target: { type: 'string' } }, ['target']), () => { ran.forbidden++; return { done: true }; }),
  tool('app.sensitive', 'Publish a report.', object({ title: { type: 'string' } }, ['title']), () => { ran.sensitive++; return { published: true }; }),
  tool('app.submit_result', 'Submit your final structured result. Call exactly once.',
    object({ verdict: { type: 'string', enum: ['pass', 'fail'] }, document_id: { type: 'string' }, findings: { type: 'array', items: { type: 'string' } } },
      ['verdict', 'document_id', 'findings']),
    (args) => { ran.submitted.push(args); return { accepted: true }; }),
];

const results: { ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail: string) => { results.push({ ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); };
const attempt = async (name: string, run: () => Promise<void>) => {
  try { await run(); } catch (e) { check(name, false, `threw: ${(e as Error).message}`); }
};

// The OpenWorker engine ignores HTTP proxies. Behind one, start scripts/proxy-relay.ts and point CHECK_BASE_URL at it.
const target = process.env.CHECK_BASE_URL ? { ...provider, baseUrl: process.env.CHECK_BASE_URL } : provider;
const harness = new OpenWorkerHarness({ stateDir: mkdtempSync(join(tmpdir(), 'provider-check-')) });
await harness.start({
  providers: [target], tools,
  policy: ({ tool: t }) => (t === 'app.forbidden' ? { allow: false, code: 'POLICY_DENY', feedback: 'Deleting records is not permitted.' } : { allow: true }),
});
const tag = `${provider.name}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
const define = async (name: string, extra: Partial<AgentSpec> = {}) => {
  const full = `${name}-${tag}`;
  await harness.defineAgent({ name: full, instructions: 'You are a careful assistant. Follow the task exactly.', model: { provider: provider.name, model }, tools: [], ...extra });
  return full;
};

try {
  await attempt('plain turn', async () => {
    const session = await harness.startSession(await define('plain'));
    const result = await session.run('Reply with exactly the word: ready');
    check('plain turn completes', result.status === 'completed' && /ready/i.test(result.output ?? ''), `status=${result.status} failure=${JSON.stringify(result.failure)} output=${JSON.stringify(result.output)}`);
    check('usage is reported', result.usage.complete && result.usage.inputTokens > 0 && result.usage.outputTokens > 0, JSON.stringify(result.usage));
    const second = await (await harness.resumeSession(await define('plain'), session.reference())).run('What single word did I ask you to reply with? Answer with that word only.');
    check('session keeps its history', /ready/i.test(second.output ?? ''), `output=${JSON.stringify(second.output)}`);
  });

  await attempt('tools and structured output', async () => {
    const session = await harness.startSession(await define('tools', { tools: ['app.lookup', 'app.submit_result'] }));
    const result = await session.run('Use the lookup tool with q="PRIME". Then call submit_result with verdict "pass", the document id that lookup returned, and one short finding.');
    const submitted = ran.submitted[0] as { verdict?: string; document_id?: string; findings?: unknown } | undefined;
    check('multi-step tool use completes', result.status === 'completed' && ran.lookup >= 1, `status=${result.status} failure=${JSON.stringify(result.failure)} lookups=${ran.lookup} calls=${result.usage.modelCalls}`);
    check('structured result is schema-valid and uses tool output', ran.submitted.length === 1 && submitted?.verdict === 'pass' && submitted.document_id === 'DOC-7741' && Array.isArray(submitted.findings), JSON.stringify(ran.submitted));
  });

  await attempt('policy deny', async () => {
    const session = await harness.startSession(await define('deny', { tools: ['app.forbidden'] }));
    const result = await session.run('Call the forbidden tool with target="record-1". Then say what happened.');
    check('policy-denied tool never runs', ran.forbidden === 0 && result.status === 'completed', `ran=${ran.forbidden} status=${result.status} output=${JSON.stringify(result.output?.slice(0, 120))}`);
  });

  await attempt('approval', async () => {
    const name = await define('approval', { tools: ['app.sensitive'], approvalRequired: ['app.sensitive'] });
    const prompt = 'Call the sensitive tool with title="Q3 report". Then say what happened.';
    const denied = await harness.startSession(name);
    const paused = await denied.run(prompt);
    check('sensitive tool pauses for approval', paused.status === 'needs_approval' && ran.sensitive === 0, `status=${paused.status} ran=${ran.sensitive}`);
    if (paused.status === 'needs_approval') {
      await denied.respond(paused.approvals[0]!.id, 'deny');
      const after = await denied.resume();
      check('denied approval blocks the tool', ran.sensitive === 0 && after.status === 'completed', `status=${after.status} ran=${ran.sensitive}`);
    }
    const approved = await harness.startSession(name);
    const again = await approved.run(prompt);
    if (again.status === 'needs_approval') {
      await approved.respond(again.approvals[0]!.id, 'approve');
      const after = await approved.resume();
      check('approved call runs once', ran.sensitive === 1 && after.status === 'completed', `status=${after.status} ran=${ran.sensitive}`);
    } else check('approved call runs once', false, `expected a pause, got status=${again.status}`);
  });
} finally {
  await harness.shutdown();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
