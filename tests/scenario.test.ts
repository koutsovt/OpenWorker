// Milestone 4 end to end: the real registry, the real model policies and the real scenario
// knowledge pack, with a scripted model in place of the providers. Everything the platform
// decides (plan checks, contracts, citations, assurance gate, rework, report) is real.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { AuditLedger } from '../src/audit/ledger.ts';
import { loadConfig } from '../src/config/load.ts';
import { ModelGateway } from '../src/gateway/gateway.ts';
import { Governance } from '../src/governance/policy.ts';
import { FakeHarness, type FakeStep } from '../src/harness/fake.ts';
import type { Json } from '../src/harness/port.ts';
import { KnowledgeBase } from '../src/memory/knowledge.ts';
import { EvidenceStore, openState, ProjectMemory } from '../src/memory/state.ts';
import { checkResult, citedEvidence } from '../src/orchestrator/contracts.ts';
import { PlanError } from '../src/orchestrator/graph.ts';
import { Orchestrator, OrchestratorError } from '../src/orchestrator/orchestrator.ts';
import { RunStore } from '../src/orchestrator/store.ts';
import { Registry } from '../src/registry/registry.ts';
import { GovernanceError, Workforce } from '../src/runtime/workforce.ts';
import { knowledgeTools } from '../src/tools/knowledge.ts';
import { ResultInbox } from '../src/tools/result.ts';
import { skillTools } from '../src/tools/skills.ts';

const scenarioDir = resolve('scenarios/research-ethics-eforms');
const objective = readFileSync(join(scenarioDir, 'objective.md'), 'utf8').trim();

const call = (tool: string, args: Record<string, Json> = {}): FakeStep => ({ tool, args });
const submit = (result: Record<string, Json>): FakeStep => call('result.submit', { result });
const claims = (...items: [string, string[]][]): Json => items.map(([statement, evidence]) => ({ statement, evidence }));

const plan = {
  tasks: [
    { id: 'evidence', agent: 'research', skills: ['evidence-verification'], dependsOn: [], objective: 'Establish what the documents say about the current system, PRIME, requirements and costs.' },
    { id: 'architecture', agent: 'solution-architecture', skills: ['solution-architecture-assessment', 'hosting-architecture-review'], dependsOn: ['evidence'], objective: 'Propose the target architecture and hosting.' },
    { id: 'security', agent: 'security', skills: ['security-threat-modelling'], dependsOn: ['evidence'], objective: 'Produce the threat model and controls.' },
    { id: 'data', agent: 'data', skills: ['integration-architecture'], dependsOn: ['evidence'], objective: 'Design the data model, migration and PRIME integration.' },
    { id: 'costs', agent: 'solution-architecture', skills: ['hosting-architecture-review'], dependsOn: ['architecture'], objective: 'Estimate costs with assumptions.' },
  ],
};

