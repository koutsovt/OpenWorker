// Milestone 4 end to end: the real registry, the real model policies and the real scenario
// knowledge pack, with a scripted model in place of the providers. Everything the platform
// decides (plan checks, contracts, citations, assurance gate, rework, report) is real.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import type { Json } from '../src/harness/port.ts';
import { KnowledgeBase } from '../src/memory/knowledge.ts';
import { checkResult, citedEvidence } from '../src/orchestrator/contracts.ts';
import { PlanError } from '../src/orchestrator/graph.ts';
import { Orchestrator, OrchestratorError } from '../src/orchestrator/orchestrator.ts';
import { Registry } from '../src/registry/registry.ts';
import { GovernanceError } from '../src/runtime/workforce.ts';
import { platform, scenarioDir } from './support/scenario-platform.ts';

const statusOf = (summary: { tasks: { id: string; status: string }[] }, id: string) => summary.tasks.find((t) => t.id === id)?.status;

describe('registry content', () => {
  const registry = new Registry(resolve('registry'));

  it('has the seven approved agents, each matching the lock', () => {
    assert.deepEqual(registry.usableAgents().map((a) => `${a.id}@${a.version}`),
      ['assurance@2', 'capability-analyst@1', 'data@1', 'orchestrator@2', 'research@1', 'security@1', 'solution-architecture@1']);
    assert.deepEqual(registry.problems(), []);
  });

  it('has the eight skills, each eligible for at least one agent, and resolves dependencies first', () => {
    const eligible = new Set(registry.usableAgents().flatMap((a) => registry.eligibleSkills(a).map((s) => s.id)));
    assert.deepEqual([...eligible].sort(), ['capability-gap-analysis', 'evidence-verification', 'hosting-architecture-review', 'independent-solution-assurance',
      'integration-architecture', 'requirements-traceability', 'security-threat-modelling', 'solution-architecture-assessment']);
    assert.deepEqual(registry.resolveSkills(registry.agent('assurance'), ['independent-solution-assurance']).map((s) => s.id),
      ['evidence-verification', 'independent-solution-assurance']);
  });

  it('gives no agent a tool that writes, and only read tools exist beside skill proposals', () => {
    for (const agent of registry.usableAgents())
      for (const tool of agent.allowedTools) assert.equal(registry.tools.get(tool)!.action, 'read', `${agent.id} has ${tool}`);
  });
});

describe('output contracts', () => {
  const context = { evidenceIds: new Set(['ev-1']), taskIds: new Set(['a']) };
  const ok = { summary: 's', claims: [{ statement: 'c', evidence: ['ev-1'] }] };

  it('accepts a well-formed result and names what is wrong with a malformed one', () => {
    assert.deepEqual(checkResult('analysis', ok, context), []);
    assert.match(checkResult('analysis', { summary: '', claims: [] }, context).join(), /summary.*claims/s);
    assert.match(checkResult('evidence-pack', { summary: 's', claims: [{ statement: 'c', evidence: [] }] }, context).join(), /at least one evidence id/);
    assert.match(checkResult('assurance', { verdict: 'maybe', summary: 's', findings: [] }, context).join(), /verdict/);
  });

  it('rejects a citation of evidence that was never retrieved, wherever it appears', () => {
    assert.match(checkResult('analysis', { ...ok, options: [{ name: 'x', evidence: ['ev-7'] }] }, context).join(), /does not exist in this run: ev-7/);
    assert.match(checkResult(undefined, { evidence: ['made-up'] }, context).join(), /made-up/);
    assert.deepEqual(citedEvidence({ a: [{ evidence: ['ev-1'] }], evidence: ['ev-2'] }).sort(), ['ev-1', 'ev-2']);
  });

  it('rejects assurance findings about tasks that are not under review', () => {
    const finding = { severity: 'major', issue: 'i', resolution: 'r' };
    assert.deepEqual(checkResult('assurance', { verdict: 'pass', summary: 's', findings: [{ ...finding, task: 'a' }] }, context), []);
    assert.match(checkResult('assurance', { verdict: 'pass', summary: 's', findings: [{ ...finding, task: 'zz' }] }, context).join(), /not under review: zz/);
  });
});

