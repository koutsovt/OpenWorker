// Capability assessment: before a new kind of work, an analyst agent reads its documents and sets
// what the work needs against the approved agents and skills. The platform checks the result
// against the registry in code, then writes a gap report. Nothing here changes the registry: a
// recommended skill or agent exists only once a person writes it, reviews it and locks it.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuditLedger } from '../audit/ledger.ts';
import type { Budget } from '../governance/budget.ts';
import type { Json } from '../harness/port.ts';
import type { EvidenceRecord, EvidenceStore } from '../memory/state.ts';
import { RegistryError, type Registry } from '../registry/registry.ts';
import type { Workforce } from '../runtime/workforce.ts';
import type { ResultInbox } from '../tools/result.ts';
import { checkResult, CONTRACT_SHAPES, parseAssessment, type CapabilityAssessment, type CapabilityNeed } from './contracts.ts';

const RESULT_TOOL = 'result.submit';
const TASK = 'assessment';
const AGENT_ID = /^[a-z][a-z0-9-]{0,23}$/;
const SKILL_ID = /^[a-z][a-z0-9-]{0,47}$/;

export interface AssessmentOutcome {
  assessmentId: string;
  status: 'completed' | 'failed';
  result?: CapabilityAssessment;
  /** Why the last result was refused, or why the agent run failed. */
  problems: string[];
  reportPath?: string;
}

/** Registry checks on an assessment that already matches its contract. An empty list means it may be accepted. */
export function checkAssessment(result: CapabilityAssessment, registry: Registry): string[] {
  const problems: string[] = [];
  const proposed = (kind: string) =>
    new Set(result.needs.flatMap((n) => (n.recommendation?.kind === kind && n.recommendation.id ? [n.recommendation.id] : [])));
  const newSkills = proposed('new-skill');
  const newAgents = proposed('new-agent');
  const usable = (id: string) => {
    try { return registry.agent(id); } catch (e) { if (e instanceof RegistryError) return undefined; throw e; }
  };

  // A new agent is only usable with a method: each must have at least one skill recommended for it.
  for (const agent of newAgents) {
    const skilled = result.needs.some((n) => (n.recommendation?.kind === 'new-skill' || n.recommendation?.kind === 'extend-agent') && n.recommendation.agent === agent);
    if (!skilled) problems.push(`new agent ${agent} has no skill: recommend at least one new-skill (or extend-agent) with "agent": "${agent}", as its own entry`);
  }

  result.needs.forEach((need, i) => {
    const where = `needs.${i} (${need.need.slice(0, 60)})`;
    const coveredBy = need.coveredBy ?? [];
    const rec = need.recommendation;
    if (need.coverage === 'gap' && coveredBy.length) problems.push(`${where}: a gap names no covering agent; use "partial" if one covers part of it`);
    if (need.coverage !== 'gap' && !coveredBy.length) problems.push(`${where}: coverage "${need.coverage}" must name the agent and skills that cover it`);
    if (need.coverage !== 'covered' && (!rec || rec.kind === 'none')) problems.push(`${where}: a ${need.coverage} needs a recommendation other than "none"`);
    for (const c of coveredBy) {
      const agent = usable(c.agent);
      if (!agent) {
        problems.push(`${where}: ${c.agent} is not an approved agent`);
        continue;
      }
      for (const skill of c.skills) if (!registry.eligibleSkills(agent).some((s) => s.id === skill)) problems.push(`${where}: skill ${skill} is not an approved skill eligible for ${c.agent}`);
    }
    if (!rec || rec.kind === 'none') return;
    if (!rec.id) {
      problems.push(`${where}: recommendation ${rec.kind} needs an id`);
      return;
    }
    if (rec.kind === 'new-skill') {
      if (!SKILL_ID.test(rec.id)) problems.push(`${where}: new skill id ${rec.id} must be lower-case letters, digits and hyphens`);
      if (registry.knows('skill', rec.id)) problems.push(`${where}: skill ${rec.id} already exists; recommend extend-agent to give it to an agent, or choose a new id`);
      if (rec.agent && !usable(rec.agent) && !newAgents.has(rec.agent)) problems.push(`${where}: ${rec.agent} is neither an approved agent nor a new agent recommended here`);
    } else if (rec.kind === 'new-agent') {
      if (!AGENT_ID.test(rec.id)) problems.push(`${where}: new agent id ${rec.id} must be lower-case letters, digits and hyphens, at most 24 characters`);
      if (registry.knows('agent', rec.id)) problems.push(`${where}: agent ${rec.id} already exists; recommend extend-agent instead, or choose a new id`);
    } else {
      const agent = rec.agent ? usable(rec.agent) : undefined;
      if (!agent && !(rec.agent && newAgents.has(rec.agent))) problems.push(`${where}: extend-agent must name an approved agent, or a new agent recommended here, in "agent"`);
      else if (agent?.eligibleSkills.includes(rec.id)) problems.push(`${where}: ${rec.agent} is already eligible for ${rec.id}`);
      if (!newSkills.has(rec.id) && !registry.knows('skill', rec.id)) problems.push(`${where}: ${rec.id} is neither an existing skill nor a new skill recommended here`);
    }
  });
  return problems;
}

