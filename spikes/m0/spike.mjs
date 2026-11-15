// M0 validation spike: harness mechanics against a local mock provider. No API keys, no spend.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness, hook } from '@openworkerai/harness-sdk';
import { startMock } from './mock-provider.mjs';

const results = [];
const record = (id, ok, detail) => { results.push({ id, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`); };
const attempt = async (id, fn) => { try { await fn(); } catch (e) { record(id, false, `threw ${e.code ?? ''} ${e.message}`.slice(0, 300)); } };

const mock = await startMock();
const stateDir = mkdtempSync(join(tmpdir(), 'ow-m0-'));
const calls = { lookup: 0, forbidden: 0, submit: [], sensitive: 0, hook: [] };

const start = () => Harness.start({
  stateDir, sandbox: 'off',
  hooks: [hook.beforeTool({ name: 'policy', tools: ['app.lookup', 'app.forbidden', 'app.submit_result', 'app.sensitive'],
    run: async (ctx) => { calls.hook.push(ctx.tool);
      return String(ctx.tool).includes('forbidden')
        ? { action: 'block', code: 'POLICY_DENY', feedbackToModel: 'Not permitted by policy.' }
        : { action: 'allow' }; } })],
});
const registerAll = async (h) => {
  await h.setModelProvider({ name: 'Mock', api: 'chat-completions', baseUrl: mock.url,
    credentials: { apiKey: 'sk-dummy', storage: 'memory' } });
  await h.setModelProvider({ name: 'Mock2', api: 'chat-completions', baseUrl: mock.url,
    credentials: { apiKey: 'sk-dummy-2', storage: 'memory' } });
  const obj = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
  await h.registerTools({ namespace: 'app', tools: {
    lookup: { description: 'Read-only lookup.', inputSchema: obj({ q: { type: 'string' } }, ['q']),
      execute: async () => { calls.lookup++; return { hits: ['doc-1#p3'] }; } },
    forbidden: { description: 'Must never run.', inputSchema: obj({ target: { type: 'string' } }, ['target']),
      execute: async () => { calls.forbidden++; return { done: true }; } },
    sensitive: { description: 'Needs human approval.', inputSchema: obj({ action: { type: 'string' } }, ['action']),
      execute: async () => { calls.sensitive++; return { done: true }; } },
    submit_result: { description: 'Submit the structured result.',
      inputSchema: obj({ verdict: { type: 'string', enum: ['pass', 'fail'] }, findings: { type: 'array', items: { type: 'string' } } }, ['verdict', 'findings']),
      execute: async (args) => { calls.submit.push(args); return { accepted: true }; } },
  } });
};
const base = { planning: false, memory: false, scheduling: false, builtinTools: { askUser: false, readHistory: false } };
const define = (h, name, model, extra = {}) => h.createAgent({ ...base, name, instructions: 'Test agent.',
  defaultModel: { provider: 'Mock', name: model }, tools: [], approvals: { mode: 'never' }, ...extra });
const allTools = ['app.lookup', 'app.forbidden', 'app.submit_result', 'app.sensitive'];

let h = await start();
await registerAll(h);

await attempt('C0 start+plain turn', async () => {
  const s = await define(h, 'plain-v1', 'mock-plain').newSession();
  const r = await s.run('hi');
  record('C0 start+plain turn', r.status === 'completed' && /Hello/.test(r.finalOutput ?? ''), `status=${r.status} out=${r.finalOutput}`);
});

await attempt('C1 concurrent sessions', async () => {
  const agent = define(h, 'slow-v1', 'mock-slow');
  const t0 = Date.now();
  const rs = await Promise.all([1, 2, 3, 4].map(async () => (await agent.newSession()).run('go')));
  const ms = Date.now() - t0;
  record('C1 concurrent sessions', rs.every((r) => r.status === 'completed') && ms < 4500, `4 sessions x 1.5s finished in ${ms}ms`);
});

let usageEvents = 0, toolEvents = [];
await attempt('C3/C4/C5 tools, hook, usage', async () => {
  const s = await define(h, 'tools-v1', 'mock-tools', { tools: allTools }).newSession();
  const run = await s.send('assess');
  for await (const ev of run.events()) {
    if (ev.event.type === 'model_usage') usageEvents++;
    if (ev.summary?.type === 'tool_started') toolEvents.push(ev.summary.qualifiedName ?? ev.summary.tool);
  }
  const r = await run.result();
  record('C3 submit_result tool carries structured output', calls.submit.length === 1 && calls.submit[0].verdict === 'pass', JSON.stringify(calls.submit));
  record('C4 beforeTool hook blocks, fail-closed', calls.forbidden === 0 && calls.hook.some((t) => String(t).includes('forbidden')) && r.status === 'completed',
    `forbidden executed=${calls.forbidden} hookSaw=${JSON.stringify(calls.hook)} status=${r.status}`);
  record('C5 model_usage events emitted', usageEvents > 0, `${usageEvents} usage events; toolEvents=${JSON.stringify(toolEvents)}`);
});

await attempt('C3b invalid structured output rejected', async () => {
  const before = calls.submit.length;
  const s = await define(h, 'badsubmit-v1', 'mock-bad-submit', { tools: ['app.submit_result'] }).newSession();
  const r = await s.run('assess');
  record('C3b schema-invalid arguments never reach the tool', calls.submit.length === before, `status=${r.status} newSubmits=${calls.submit.length - before} failure=${r.failure ?? ''}`);
});

await attempt('C9 tool not in definition is not offered', async () => {
  const s = await define(h, 'notools-v1', 'mock-tools', { tools: ['app.lookup'] }).newSession();
  const before = calls.forbidden;
  const r = await s.run('assess');
  const offered = mock.seen.filter((x) => x.model === 'mock-tools').at(-1)?.tools;
  record('C9 unlisted tool not offered and not executed', calls.forbidden === before && !offered?.includes('app__forbidden'), `offered=${JSON.stringify(offered)} status=${r.status}`);
});

await attempt('C10 approval gate', async () => {
  const agent = define(h, 'sensitive-v1', 'mock-sensitive', { tools: ['app.sensitive'], approvals: { mode: 'only', tools: ['app.sensitive'] } });
  const s1 = await agent.newSession();
  const r1 = await s1.run('do it');
  const p = r1.interruptions?.[0];
  record('C10a sensitive tool pauses for approval', r1.status === 'interrupted' && p?.kind === 'approval' && calls.sensitive === 0, `status=${r1.status} kind=${p?.kind} tool=${p?.tool}`);
  await s1.respond(p, { decision: 'deny' });
  const r2 = await s1.resume();
  record('C10b deny prevents execution', calls.sensitive === 0 && r2.status === 'completed', `status=${r2.status} executed=${calls.sensitive}`);
  const s2 = await agent.newSession();
  const r3 = await s2.run('do it');
  await s2.respond(r3.interruptions[0], { decision: 'once' });
  const r4 = await s2.resume();
  record('C10c approve once executes', calls.sensitive === 1 && r4.status === 'completed', `status=${r4.status} executed=${calls.sensitive}`);
});

await attempt('C11 rate limit: retries and diagnostics', async () => {
  const n0 = mock.seen.length;
  const s = await define(h, 'ratelimited-v1', 'mock-429').newSession();
  const r = await s.run('hi');
  const n = mock.seen.length - n0;
  record('C11 429 gives failed status with retryable diagnostic, no silent fallback', r.status === 'failed' && r.providerError?.category === 'rate_limit',
    `status=${r.status} attempts=${n} diag=${JSON.stringify(r.providerError)}`);
});

await attempt('C12 per-session model/provider override', async () => {
  const s = await define(h, 'override-v1', 'mock-plain').newSession({ model: { provider: 'Mock2', name: 'mock-other' } });
  const r = await s.run('hi');
  const last = mock.seen.at(-1);
  record('C12 session model override', /mock-other/.test(r.finalOutput ?? '') && last.auth === 'Bearer sk-dummy-2', `out=${r.finalOutput} auth=${last.auth}`);
});

await attempt('C13 immutable definitions', async () => {
  let err;
  try { const a = h.createAgent({ ...base, name: 'plain-v1', instructions: 'CHANGED', defaultModel: { provider: 'Mock', name: 'mock-plain' }, tools: [], approvals: { mode: 'never' } }); await a.ready(); }
  catch (e) { err = e; }
  record('C13 changed definition under same name is rejected', !!err, err ? `${err.code} ${JSON.stringify(err.context ?? {})}`.slice(0, 200) : 'accepted silently');
});

await attempt('C7 addendum size', async () => {
  const s = await define(h, 'addendum-v1', 'mock-plain').newSession();
  const sizes = {};
  for (const kb of [8, 32, 64, 256]) {
    try { const r = await s.run('hi', { instructionAddendum: 'x'.repeat(kb * 1024 - 8) }); sizes[kb] = r.status; }
    catch (e) { sizes[kb] = `rejected:${e.code}`; }
  }
  record('C7 instructionAddendum size limit', true, JSON.stringify(sizes));
});

let ref;
await attempt('C6 restart and resume', async () => {
  const agent = define(h, 'resume-v1', 'mock-plain');
  const s = await agent.newSession();
  await s.run('first');
  ref = s.reference();
  await h.shutdown();
  h = await start(); await registerAll(h);
  const s2 = await define(h, 'resume-v1', 'mock-plain').resumeSession(ref);
  const st = await s2.state();
  const r = await s2.run('second');
  record('C6 session survives harness restart', r.status === 'completed' && st.canAcceptMessage === true, `state=${st.status} status=${r.status}`);
});

await h.shutdown().catch(() => {});
mock.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
