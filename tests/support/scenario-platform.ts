// The proof-of-concept scenario wired on the real registry, real model policies and a real
// knowledge folder, with a scripted model in place of the providers. Tests choose the engine,
// the script and the documents; everything the platform decides is real.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AuditLedger } from '../../src/audit/ledger.ts';
import { loadConfig } from '../../src/config/load.ts';
import { ModelGateway } from '../../src/gateway/gateway.ts';
import { Governance } from '../../src/governance/policy.ts';
import { FakeHarness, type FakeStep } from '../../src/harness/fake.ts';
import type { AgentHarness, Json, ProviderSpec } from '../../src/harness/port.ts';
import { KnowledgeBase } from '../../src/memory/knowledge.ts';
import { EvidenceStore, openState, ProjectMemory } from '../../src/memory/state.ts';
import { CapabilityAssessor } from '../../src/orchestrator/assessment.ts';
import { Orchestrator } from '../../src/orchestrator/orchestrator.ts';
import { RunStore } from '../../src/orchestrator/store.ts';
import { Registry } from '../../src/registry/registry.ts';
import { Workforce } from '../../src/runtime/workforce.ts';
import { knowledgeTools } from '../../src/tools/knowledge.ts';
import { ResultInbox } from '../../src/tools/result.ts';
import { skillTools } from '../../src/tools/skills.ts';

export const scenarioDir = resolve('scenarios/research-ethics-eforms');
export const objective = readFileSync(join(scenarioDir, 'objective.md'), 'utf8').trim();

export const call = (tool: string, args: Record<string, Json> = {}): FakeStep => ({ tool, args });
export const submit = (result: Record<string, Json>): FakeStep => call('result.submit', { result });
export const claims = (...items: [string, string[]][]): Json => items.map(([statement, evidence]) => ({ statement, evidence }));

export const plan = {
  tasks: [
    { id: 'evidence', agent: 'research', skills: ['evidence-verification'], dependsOn: [], objective: 'Establish what the documents say about the current system, PRIME, requirements and costs.' },
    { id: 'architecture', agent: 'solution-architecture', skills: ['solution-architecture-assessment', 'hosting-architecture-review'], dependsOn: ['evidence'], objective: 'Propose the target architecture and hosting.' },
    { id: 'security', agent: 'security', skills: ['security-threat-modelling'], dependsOn: ['evidence'], objective: 'Produce the threat model and controls.' },
    { id: 'data', agent: 'data', skills: ['integration-architecture'], dependsOn: ['evidence'], objective: 'Design the data model, migration and PRIME integration.' },
    { id: 'costs', agent: 'solution-architecture', skills: ['hosting-architecture-review'], dependsOn: ['architecture'], objective: 'Estimate costs with assumptions.' },
  ],
};

/** The scripted model. Words in the objective switch on the faults a test needs. */
export type Script = (model: string, toolResults: number, input: string) => FakeStep;

export function script(model: string, n: number, input: string): FakeStep {
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
      case 'costs-rework': return [analysis('Indicative costs, with the hosting question open.', ['Costs assume the Railway sizing, which residency may rule out.', ['ev-2']])];
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

export interface PlatformOptions {
  stateDir?: string;
  knowledgeDir?: string;
  /** The engine under test. Defaults to the fake harness running `script`. */
  harness?: AgentHarness;
  script?: Script;
  /** Rewrites the configured providers, for engines that reach them differently. Names must stay the same. */
  provider?: (p: ProviderSpec) => ProviderSpec;
  runBudget?: { maxModelCalls?: number; maxTokens?: number; maxCostUsd?: number };
}

export async function platform(options: PlatformOptions = {}) {
  const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), 'scenario-'));
  const config = loadConfig(resolve('config'));
  const inputs: string[] = [];
  const toolResults: { tool: string; args: Json; result: Json }[] = [];
  const run = options.script ?? script;
  const ledger = new AuditLedger(join(stateDir, 'audit.sqlite'));
  const state = openState(join(stateDir, 'state.sqlite'));
  const [evidence, project, store, results] = [new EvidenceStore(state), new ProjectMemory(state), new RunStore(state), new ResultInbox()];
  const registry = new Registry(resolve('registry'));
  const governance = Governance.load(resolve('config/users.yaml'), resolve('config/policies.yaml'));
  const gateway = new ModelGateway(config, ledger, { CLAUDE_AUTHOR_MODEL: 'm-claude', OPENAI_ASSURANCE_MODEL: 'm-openai', DEEPSEEK_FALLBACK_MODEL: 'm-deepseek' });
  const workforce = new Workforce({
    harness: options.harness ?? new FakeHarness((model, n, input) => { inputs.push(input); return run(model, n, input); }),
    ledger, gateway, registry, governance,
    implementations: Object.fromEntries(Object.entries({
      ...skillTools(ledger, join(stateDir, 'proposals')),
      ...knowledgeTools(new KnowledgeBase(options.knowledgeDir ?? join(scenarioDir, 'knowledge')), evidence, project, ledger), ...results.tools,
    }).map(([name, tool]) => [name, async (args, instance) => {
      const result = await tool(args, instance);
      toolResults.push({ tool: name, args, result });
      return result;
    }])),
  });
  await workforce.start(config.providers.map(options.provider ?? ((p) => p)));
  const orchestrator = new Orchestrator(
    { workforce, registry, governance, ledger, store, project, evidence, results, providerOf: (alias) => gateway.providerOf(alias) },
    { reportsDir: join(stateDir, 'reports'), ...(options.runBudget ? { runBudget: options.runBudget } : {}) },
  );
  const assessor = new CapabilityAssessor({ workforce, registry, ledger, evidence, results }, { reportsDir: join(stateDir, 'reports') });
  const find = (type: string) => ledger.records().filter((r) => r.type === type);
  const start = async (extra = '') => {
    const { runId } = await orchestrator.plan({ user: 'local', objective: `${objective}${extra}` });
    orchestrator.approvePlan(runId, 'local', 'approve');
    return runId;
  };
  return { orchestrator, assessor, project, ledger, store, evidence, registry, find, start, stateDir, inputs, toolResults };
}