export class CapabilityAssessor {
  private readonly deps: { workforce: Workforce; registry: Registry; ledger: AuditLedger; evidence: EvidenceStore; results: ResultInbox };
  private readonly options: { agent: string; reportsDir: string | undefined; maxAttempts: number; budget: Budget };

  constructor(
    deps: CapabilityAssessor['deps'],
    options: { agent?: string; reportsDir?: string; maxAttempts?: number; budget?: Budget } = {},
  ) {
    this.deps = deps;
    this.options = { agent: options.agent ?? 'capability-analyst', reportsDir: options.reportsDir, maxAttempts: Math.max(1, options.maxAttempts ?? 2), budget: options.budget ?? {} };
  }

  /** Runs the analyst over the knowledge documents for `scope`, checks its result and writes the gap report. */
  async assess(request: { user: string; scope: string; budget?: Budget }): Promise<AssessmentOutcome> {
    const { workforce, registry, ledger, evidence, results } = this.deps;
    const assessmentId = `assess-${randomUUID().slice(0, 8)}`;
    const actor = `user:${request.user}`;
    const agent = registry.agent(this.options.agent);
    ledger.append('assessment.started', actor, { run: assessmentId, agent: `${agent.id}@${agent.version}` });
    const skills = registry.eligibleSkills(agent).map((s) => s.id);
    let problems: string[] = [];
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt++) {
      const outcome = await workforce.runAgent({
        agentId: agent.id, user: request.user, skills, budget: request.budget ?? this.options.budget,
        input: this.brief(request.scope, problems), run: { runId: assessmentId, taskId: TASK },
      });
      const submitted = results.take(outcome.instance);
      if (outcome.status !== 'completed') {
        problems = [`analyst run ${outcome.status}${outcome.failure ? `: ${outcome.failure}` : ''}`];
        break;
      }
      problems = submitted === undefined ? [`no result was submitted; call ${RESULT_TOOL}`]
        : checkResult('capability-assessment', submitted, { evidenceIds: new Set(evidence.list(assessmentId).map((e) => e.id)), taskIds: new Set() });
      const parsed = problems.length ? undefined : parseAssessment(submitted!);
      if (parsed) problems = checkAssessment(parsed, registry);
      if (parsed && !problems.length) {
        const result = parsed;
        const reportPath = this.write(assessmentId, request, result, evidence.list(assessmentId));
        ledger.append('assessment.completed', actor, {
          run: assessmentId, instance: outcome.instance, attempt,
          needs: result.needs.length, gaps: result.needs.filter((n) => n.coverage === 'gap').length, partial: result.needs.filter((n) => n.coverage === 'partial').length,
          recommended: [...new Set(result.needs.flatMap((n) => (n.recommendation && n.recommendation.kind !== 'none' ? [`${n.recommendation.kind}:${n.recommendation.id}`] : [])))],
          resultDigest: createHash('sha256').update(JSON.stringify(result)).digest('hex').slice(0, 16),
        });
        return { assessmentId, status: 'completed', result, problems: [], ...(reportPath ? { reportPath } : {}) };
      }
      ledger.append('assessment.rejected', 'system', { run: assessmentId, instance: outcome.instance, attempt, problems: problems.slice(0, 12) });
    }
    ledger.append('assessment.failed', actor, { run: assessmentId, problems: problems.slice(0, 12) });
    return { assessmentId, status: 'failed', problems };
  }

  private write(id: string, request: { user: string; scope: string }, result: CapabilityAssessment, evidence: EvidenceRecord[]): string | undefined {
    if (!this.options.reportsDir) return undefined;
    const text = renderAssessment({ id, user: request.user, scope: request.scope, result, evidence });
    mkdirSync(this.options.reportsDir, { recursive: true });
    const path = join(this.options.reportsDir, `${id}.md`);
    writeFileSync(path, text);
    this.deps.ledger.append('report.written', 'system', { run: id, digest: createHash('sha256').update(text).digest('hex') });
    return path;
  }

  /** The catalogue the analyst measures against: every approved agent, the skills each may use, and the tools. */
  private catalogue(): Json {
    const { registry } = this.deps;
    const agents = registry.usableAgents();
    return {
      agents: agents.map((a) => ({
        agent: a.id, purpose: a.purpose, outputContract: a.outputContract ?? null, dataClassificationCeiling: a.dataClassificationCeiling,
        tools: a.allowedTools, skills: registry.eligibleSkills(a).map((s) => s.id),
      })),
      skills: [...new Set(agents.flatMap((a) => registry.eligibleSkills(a)))].map((s) => ({
        id: s.id, purpose: s.purpose, scope: s.scope, outputs: s.outputs, eligibleFor: agents.filter((a) => a.eligibleSkills.includes(s.id)).map((a) => a.id),
      })),
      tools: [...registry.tools.values()].map((t) => ({ name: t.name, description: t.description, action: t.action, dataClassification: t.dataClassification })),
      platform: 'The orchestrator plans and writes the report; assurance reviews every run; neither takes planned work. No agent holds a role, approves anything or writes to the registry.',
    } as unknown as Json;
  }

  private brief(scope: string, problems: string[]): string {
    return [
      'Assess what the work described below needs, against the approved agents and skills in the catalogue. Do not do the work itself.',
      'Read the knowledge documents for the work: search, then read the passages with knowledge.read. Only a passage you have read gives you an evidence id, and every need must cite at least one.',
      'List the distinct capabilities the work needs (kinds of analysis, design or checking), not its individual requirements. For each, say whether an approved agent with one of its eligible skills covers it fully (covered), in part (partial), or not at all (gap), and name that agent and those skills.',
      'For every partial or gap, recommend the smallest change: a new skill for an existing agent (new-skill, with "agent"), an existing skill given to another agent (extend-agent), or a new agent (new-agent) only when no existing agent\'s purpose fits. Say in "detail" what the skill or agent must do, and for a new agent which read tools it needs. Omit "recommendation" for a covered need.',
      'A new agent needs a method: also recommend each of its skills as its own need entry with kind new-skill and "agent" set to the new agent\'s id. Keep each skill to one coherent method; if one skill would serve more than three needs, split it.',
      'In "classification", list any document or kind of data the work needs that is likely above the agents\' data classification ceilings or the tools\' classification.',
      `Hand back your result by calling ${RESULT_TOOL} with {"result": {...}}. The result must have this shape: ${CONTRACT_SHAPES['capability-assessment']}`,
      'The platform checks every agent, skill and id you name against the registry. A person reviews your recommendations; nothing you recommend exists until they approve it.',
      '',
      `Catalogue:\n${JSON.stringify(this.catalogue(), null, 2)}`,
      ...(problems.length ? ['', `Your previous result was rejected by the platform for these reasons. Fix them and submit again:\n- ${problems.join('\n- ')}`] : []),
      '',
      `<work>\n${scope}\n</work>`,
    ].join('\n');
  }
}