/** The scripted model. Words in the objective switch on the faults a test needs. */
function script(model: string, n: number, input: string): FakeStep {
  const steps = ((): FakeStep[] => {
    if (input.startsWith('Plan the work')) return [submit(plan as unknown as Record<string, Json>)];
    const id = /<your-task id="([^"]+)">/.exec(input)?.[1] ?? '';
    const has = (word: string) => input.includes(word);
    const analysis = (summary: string, ...items: [string, string[]][]) => submit({ summary, claims: claims(...items), assumptions: ['Volumes stay at current levels.'] });
    if (has('OUTAGE') && (model === 'm-openai' || (model === 'm-claude' && id === 'data'))) return [{ error: 'rate_limit' }];
    switch (id) {
      case 'evidence': return [
        call('knowledge.search', { query: 'data stored in Australia region' }),
        call('knowledge.read', { document: 'requirements.md', anchor: 'p10' }),
        call('knowledge.read', { document: 'hosting-costs.md', anchor: 'p9' }),
        call('knowledge.read', { document: 'prime-integration.md', anchor: 'p3' }),
        call('skills.load', { id: 'evidence-verification' }),
        submit({ summary: 'Residency is required; the host has no Australian region; PRIME is fed by a nightly batch.', claims: claims(
          ['Data must be stored in Australia.', ['ev-1']], ['The managed host offers no Australian region.', ['ev-2']], ['Approvals reach PRIME by a nightly batch.', ['ev-3']],
        ), gaps: ['No reconciliation figures exist.'] }),
      ];
      // The seeded defect: the cited passage says the opposite.
      case 'architecture': return [analysis('Laravel and PostgreSQL on Railway.', ['Hosting on Railway satisfies the data residency requirement.', ['ev-2']], ['Keep the nightly batch to PRIME.', ['ev-3']])];
      case 'architecture-rework': return [analysis('Laravel and PostgreSQL; Railway only if residency is waived.', ['Railway as described has no Australian region, so residency is unmet there.', ['ev-1', 'ev-2']], ['Keep the nightly batch to PRIME.', ['ev-3']])];
      case 'security': return [analysis('Threat model.', ['Confidential data crosses to PRIME nightly.', [has('BAD-CITATION') && !has('previous attempt was rejected') ? 'ev-99' : 'ev-3']], ['Encrypt backups.', []])];
      case 'data': return [analysis('Data model and migration.', ['PRIME project id is the matching key.', ['ev-3']])];
      case 'data-rework': return [analysis('Data model and migration, revised.', ['PRIME project id is the matching key.', ['ev-3']])];
      case 'costs': return [analysis('Indicative costs.', ['Costs assume the Railway sizing.', []])];
      case 'assurance': return [
        call('evidence.get', { id: 'ev-2' }),
        has('FAIL-VERDICT')
          ? submit({ verdict: 'fail', summary: 'The migration approach cannot be relied on.', findings: [{ task: 'data', severity: 'critical', issue: 'No verification of migrated records.', resolution: 'Define reconciliation.' }] })
          : submit({ verdict: 'conditional', summary: 'One claim is contradicted by its evidence.', findings: [
            { task: 'architecture', severity: 'major', issue: 'ev-2 says the host has no Australian region; the claim says residency is satisfied.', resolution: 'Correct the claim and the hosting decision.' },
            { task: 'costs', severity: 'minor', issue: 'Cost claim cites no evidence.', resolution: 'Cite the price assumptions.' },
          ] }),
      ];
      case 'assurance-2': return [has('FAIL-VERDICT')
        ? submit({ verdict: 'fail', summary: 'Still no verification of migrated records.', findings: [{ task: 'data-rework', severity: 'critical', issue: 'Unchanged.', resolution: 'Define reconciliation.' }] })
        : submit({ verdict: 'pass', summary: 'The contradicted claim was corrected.', findings: [{ task: 'costs', severity: 'minor', issue: 'Cost claim cites no evidence.', resolution: 'Cite the price assumptions.' }] })];
      case 'report': return [submit({
        title: 'Research Ethics eForms Modernisation: assessment', summary: 'Laravel and PostgreSQL are viable; hosting location is unresolved.',
        sections: [
          { heading: 'Target architecture', body: 'Residency is unmet on the managed host as described.', evidence: ['ev-1', 'ev-2'] },
          { heading: 'PRIME integration', body: 'Keep the nightly batch in the first release.', evidence: ['ev-3'] },
        ],
        recommendations: ['Resolve data residency before choosing the host.'], openQuestions: ['How many approvals are missing from PRIME?'],
      })];
      default: return [];
    }
  })();
  return steps[n] ?? { text: 'Submitted.' };
}

