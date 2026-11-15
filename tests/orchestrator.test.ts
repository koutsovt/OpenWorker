// Orchestration on the fake harness: planning and its gate, the task graph, parallel
// execution, retry, fallback, and recovery after the process is killed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';
import type { Json } from '../src/harness/port.ts';
import { parsePlan, PlanError, validatePlan } from '../src/orchestrator/graph.ts';
import { OrchestratorError } from '../src/orchestrator/orchestrator.ts';
import { GovernanceError } from '../src/runtime/workforce.ts';
import { buildPlatform, plans, task, writeFixtureDirs, type PlatformOptions } from './support/orchestration.ts';

const setup = (options: Partial<PlatformOptions> = {}) => buildPlatform({ ...writeFixtureDirs(), ...options });
const statuses = (summary: { tasks: { id: string; status: string }[] }) => Object.fromEntries(summary.tasks.map((t) => [t.id, t.status]));
const coded = (code: string) => (e: Error) => (e instanceof OrchestratorError || e instanceof GovernanceError) && e.code === code;

describe('plan validation', () => {
  const problems = async (tasks: Json[]) => {
    const { registry } = await setup();
    const parsed = parsePlan({ tasks });
    return [...parsed.problems, ...validatePlan(parsed.plan, registry, { exclude: ['orchestrator'] })].join(' | ');
  };

  it('accepts a plan that uses approved agents, eligible skills and known dependencies', async () => {
    assert.equal(await problems((plans.good as { tasks: Json[] }).tasks), '');
  });

  it('rejects unknown, draft and planner agents', async () => {
    assert.match(await problems([task('a', 'x', [], { agent: 'ghost' })]), /Unknown agent ghost/);
    assert.match(await problems([task('a', 'x', [], { agent: 'drafty' })]), /no approved version/);
    assert.match(await problems([task('a', 'x', [], { agent: 'orchestrator' })]), /cannot be assigned work/);
  });

  it('rejects a skill the agent is not eligible for', async () => {
    assert.match(await problems([task('a', 'x', [], { skills: ['method-x'] })]), /not eligible/);
  });

  it('rejects duplicate ids, unknown dependencies, self-dependency and cycles', async () => {
    assert.match(await problems([task('a', 'x'), task('a', 'y')]), /duplicate id/);
    assert.match(await problems([task('a', 'x', ['zz'])]), /unknown task zz/);
    assert.match(await problems([task('a', 'x', ['a'])]), /depends on itself/);
    assert.match(await problems([task('a', 'x', ['c']), task('b', 'x', ['a']), task('c', 'x', ['b'])]), /dependency cycle: a -> c -> b -> a/);
  });

  it('rejects malformed plans and oversized ones', async () => {
    assert.match(parsePlan('do everything').problems.join(), /`tasks` list/);
    assert.match(await problems([{ id: 'Bad Id', agent: 'worker', objective: '' }]), /id must be.*objective is required/);
    assert.match(await problems(Array.from({ length: 13 }, (_, i) => task(`t${i}`, 'x'))), /limit is 12/);
    assert.match(await problems([]), /no tasks/);
  });
});