describe('research ethics eforms scenario, end to end', () => {
  it('plans, gathers evidence, analyses in parallel, catches a seeded defect, reworks it and writes a traceable report', async () => {
    const t = await platform();
    const runId = await t.start();
    const summary = await t.orchestrator.execute(runId);
    assert.equal(summary.status, 'completed');
    assert.deepEqual(summary.tasks.map((x) => x.id),
      ['evidence', 'architecture', 'security', 'data', 'costs', 'assurance', 'architecture-rework', 'costs-rework', 'assurance-2', 'report']);
    assert.ok(summary.tasks.every((x) => x.status === 'completed'));

    // What the agents read is what the documents say.
    const evidence = t.evidence.list(runId);
    assert.deepEqual(evidence.map((e) => `${e.id} ${e.document}#${e.anchor}`), ['ev-1 requirements.md#p10', 'ev-2 hosting-costs.md#p9', 'ev-3 prime-integration.md#p3']);
    const kb = new KnowledgeBase(join(scenarioDir, 'knowledge'));
    assert.match(kb.read('requirements.md', 'p10')!.text, /stored in Australia/);
    assert.match(kb.read('hosting-costs.md', 'p9')!.text, /does not offer an Australian region/);

    // Authors on Claude, the reviewer on OpenAI, and the platform recorded that.
    const model = (id: string) => summary.tasks.find((x) => x.id === id)!.model;
    assert.equal(model('architecture'), 'claude-author');
    assert.equal(model('assurance'), 'openai-assurance');
    const verdicts = t.find('assurance.verdict').map((r) => r.data as { task: string; verdict: string; major: number; independent: boolean });
    assert.deepEqual(verdicts.map((v) => [v.task, v.verdict, v.major, v.independent]), [['assurance', 'conditional', 1, true], ['assurance-2', 'pass', 0, true]]);
    assert.equal(t.find('assurance.independence_reduced').length, 0);

    // The task with a major finding was reworked, and the task built on it was redone after it, on the revised result.
    assert.deepEqual(t.find('assurance.rework_requested')[0]!.data, { run: runId, tasks: ['architecture'], cascaded: ['costs'] });
    const tasks = t.store.tasks(runId);
    const task = (id: string) => tasks.find((x) => x.id === id)!;
    assert.deepEqual(task('costs-rework').dependsOn, ['architecture-rework', 'costs', 'assurance']);
    assert.deepEqual(task('assurance-2').dependsOn, ['evidence', 'architecture-rework', 'security', 'data', 'costs-rework', 'assurance']);
    assert.deepEqual(task('report').dependsOn, ['evidence', 'architecture-rework', 'security', 'data', 'costs-rework', 'assurance-2']);
    assert.ok(t.inputs.some((i) => i.includes('<your-task id="costs-rework">') && i.includes('<task-result task="architecture-rework"') && i.includes('has been revised after independent review')));
    const reviewer = t.find('agent.instantiated').find((r) => (r.data as { task: string }).task === 'assurance')!.data as { skills: { id: string }[] };
    assert.deepEqual(reviewer.skills.map((s) => s.id), ['evidence-verification', 'independent-solution-assurance', 'requirements-traceability']);
    assert.equal(t.find('skill.loaded').length, 1);

    const report = readFileSync(t.orchestrator.reportPath(runId)!, 'utf8');
    for (const expected of [
      '# Research Ethics eForms Modernisation: assessment', 'Assurance verdict: **pass**', 'Evidence: ev-1, ev-2',
      '| ev-2 | hosting-costs.md | p9 |', 'One rework round was run for: architecture, costs. First verdict was conditional.',
      'reviewed on provider OpenAI, different from every authoring provider', '| minor | costs |',
      '| architecture-rework | solution-architecture | platform | claude-author |', 'plan approved by user:local',
    ]) assert.ok(report.includes(expected), `report is missing: ${expected}`);
    // Every id the report cites is in the evidence register.
    for (const id of report.match(/ev-\d+/g) ?? []) assert.ok(evidence.some((e) => e.id === id), id);
    if (process.env.SHOW_REPORT) (await import('node:fs')).writeFileSync(process.env.SHOW_REPORT, report);
    assert.equal(t.find('report.written').length, 1);
    assert.equal(t.ledger.verify().ok, true);
  });

  it('holds the run when assurance fails it, and only an approver with a reason can release the report', async () => {
    const t = await platform();
    const runId = await t.start('\nFAIL-VERDICT');
    const held = await t.orchestrator.execute(runId);
    assert.equal(held.status, 'held');
    assert.equal(statusOf(held, 'data-rework'), 'completed');
    assert.equal(statusOf(held, 'report'), undefined);
    assert.equal(existsSync(t.orchestrator.reportPath(runId)!), false);
    assert.equal(t.find('assurance.blocked').length, 1);

    // Asking again changes nothing, and neither an unknown user nor an empty reason opens the gate.
    assert.equal((await t.orchestrator.execute(runId)).status, 'held');
    assert.throws(() => t.orchestrator.overrideAssurance(runId, 'mallory', 'ship it'), (e: Error) => e instanceof GovernanceError && e.code === 'UNKNOWN_USER');
    assert.throws(() => t.orchestrator.overrideAssurance(runId, 'local', '  '), (e: Error) => e instanceof OrchestratorError && e.code === 'REASON_REQUIRED');
    assert.equal(t.find('agent.instantiated').filter((r) => (r.data as { task: string }).task === 'report').length, 0);

    // A new process picks the held run up from the state files, and the override is on the record and in the report.
    const later = await platform({ stateDir: t.stateDir });
    later.orchestrator.overrideAssurance(runId, 'local', 'Accepted for discussion only.');
    const released = await later.orchestrator.execute(runId);
    assert.equal(released.status, 'completed');
    const report = readFileSync(later.orchestrator.reportPath(runId)!, 'utf8');
    assert.match(report, /Assurance verdict: \*\*fail\*\* — overridden by local/);
    assert.match(report, /Reason given: Accepted for discussion only\./);
    assert.match(report, /\| critical \| data-rework \|/);
    assert.equal(later.find('assurance.overridden')[0]!.actor, 'user:local');
  });

  it('sends back a result that cites evidence nobody retrieved, and accepts the corrected one', async () => {
    const t = await platform();
    const summary = await t.orchestrator.execute(await t.start('\nBAD-CITATION'));
    assert.equal(summary.status, 'completed');
    assert.equal(summary.tasks.find((x) => x.id === 'security')!.attempts, 2);
    assert.equal((t.find('run.task_retried')[0]!.data as { reason: string }).reason, 'invalid_result');
  });

  it('records reduced independence when fallbacks put the reviewer on an author\'s provider', async () => {
    const t = await platform();
    const runId = await t.start('\nOUTAGE');
    const summary = await t.orchestrator.execute(runId);
    assert.equal(summary.status, 'completed');
    assert.deepEqual(summary.tasks.find((x) => x.id === 'assurance')!.tried, ['openai-assurance', 'deepseek-fallback']);
    assert.equal(summary.tasks.find((x) => x.id === 'data')!.model, 'deepseek-fallback');
    assert.ok(t.find('assurance.independence_reduced').length >= 1);
    assert.match(readFileSync(t.orchestrator.reportPath(runId)!, 'utf8'), /reviewed on provider DeepSeek, \*\*the same provider as at least one author; independence is reduced\*\*/);
  });

  it('stops starting tasks once the run budget is spent, and says which were not started', async () => {
    const t = await platform({ runBudget: { maxModelCalls: 12 } });
    const runId = await t.start();
    const summary = await t.orchestrator.execute(runId);
    assert.equal(summary.status, 'failed');
    // Evidence (7 calls) fits; the three parallel analyses start together and finish; nothing after them starts.
    assert.deepEqual(Object.fromEntries(summary.tasks.map((x) => [x.id, x.status])),
      { evidence: 'completed', architecture: 'completed', security: 'completed', data: 'completed', costs: 'blocked' });
    assert.match(summary.tasks.find((x) => x.id === 'costs')!.failure!, /run_budget_exceeded: model_calls/);
    const exceeded = t.find('budget.run_exceeded')[0]!.data as { notStarted: string[]; modelCalls: number };
    assert.deepEqual(exceeded.notStarted, ['costs']);
    assert.ok(exceeded.modelCalls >= 12);
    assert.equal(existsSync(t.orchestrator.reportPath(runId)!), false);

    // A cost limit with no prices set cannot be measured, so it stops the run after the first task.
    const unpriced = await platform({ runBudget: { maxCostUsd: 5 } });
    const stopped = await unpriced.orchestrator.execute(await unpriced.start());
    assert.equal((unpriced.find('budget.run_exceeded')[0]!.data as { limit: string }).limit, 'cost_unknown');
    assert.deepEqual(stopped.tasks.filter((x) => x.status === 'completed').map((x) => x.id), ['evidence']);
  });

  it('counts usage already in the ledger when a run is resumed, so a restart does not reset the run budget', async () => {
    const t = await platform({ runBudget: { maxModelCalls: 12 } });
    const runId = await t.start();
    await t.orchestrator.execute(runId);
    // Put the blocked task back to pending, as if the process had died before the check, and resume.
    t.store.setTaskStatus(runId, 'costs', 'pending');
    t.store.setRunStatus(runId, 'running');
    const resumed = await t.orchestrator.execute(runId);
    assert.equal(resumed.tasks.find((x) => x.id === 'costs')!.status, 'blocked');
    assert.equal(t.find('budget.run_exceeded').length, 2);
  });

  it('does not let a plan assign the reviewer or take the platform\'s stage ids', async () => {
    const t = await platform();
    const bad = (task: Json) => assert.throws(() => t.orchestrator.submitPlan({ user: 'local', objective: 'x', plan: { tasks: [task] } }), PlanError);
    bad({ id: 'check', agent: 'assurance', objective: 'Mark our own homework.' });
    bad({ id: 'report', agent: 'research', objective: 'x' });
    bad({ id: 'security-rework', agent: 'security', objective: 'x' });
    assert.equal(t.store.runs().length, 0);
  });
});
