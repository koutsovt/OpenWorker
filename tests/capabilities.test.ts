// Capability gaps: the planner reports what no approved agent covers, and the capability analyst
// sets a new body of work against the registry before it is planned. Both are checked in code.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import type { Json } from '../src/harness/port.ts';
import { checkAssessment, renderAssessment } from '../src/orchestrator/assessment.ts';
import { checkResult, parseAssessment, type CapabilityAssessment, type CapabilityNeed } from '../src/orchestrator/contracts.ts';
import { parsePlan, PLAN_LIMITS, validatePlan } from '../src/orchestrator/graph.ts';
import { Registry } from '../src/registry/registry.ts';
import { call, plan, platform, script, submit } from './support/scenario-platform.ts';

const registry = new Registry(resolve('registry'));
const exclude = ['orchestrator', 'assurance', 'capability-analyst'];

describe('plans: uncovered needs', () => {
  it('reads uncovered needs as objects or plain strings, and leaves them out when there are none', () => {
    assert.deepEqual(parsePlan({ ...plan, uncovered: [{ need: 'IR compliance', reason: 'no agent covers law' }, 'Privacy impact'] }).plan.uncovered,
      [{ need: 'IR compliance', reason: 'no agent covers law' }, { need: 'Privacy impact', reason: '' }]);
    assert.equal('uncovered' in parsePlan(plan).plan, false);
    assert.match(parsePlan({ ...plan, uncovered: 'everything' }).problems.join(), /uncovered must be a list/);
    assert.match(parsePlan({ ...plan, uncovered: [{ reason: 'x' }] }).problems.join(), /uncovered #1: need is required/);
  });

  it('limits how many there are and how long each is', () => {
    const many = parsePlan({ ...plan, uncovered: Array.from({ length: PLAN_LIMITS.maxUncovered + 1 }, (_, i) => `need ${i}`) }).plan;
    assert.match(validatePlan(many, registry, { exclude }).join(), /uncovered needs; the limit is 10/);
    const long = parsePlan({ ...plan, uncovered: ['x'.repeat(PLAN_LIMITS.maxUncoveredChars + 1)] }).plan;
    assert.match(validatePlan(long, registry, { exclude }).join(), /longer than 500 characters/);
  });

  it('never lets a plan assign work to the capability analyst, and keeps it out of the planner\'s catalogue', async () => {
    const parsed = parsePlan({ tasks: [{ id: 'gaps', agent: 'capability-analyst', objective: 'x', skills: [], dependsOn: [] }] });
    const t = await platform();
    assert.throws(() => t.orchestrator.submitPlan({ user: 'local', objective: 'x', plan: parsed.plan as unknown as Json }),
      /agent capability-analyst cannot be assigned work by a plan/);
    await t.start();
    const catalogue = t.inputs.find((i) => i.startsWith('Plan the work'))!;
    assert.doesNotMatch(catalogue, /"agent": "capability-analyst"/);
    assert.match(catalogue, /uncovered: parts of the objective that no agent and skill in the catalogue fits/);
  });

  it('records them, tells the report writer, and lists them in the report', async () => {
    const uncovered = [{ need: 'Industrial relations compliance of the process', reason: 'No approved agent assesses legal or EA obligations.' }];
    const t = await platform({
      script: (model, n, input) => !input.startsWith('Plan the work') ? script(model, n, input)
        : n === 0 ? submit({ ...plan, uncovered } as unknown as Record<string, Json>) : { text: 'Submitted.' },
    });
    const runId = await t.start();
    assert.deepEqual(t.orchestrator.uncovered(runId), uncovered);
    assert.deepEqual((t.find('plan.accepted').at(-1)!.data as Record<string, Json>).uncovered, ['Industrial relations compliance of the process']);
    const summary = await t.orchestrator.execute(runId);
    assert.equal(summary.status, 'completed');
    assert.match(t.store.tasks(runId).find((x) => x.id === 'report')!.objective, /left these parts of the objective uncovered[\s\S]*Industrial relations compliance/);
    const report = readFileSync(t.orchestrator.reportPath(runId)!, 'utf8');
    assert.match(report, /## Not assessed\n\nNo approved agent covers these, so the plan left them out:\n\n- Industrial relations compliance of the process\n/);
  });

  it('adds nothing to the report when the plan covers everything', async () => {
    const t = await platform();
    const runId = await t.start();
    await t.orchestrator.execute(runId);
    assert.doesNotMatch(readFileSync(t.orchestrator.reportPath(runId)!, 'utf8'), /Not assessed/);
  });
});

describe('capability assessment: registry checks', () => {
  const need = (over: Partial<CapabilityNeed>): CapabilityNeed => ({
    need: 'n', evidence: ['ev-1'], coverage: 'covered', coveredBy: [{ agent: 'security', skills: ['security-threat-modelling'] }], priority: 'high', ...over,
  });
  const check = (...needs: CapabilityNeed[]) => checkAssessment({ summary: 's', needs }, registry).join(' | ');

  it('accepts coverage by an approved agent with its own skills, and new ids that are new', () => {
    assert.equal(check(
      need({}),
      need({ coverage: 'partial', recommendation: { kind: 'new-skill', id: 'business-case-appraisal', agent: 'solution-architecture', detail: 'd' } }),
      need({ coverage: 'gap', coveredBy: [], recommendation: { kind: 'new-agent', id: 'compliance', detail: 'd' } }),
      need({ coverage: 'gap', coveredBy: [], recommendation: { kind: 'new-skill', id: 'privacy-impact-review', agent: 'compliance', detail: 'd' } }),
      need({ coverage: 'partial', recommendation: { kind: 'extend-agent', id: 'requirements-traceability', agent: 'security', detail: 'd' } }),
    ), '');
  });

  it('refuses coverage the registry does not support', () => {
    assert.match(check(need({ coveredBy: [{ agent: 'security', skills: ['requirements-traceability'] }] })), /requirements-traceability is not an approved skill eligible for security/);
    assert.match(check(need({ coveredBy: [{ agent: 'lawyer', skills: [] }] })), /lawyer is not an approved agent/);
    assert.match(check(need({ coverage: 'gap', recommendation: { kind: 'new-agent', id: 'compliance', detail: 'd' } })), /a gap names no covering agent/);
    assert.match(check(need({ coverage: 'partial' })), /a partial needs a recommendation/);
  });

  it('reads a blank or "none" recommendation as no recommendation', () => {
    const context = { evidenceIds: new Set(['ev-1']), taskIds: new Set<string>() };
    for (const recommendation of [{ kind: 'none', id: '', agent: '', detail: '' }, { kind: '', id: '', detail: '' }, null]) {
      const raw = { summary: 's', needs: [{ ...need({}), recommendation }] } as unknown as Json;
      assert.deepEqual(checkResult('capability-assessment', raw, context), [], JSON.stringify(recommendation));
      const parsed = parseAssessment(raw);
      assert.equal(parsed.needs[0]!.recommendation, undefined);
      assert.deepEqual(checkAssessment(parsed, registry), []);
    }
    // A real recommendation still needs its id and detail, and a blank agent is dropped.
    const half = { summary: 's', needs: [{ ...need({ coverage: 'partial' }), recommendation: { kind: 'new-skill', id: '', agent: '', detail: '' } }] } as unknown as Json;
    assert.match(checkResult('capability-assessment', half, context).join(), /recommendation\.id[\s\S]*recommendation\.detail/);
  });

  it('refuses a new agent with no skill recommended for it, and accepts an existing skill given to it', () => {
    const agent = need({ coverage: 'gap', coveredBy: [], recommendation: { kind: 'new-agent', id: 'compliance', detail: 'd' } });
    assert.match(check(agent), /new agent compliance has no skill/);
    assert.equal(check(agent, need({ coverage: 'gap', coveredBy: [], recommendation: { kind: 'extend-agent', id: 'requirements-traceability', agent: 'compliance', detail: 'd' } })), '');
  });

  it('refuses recommendations that are not new or do not fit', () => {
    assert.match(check(need({ coverage: 'partial', recommendation: { kind: 'new-skill', id: 'evidence-verification', detail: 'd' } })), /skill evidence-verification already exists/);
    assert.match(check(need({ coverage: 'gap', coveredBy: [], recommendation: { kind: 'new-agent', id: 'data', detail: 'd' } })), /agent data already exists/);
    assert.match(check(need({ coverage: 'partial', recommendation: { kind: 'extend-agent', id: 'integration-architecture', agent: 'data', detail: 'd' } })), /data is already eligible/);
    assert.match(check(need({ coverage: 'partial', recommendation: { kind: 'extend-agent', id: 'made-up', agent: 'security', detail: 'd' } })), /made-up is neither an existing skill/);
    assert.match(check(need({ coverage: 'partial', recommendation: { kind: 'new-skill', id: 'x-skill', agent: 'ghost', detail: 'd' } })), /ghost is neither an approved agent/);
  });
});

describe('gap report', () => {
  it('shows each change once, with one description, the needs it serves, and a warning when a skill is broad', () => {
    const need = (n: number): CapabilityNeed => ({
      need: `need ${n}`, evidence: ['ev-1'], coverage: 'partial', coveredBy: [{ agent: 'solution-architecture', skills: [] }], priority: n === 3 ? 'high' : 'medium',
      recommendation: { kind: 'new-skill', id: 'business-case-appraisal', agent: 'solution-architecture', detail: `description ${n}` },
    });
    const text = renderAssessment({ id: 'assess-1', user: 'local', scope: 'x', result: { summary: 's', needs: [1, 2, 3, 4].map(need) }, evidence: [] });
    assert.match(text, /\*\*business-case-appraisal, for solution-architecture\*\* \(high priority, serves 4 needs; broad: consider splitting\)\. description 3\n  - need 3\n  - need 1\n  - need 2\n  - need 4/);
    assert.doesNotMatch(text, /description 1/);
  });
});

describe('capability assessment, end to end', () => {
  const valid: CapabilityAssessment = {
    summary: 'Hosting is covered; residency compliance and cost comparability are not.',
    needs: [
      // What Claude Code sent for covered needs in the first real run: an empty "none" recommendation.
      { need: 'Hosting and data residency review', evidence: ['ev-1', 'ev-2'], coverage: 'covered', coveredBy: [{ agent: 'solution-architecture', skills: ['hosting-architecture-review'] }], priority: 'high',
        recommendation: { kind: 'none', id: '', agent: '', detail: '' } },
      { need: 'Comparable options appraisal', evidence: ['ev-2'], coverage: 'partial', coveredBy: [{ agent: 'solution-architecture', skills: ['solution-architecture-assessment'] }], priority: 'high',
        recommendation: { kind: 'new-skill', id: 'business-case-appraisal', agent: 'solution-architecture', detail: 'Check options are costed over equal periods.' } },
      { need: 'Legal compliance of data storage', evidence: ['ev-1'], coverage: 'gap', coveredBy: [], priority: 'medium',
        recommendation: { kind: 'new-agent', id: 'compliance', detail: 'Read-only agent tracing obligations to the design.' } },
      { need: 'Cost the options over equal periods', evidence: ['ev-2'], coverage: 'gap', coveredBy: [], priority: 'low',
        recommendation: { kind: 'new-skill', id: 'business-case-appraisal', agent: 'solution-architecture', detail: 'Same skill, second need.' } },
      { need: 'Trace storage obligations to their clauses', evidence: ['ev-1'], coverage: 'gap', coveredBy: [], priority: 'medium',
        recommendation: { kind: 'new-skill', id: 'obligation-traceability', agent: 'compliance', detail: 'Trace each obligation to the clause that imposes it.' } },
    ],
    classification: ['Contracts with the host may be confidential.'],
  };
  const analyst = (first: Json) => (model: string, n: number, input: string) => {
    if (!input.startsWith('Assess what the work')) return script(model, n, input);
    const steps = [
      call('knowledge.read', { document: 'requirements.md', anchor: 'p10' }),
      call('knowledge.read', { document: 'hosting-costs.md', anchor: 'p9' }),
      call('skills.load', { id: 'capability-gap-analysis' }),
      submit((input.includes('previous result was rejected') ? valid : first) as unknown as Record<string, Json>),
    ];
    return steps[n] ?? { text: 'Submitted.' };
  };

  it('sends back a result that claims coverage the registry does not support, then writes the gap report', async () => {
    const wrong = { ...valid, needs: [{ ...valid.needs[0]!, coveredBy: [{ agent: 'security', skills: ['hosting-architecture-review'] }] }] };
    const t = await platform({ script: analyst(wrong as unknown as Json) });
    const outcome = await t.assessor.assess({ user: 'local', scope: 'Assess the eForms modernisation.' });
    assert.equal(outcome.status, 'completed');
    assert.match(String((t.find('assessment.rejected')[0]!.data as Record<string, Json>).problems), /hosting-architecture-review is not an approved skill eligible for security/);
    assert.deepEqual((t.find('assessment.completed')[0]!.data as Record<string, Json>).recommended, ['new-skill:business-case-appraisal', 'new-agent:compliance', 'new-skill:obligation-traceability']);

    const report = readFileSync(outcome.reportPath!, 'utf8');
    assert.match(report, /5 needs: 1 covered, 1 partly covered, 3 not covered/);
    assert.match(report, /### New skills\n\n- \*\*business-case-appraisal, for solution-architecture\*\* \(high priority, serves 2 needs\)\. Check options are costed over equal periods\.\n  - Comparable options appraisal\n  - Cost the options over equal periods/);
    assert.match(report, /- \*\*obligation-traceability, for compliance\*\*/);
    assert.match(report, /### New agents\n\n- \*\*compliance\*\* \(medium priority, serves 1 need\)/);
    assert.match(report, /\| Hosting and data residency review \| covered \| solution-architecture \(hosting-architecture-review\) \| — \|/);
    assert.match(report, /## Data classification\n\n- Contracts with the host may be confidential\./);
    assert.match(report, /Nothing in this report is approved/);
    assert.match(report, /\| ev-1 \| requirements\.md \| p10 \|/);
    // The analyst read only, and nothing in the registry changed.
    assert.deepEqual(new Registry(resolve('registry')).problems(), []);
    assert.equal(t.toolResults.some((r) => r.tool === 'skills.propose'), false);
  });

  it('fails after a second bad result, citing evidence it never read', async () => {
    const t = await platform({
      script: (model, n, input) => input.startsWith('Assess what the work')
        ? [submit({ ...valid, needs: [{ ...valid.needs[0]!, evidence: ['ev-42'] }] } as unknown as Record<string, Json>)][n] ?? { text: 'Done.' }
        : script(model, n, input),
    });
    const outcome = await t.assessor.assess({ user: 'local', scope: 'x' });
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.problems.join(), /cites evidence that does not exist in this run: ev-42/);
    assert.equal(t.find('assessment.rejected').length, 2);
    assert.equal(t.find('assessment.failed').length, 1);
  });
});