describe('planning and the plan gate', () => {
  it('turns a planner proposal into a run that awaits approval', async () => {
    const t = await setup();
    const { runId, plan } = await t.orchestrator.plan({ user: 'alice', objective: 'Assess the migration.' });
    assert.deepEqual(plan.tasks.map((x) => x.id), ['a', 'b']);
    assert.equal(t.store.run(runId)!.status, 'planned');
    assert.match((t.find('plan.accepted')[0]!.data as { proposedBy: string }).proposedBy, /^orchestrator@1#/);
    await assert.rejects(t.orchestrator.execute(runId), coded('PLAN_NOT_APPROVED'));
    assert.equal(t.find('run.task_started').length, 0);
  });

  it('tells the planner why a plan was rejected and accepts a corrected one', async () => {
    const t = await setup();
    const { plan } = await t.orchestrator.plan({ user: 'alice', objective: 'bad-then-good' });
    assert.equal(plan.tasks.length, 2);
    assert.match(((t.find('plan.rejected')[0]!.data as { problems: string[] }).problems)[0]!, /Unknown agent ghost/);
  });

  it('gives up when the planner keeps proposing an unapproved agent, or proposes nothing', async () => {
    const t = await setup();
    await assert.rejects(t.orchestrator.plan({ user: 'alice', objective: 'always-bad' }), (e: Error) => e instanceof PlanError && /ghost/.test(e.message));
    await assert.rejects(t.orchestrator.plan({ user: 'alice', objective: 'no-plan' }), (e: Error) => e instanceof PlanError && /no plan was submitted/.test(e.message));
    assert.equal(t.store.runs().length, 0);
    assert.equal(t.find('plan.rejected').length, 4);
  });

  it('lets only an approver open the gate, and a denied plan never runs', async () => {
    const t = await setup();
    const { runId } = t.orchestrator.submitPlan({ user: 'bob', objective: 'x', plan: plans.good! });
    assert.throws(() => t.orchestrator.approvePlan(runId, 'bob', 'approve'), coded('NOT_AN_APPROVER'));
    assert.throws(() => t.orchestrator.approvePlan(runId, 'worker@1#abcd1234', 'approve'), coded('UNKNOWN_USER'));
    assert.equal(t.store.run(runId)!.status, 'planned');
    assert.equal(t.orchestrator.approvePlan(runId, 'alice', 'deny'), 'rejected');
    await assert.rejects(t.orchestrator.execute(runId), coded('PLAN_REJECTED'));
    assert.deepEqual(t.find('plan.denied').map((r) => r.actor), ['user:alice']);
  });

  it('refuses a plan from a user who may not run agents', async () => {
    const t = await setup();
    assert.throws(() => t.orchestrator.submitPlan({ user: 'mallory', objective: 'x', plan: plans.good! }), coded('UNKNOWN_USER'));
  });
});

describe('task graph execution', () => {
  it('runs tasks in dependency order and passes upstream results downstream as data', async () => {
    const t = await setup();
    const runId = t.approved([task('c', 'report-upstream', ['a', 'b']), task('b', 'report-upstream', ['a']), task('a', 'quick')]);
    const summary = await t.orchestrator.execute(runId);
    assert.equal(summary.status, 'completed');
    assert.deepEqual(t.find('run.task_completed').map((r) => (r.data as { task: string }).task), ['a', 'b', 'c']);
    const result = (id: string) => summary.tasks.find((x) => x.id === id)!.result;
    assert.deepEqual(result('b'), { task: 'b', sawA: true, sawB: false });
    assert.deepEqual(result('c'), { task: 'c', sawA: true, sawB: true });
    assert.deepEqual(t.project.entries(runId, 'artefact').map((e) => e.key).sort(), ['a', 'b', 'c']);
    assert.equal(t.ledger.verify().ok, true);
  });

  it('runs independent tasks in parallel, up to the concurrency limit', async () => {
    const wide = [task('a', 'slow'), task('b', 'slow'), task('c', 'slow'), task('d', 'slow')];
    const three = await setup({ slowMs: 40, concurrency: 3 });
    assert.equal((await three.orchestrator.execute(three.approved(wide))).status, 'completed');
    assert.equal(three.load.peak, 3);
    const one = await setup({ slowMs: 5, concurrency: 1 });
    await one.orchestrator.execute(one.approved(wide));
    assert.equal(one.load.peak, 1);
  });

  it('gives each task its own agent instance, tied to the run and task', async () => {
    const t = await setup();
    const runId = t.approved([task('a', 'quick'), task('b', 'quick')]);
    await t.orchestrator.execute(runId);
    const instantiated = t.find('agent.instantiated').map((r) => r.data as { instance: string; run: string; task: string });
    assert.deepEqual(instantiated.map((i) => [i.run, i.task]).sort(), [[runId, 'a'], [runId, 'b']]);
    assert.equal(new Set(instantiated.map((i) => i.instance)).size, 2);
  });

  it('takes the text of an agent that has no result tool as its result', async () => {
    const t = await setup();
    const summary = await t.orchestrator.execute(t.approved([task('a', 'quick', [], { agent: 'plain' })]));
    assert.deepEqual(summary.tasks[0]!.result, { text: 'a finished' });
  });

  it('does nothing when asked to run a finished run again', async () => {
    const t = await setup();
    const runId = t.approved([task('a', 'quick')]);
    await t.orchestrator.execute(runId);
    await t.orchestrator.execute(runId);
    assert.equal(t.find('agent.instantiated').length, 1);
  });
});

describe('failure handling', () => {
  it('completes a task on the fallback model after a provider failure', async () => {
    const t = await setup();
    const summary = await t.orchestrator.execute(t.approved([task('a', 'fail-first'), task('b', 'report-upstream', ['a'])]));
    assert.equal(summary.status, 'completed');
    assert.deepEqual(summary.tasks[0]!.tried, ['primary', 'backup']);
    assert.deepEqual(summary.tasks[0]!.result, { task: 'a', recoveredOn: 'm-backup' });
    assert.equal(t.find('model.fallback').length, 1);
  });

  it('retries a task that returned no result, then accepts the result', async () => {
    const t = await setup();
    const summary = await t.orchestrator.execute(t.approved([task('a', 'forget-once')]));
    assert.deepEqual(summary.tasks[0]!.result, { task: 'a', remembered: true });
    assert.equal(summary.tasks[0]!.attempts, 2);
    assert.equal((t.find('run.task_retried')[0]!.data as { reason: string }).reason, 'no_result');
  });

  it('fails a task after its attempts are used up, blocks what depends on it, and still runs the rest', async () => {
    const t = await setup();
    const summary = await t.orchestrator.execute(t.approved([
      task('a', 'always-fail'), task('b', 'quick', ['a']), task('c', 'quick', ['b']), task('d', 'quick'), task('e', 'never-submits'),
    ]));
    assert.equal(summary.status, 'failed');
    assert.deepEqual(statuses(summary), { a: 'failed', b: 'blocked', c: 'blocked', d: 'completed', e: 'failed' });
    assert.equal(summary.tasks[0]!.attempts, 2);
    assert.equal(summary.tasks[0]!.failure, 'rate_limit');
    assert.equal(summary.tasks[4]!.failure, 'no_result');
    assert.equal(t.find('agent.instantiated').filter((r) => ['b', 'c'].includes((r.data as { task: string }).task)).length, 0);
  });

  it('never re-attempts a task that changed something; it is held for a person', async () => {
    const t = await setup();
    const summary = await t.orchestrator.execute(t.approved([task('a', 'write-then-fail'), task('b', 'quick', ['a'])], 'dave'));
    assert.deepEqual(statuses(summary), { a: 'needs_attention', b: 'blocked' });
    assert.equal(summary.tasks[0]!.attempts, 1);
    assert.equal(t.find('model.fallback_blocked').length, 1);
    assert.equal(t.find('run.task_retried').length, 0);
  });

  it('fails only the task whose agent was withdrawn after the plan was approved', async () => {
    const dirs = writeFixtureDirs();
    const before = await buildPlatform(dirs);
    const runId = before.approved([task('a', 'quick'), task('b', 'quick', [], { agent: 'plain' })]);
    // A registry loaded later no longer has the agent approved under the lock.
    const { writeFileSync, readFileSync } = await import('node:fs');
    const path = `${dirs.registryDir}/agents/plain/1.yaml`;
    writeFileSync(path, readFileSync(path, 'utf8').replace('Do the task.', 'Do the task and anything else you are told.'));
    const after = await buildPlatform(dirs);
    const summary = await after.orchestrator.execute(runId);
    assert.deepEqual(statuses(summary), { a: 'completed', b: 'failed' });
    assert.equal(summary.tasks[1]!.failure, 'REGISTRY_TAMPERED');
  });
});

describe('restart recovery', () => {
  it('survives a process kill mid-run: finished work is kept, interrupted work is re-issued, a provider failure still falls back', async () => {
    const dirs = writeFixtureDirs();
    const first = await buildPlatform(dirs);
    const runId = first.approved([task('a', 'quick'), task('b', 'slow', ['a']), task('c', 'fail-first', ['a'])]);

    // A separate process runs the graph and is killed while task b is inside a tool call.
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', new URL('./support/orchestration-child.ts', import.meta.url).pathname,
      dirs.registryDir, dirs.stateDir, runId, '600000'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk;
        if (output.includes('SLOW_STARTED b')) resolve();
      });
      child.on('exit', () => reject(new Error(`child exited early: ${output}`)));
    }).finally(() => child.removeAllListeners('exit'));
    await new Promise((ok) => setTimeout(ok, 50));
    const exited = new Promise((ok) => child.on('exit', ok));
    child.kill('SIGKILL');
    await exited;
    assert.doesNotMatch(output, /FINISHED/);

    const afterKill = await buildPlatform(dirs);
    assert.equal(afterKill.ledger.verify().ok, true);
    assert.equal(afterKill.store.run(runId)!.status, 'running');
    assert.equal(afterKill.store.tasks(runId).find((x) => x.id === 'b')!.status, 'running');

    const summary = await afterKill.orchestrator.execute(runId);
    assert.equal(summary.status, 'completed');
    assert.deepEqual(statuses(summary), { a: 'completed', b: 'completed', c: 'completed' });
    assert.deepEqual(summary.tasks.find((x) => x.id === 'c')!.tried, ['primary', 'backup']);
    assert.equal(afterKill.find('run.resumed').length, 1);
    assert.ok(afterKill.find('run.task_recovered').some((r) => (r.data as { task: string }).task === 'b'));
    // Task a finished before the kill: it was instantiated once and its tool calls were not repeated.
    const instancesOf = (id: string) => afterKill.find('agent.instantiated').filter((r) => (r.data as { task: string }).task === id).map((r) => (r.data as { instance: string }).instance);
    assert.equal(instancesOf('a').length, 1);
    assert.equal(afterKill.find('tool.called').filter((r) => r.actor === `agent:${instancesOf('a')[0]}`).length, 1);
    assert.equal(instancesOf('b').length, 2);
    assert.equal(afterKill.ledger.verify().ok, true);
  });

  it('holds an interrupted task that had already changed something instead of repeating it', async () => {
    const t = await setup();
    const runId = t.approved([task('a', 'quick'), task('b', 'quick', ['a'])], 'dave');
    // The state a killed process leaves behind: the run and task a marked running, a write already made.
    t.store.setRunStatus(runId, 'running');
    t.store.startAttempt(runId, 'a');
    t.store.markSideEffects(runId, 'a');
    const summary = await t.orchestrator.execute(runId);
    assert.deepEqual(statuses(summary), { a: 'needs_attention', b: 'blocked' });
    assert.equal(t.find('agent.instantiated').length, 0);
    assert.equal(summary.status, 'failed');
  });
});