const cell = (value: unknown): string => String(value ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const table = (head: string[], rows: unknown[][]): string =>
  [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
const PRIORITY = { high: 0, medium: 1, low: 2 } as const;

/** The gap report. Coverage and recommendations come from the checked result; the evidence register from the store. */
export function renderAssessment(input: {
  id: string; user: string; scope: string; result: CapabilityAssessment; evidence: EvidenceRecord[];
}): string {
  const { id, user, scope, result, evidence } = input;
  const needs = [...result.needs].sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority]);
  const count = (c: CapabilityNeed['coverage']) => needs.filter((n) => n.coverage === c).length;
  const by = (n: CapabilityNeed) => (n.coveredBy ?? []).map((c) => `${c.agent}${c.skills.length ? ` (${c.skills.join(', ')})` : ''}`).join('; ') || '—';

  // One entry per recommended change, with every need it would serve. Needs are in priority order, so the
  // description shown is the one written for the most important need; the others are usually restatements.
  const changes = new Map<string, { kind: string; id: string; agent?: string; detail: string; needs: string[]; priority: CapabilityNeed['priority'] }>();
  for (const n of needs) {
    const rec = n.recommendation;
    if (!rec || rec.kind === 'none' || !rec.id) continue;
    const key = `${rec.kind}:${rec.id}:${rec.agent ?? ''}`;
    const entry = changes.get(key) ?? { kind: rec.kind, id: rec.id, ...(rec.agent ? { agent: rec.agent } : {}), detail: rec.detail ?? '', needs: [], priority: n.priority };
    entry.needs.push(n.need);
    if (PRIORITY[n.priority] < PRIORITY[entry.priority]) entry.priority = n.priority;
    changes.set(key, entry);
  }
  const section = (kind: string, heading: string, label: (c: { id: string; agent?: string }) => string) => {
    const list = [...changes.values()].filter((c) => c.kind === kind).sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority]);
    return list.length ? ['', `### ${heading}`, '', ...list.flatMap((c) => [
      `- **${label(c)}** (${c.priority} priority, serves ${c.needs.length} ${c.needs.length === 1 ? 'need' : 'needs'}${c.kind === 'new-skill' && c.needs.length > 3 ? '; broad: consider splitting' : ''}). ${c.detail}`,
      ...c.needs.map((n) => `  - ${n}`),
    ])] : [];
  };

  return [
    `# Capability assessment \`${id}\``,
    '',
    `Requested by ${user}. ${needs.length} needs: ${count('covered')} covered, ${count('partial')} partly covered, ${count('gap')} not covered.`,
    '',
    `> ${scope.trim().slice(0, 1500).replace(/\n/g, '\n> ')}`,
    '',
    '## Summary', '', result.summary,
    '', '## Coverage', '',
    table(['Need', 'Coverage', 'Covered by', 'Change', 'Priority', 'Evidence'], needs.map((n) => [n.need, n.coverage, by(n), n.recommendation?.id ?? '—', n.priority, n.evidence.join(', ')])),
    '', '## Recommended changes',
    ...(changes.size ? [
      ...section('new-skill', 'New skills', (c) => `${c.id}${c.agent ? `, for ${c.agent}` : ''}`),
      ...section('extend-agent', 'Existing skills for more agents', (c) => `${c.id} → ${c.agent ?? '?'}`),
      ...section('new-agent', 'New agents', (c) => c.id),
    ] : ['', '_None: the approved agents and skills cover every need found._']),
    ...(result.classification?.length ? ['', '## Data classification', '', ...result.classification.map((c) => `- ${c}`)] : []),
    '', '## Next steps', '',
    'Nothing in this report is approved, and nothing here changes the registry. For each change you accept:',
    '',
    '1. Write it: `registry/skills/<id>/1.0.0/skill.yaml` and `SKILL.md`, or `registry/agents/<id>/1.yaml`. To give an agent another skill, add it to that agent\'s `eligibleSkills` in a new version of the agent.',
    '2. Have its owner review the method, then set `status: approved` and run `npm run registry -- lock`.',
    '3. Review the lock change. Approved agents appear in the planner\'s catalogue at once.',
    '', '## Evidence register', '',
    evidence.length
      ? table(['Id', 'Document', 'Passage', 'Content hash'], evidence.map((e) => [e.id, e.document, e.anchor, e.contentHash.slice(0, 12)]))
      : '_No evidence was retrieved._',
    '',
  ].join('\n');
}
