// Live check of the Claude Code adapter. Run on your own machine, signed in to
// Claude Code with your subscription:
//
//   node --disable-warning=ExperimentalWarning scripts/claude-code-check.ts
//
// It makes a handful of small real model calls. Optional: CLAUDE_CODE_MODEL=<model>.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeHarness } from '../src/harness/claude-code.ts';
import type { AgentSpec, Json, ToolSpec } from '../src/harness/port.ts';

const model = process.env.CLAUDE_CODE_MODEL ?? 'default';
const ran = { lookup: 0, forbidden: 0, sensitive: 0 };
const object = (properties: Record<string, Json>, required: string[]): Json => ({ type: 'object', properties, required, additionalProperties: false });
const tool = (name: string, description: string, schema: Json, run: () => Json): ToolSpec =>
  ({ name, description, inputSchema: schema, execute: async () => run() });
const tools = [
  tool('app.lookup', 'Look up a document id for a query.', object({ q: { type: 'string' } }, ['q']), () => { ran.lookup++; return { id: 'DOC-7741' }; }),
  tool('app.forbidden', 'Delete a record.', object({ target: { type: 'string' } }, ['target']), () => { ran.forbidden++; return { done: true }; }),
  tool('app.sensitive', 'Publish a report.', object({ title: { type: 'string' } }, ['title']), () => { ran.sensitive++; return { published: true }; }),
];

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); };
const attempt = async (name: string, run: () => Promise<void>) => {
  try { await run(); } catch (e) { check(name, false, `threw: ${(e as Error).message}`); }
};

const harness = new ClaudeCodeHarness({ cwd: mkdtempSync(join(tmpdir(), 'claude-code-check-')) });
await harness.start({
  providers: [{ name: 'Claude', api: 'claude-code' }], tools,
  policy: ({ tool: t }) => (t === 'app.forbidden' ? { allow: false, code: 'POLICY_DENY', feedback: 'Deleting records is not permitted.' } : { allow: true }),
});
const define = async (name: string, extra: Partial<AgentSpec> = {}) => {
  await harness.defineAgent({ name, instructions: 'You are a careful assistant. Follow the task exactly.', model: { provider: 'Claude', model }, tools: [], ...extra });
  return name;
};

await attempt('plain turn', async () => {
  const session = await harness.startSession(await define('check-plain'));
  const result = await session.run('Reply with exactly the word: ready');
  check('plain turn completes', result.status === 'completed' && /ready/i.test(result.output ?? ''), `status=${result.status} output=${JSON.stringify(result.output)}`);
  check('usage is reported', result.usage.complete && result.usage.outputTokens > 0, JSON.stringify(result.usage));
  const init = harness.lastInit;
  check('no built-in tools are present', !!init && init.tools.length === 0, `tools=${JSON.stringify(init?.tools)}`);
  check('signed in with a subscription, not an API key', !!init?.apiKeySource && init.apiKeySource !== 'ANTHROPIC_API_KEY', `apiKeySource=${init?.apiKeySource}`);

  const second = await (await harness.resumeSession('check-plain', session.reference())).run('What single word did I ask you to reply with? Answer with that word only.');
  check('session resumes with its history', /ready/i.test(second.output ?? ''), `output=${JSON.stringify(second.output)}`);
});

await attempt('custom tool', async () => {
  const session = await harness.startSession(await define('check-tool', { tools: ['app.lookup'] }));
  const result = await session.run('Use the lookup tool with q="PRIME" and reply with only the id it returns.');
  check('platform tool runs and its result is used', ran.lookup >= 1 && /DOC-7741/.test(result.output ?? ''), `ran=${ran.lookup} output=${JSON.stringify(result.output)}`);
  check('only the agent\'s platform tools are offered', JSON.stringify(harness.lastInit?.tools) === JSON.stringify(['mcp__platform__app__lookup']), `tools=${JSON.stringify(harness.lastInit?.tools)}`);
});

await attempt('policy deny', async () => {
  const session = await harness.startSession(await define('check-deny', { tools: ['app.forbidden'] }));
  const result = await session.run('Call the forbidden tool with target="record-1". Then say what happened.');
  check('policy-denied tool never runs', ran.forbidden === 0, `ran=${ran.forbidden} status=${result.status} output=${JSON.stringify(result.output)}`);
});

await attempt('approval', async () => {
  const name = await define('check-approval', { tools: ['app.sensitive'], approvalRequired: ['app.sensitive'] });
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

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