async function platform(stateDir = mkdtempSync(join(tmpdir(), 'scenario-'))) {
  const config = loadConfig(resolve('config'));
  const ledger = new AuditLedger(join(stateDir, 'audit.sqlite'));
  const state = openState(join(stateDir, 'state.sqlite'));
  const [evidence, project, store, results] = [new EvidenceStore(state), new ProjectMemory(state), new RunStore(state), new ResultInbox()];
  const registry = new Registry(resolve('registry'));
  const governance = Governance.load(resolve('config/users.yaml'), resolve('config/policies.yaml'));
  const gateway = new ModelGateway(config, ledger, { CLAUDE_AUTHOR_MODEL: 'm-claude', OPENAI_ASSURANCE_MODEL: 'm-openai', DEEPSEEK_FALLBACK_MODEL: 'm-deepseek' });
  const workforce = new Workforce({
    harness: new FakeHarness(script), ledger, gateway, registry, governance,
    implementations: {
      ...skillTools(ledger, join(stateDir, 'proposals')),
      ...knowledgeTools(new KnowledgeBase(join(scenarioDir, 'knowledge')), evidence, project, ledger), ...results.tools,
    },
  });
  await workforce.start(config.providers);
  const orchestrator = new Orchestrator(
    { workforce, registry, governance, ledger, store, project, evidence, results, providerOf: (alias) => gateway.providerOf(alias) },
    { reportsDir: join(stateDir, 'reports') },
  );
  const find = (type: string) => ledger.records().filter((r) => r.type === type);
  const start = async (extra = '') => {
    const { runId } = await orchestrator.plan({ user: 'local', objective: `${objective}${extra}` });
    orchestrator.approvePlan(runId, 'local', 'approve');
    return runId;
  };
  return { orchestrator, ledger, store, evidence, registry, find, start, stateDir };
}
const statusOf = (summary: { tasks: { id: string; status: string }[] }, id: string) => summary.tasks.find((t) => t.id === id)?.status;

describe('registry content', () => {
  const registry = new Registry(resolve('registry'));

  it('has the six approved agents, each matching the lock', () => {
    assert.deepEqual(registry.usableAgents().map((a) => `${a.id}@${a.version}`),
      ['assurance@2', 'data@1', 'orchestrator@2', 'research@1', 'security@1', 'solution-architecture@1']);
    assert.deepEqual(registry.problems(), []);
  });

  it('has the seven skills, each eligible for at least one agent, and resolves dependencies first', () => {
    const eligible = new Set(registry.usableAgents().flatMap((a) => registry.eligibleSkills(a).map((s) => s.id)));
    assert.deepEqual([...eligible].sort(), ['evidence-verification', 'hosting-architecture-review', 'independent-solution-assurance',
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
      ['evidence', 'architecture', 'security', 'data', 'costs', 'assurance', 'architecture-rework', 'assurance-2', 'report']);
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

    // Only the task with a major finding was reworked, once; the reviewer was given its assigned skills.
    assert.deepEqual((t.find('assurance.rework_requested')[0]!.data as { tasks: string[] }).tasks, ['architecture']);
    const reviewer = t.find('agent.instantiated').find((r) => (r.data as { task: string }).task === 'assurance')!.data as { skills: { id: string }[] };
    assert.deepEqual(reviewer.skills.map((s) => s.id), ['evidence-verification', 'independent-solution-assurance', 'requirements-traceability']);
    assert.equal(t.find('skill.loaded').length, 1);

    const report = readFileSync(t.orchestrator.reportPath(runId)!, 'utf8');
    for (const expected of [
      '# Research Ethics eForms Modernisation: assessment', 'Assurance verdict: **pass**', 'Evidence: ev-1, ev-2',
      '| ev-2 | hosting-costs.md | p9 |', 'One rework round was run for: architecture. First verdict was conditional.',
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
    const later = await platform(t.stateDir);
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

  it('does not let a plan assign the reviewer or take the platform\'s stage ids', async () => {
    const t = await platform();
    const bad = (task: Json) => assert.throws(() => t.orchestrator.submitPlan({ user: 'local', objective: 'x', plan: { tasks: [task] } }), PlanError);
    bad({ id: 'check', agent: 'assurance', objective: 'Mark our own homework.' });
    bad({ id: 'report', agent: 'research', objective: 'x' });
    bad({ id: 'security-rework', agent: 'security', objective: 'x' });
    assert.equal(t.store.runs().length, 0);
  });
});
