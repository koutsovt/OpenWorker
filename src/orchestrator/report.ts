// Renders the final report. The narrative comes from the report task's validated result;
// everything under "Traceability" is generated here from the run store, the evidence
// store and the audit ledger, so it does not depend on what any model chose to say.
import type { AuditRecord } from '../audit/ledger.ts';
import type { Json } from '../harness/port.ts';
import type { EvidenceRecord, MemoryEntry } from '../memory/state.ts';
import { citedEvidence, type AssuranceResult, type ReportResult } from './contracts.ts';
import { isStageTask, STAGE, type UncoveredNeed } from './graph.ts';
import type { RunRecord, TaskRecord } from './store.ts';

export interface ReportInput {
  run: RunRecord;
  tasks: TaskRecord[];
  evidence: EvidenceRecord[];
  decisions: MemoryEntry[];
  ledger: AuditRecord[];
  providerOf: (alias: string) => string | undefined;
}

const cell = (value: unknown): string => String(value ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const table = (head: string[], rows: unknown[][]): string =>
  [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
const data = (r: AuditRecord) => (r.data ?? {}) as Record<string, Json>;

export function renderReport(input: ReportInput): string {
  const { run, tasks, evidence, decisions, ledger } = input;
  const by = new Map(tasks.map((t) => [t.id, t]));
  const report = by.get(STAGE.report)!.result as unknown as ReportResult;
  const finalAssurance = by.get(STAGE.reassurance) ?? by.get(STAGE.assurance)!;
  const verdict = finalAssurance.result as unknown as AssuranceResult;
  const firstVerdict = by.get(STAGE.assurance)!.result as unknown as AssuranceResult;
  const override = decisions.find((d) => d.key === 'assurance-override')?.content as { approver: string; reason: string } | undefined;
  const independence = decisions.filter((d) => d.key.startsWith('verdict:')).map((d) => d.content as { task: string; provider: string | null; independent: boolean });
  const uncovered = (decisions.find((d) => d.key === 'uncovered')?.content ?? []) as unknown as UncoveredNeed[];
  const reworked = tasks.filter((t) => t.id.endsWith('-rework')).map((t) => t.id.replace(/-rework$/, ''));

  // Which agent instances belonged to this run, and what each used.
  const instances = new Map<string, string>();
  for (const r of ledger) if (r.type === 'agent.instantiated' && data(r).run === run.id) instances.set(String(data(r).instance), String(data(r).task));
  const usage = new Map<string, { input: number; output: number; cost: number; unknown: boolean }>();
  for (const r of ledger) {
    const task = r.type === 'model.usage' ? instances.get(String(data(r).instance)) : undefined;
    if (!task) continue;
    const u = usage.get(task) ?? { input: 0, output: 0, cost: 0, unknown: false };
    u.input += Number(data(r).inputTokens);
    u.output += Number(data(r).outputTokens);
    if (typeof data(r).costUsd === 'number') u.cost += data(r).costUsd as number;
    else u.unknown = true;
    usage.set(task, u);
  }
  const citedBy = new Map<string, string[]>();
  for (const t of tasks) for (const id of citedEvidence(t.result ?? undefined)) citedBy.set(id, [...(citedBy.get(id) ?? []), t.id]);

  const approvals = ledger.flatMap((r): string[] => {
    const d = data(r);
    if (r.type === 'plan.approved' && d.run === run.id) return [`${r.at} — plan approved by ${r.actor}`];
    if ((r.type === 'approval.granted' || r.type === 'approval.denied') && instances.has(String(d.instance)))
      return [`${r.at} — ${r.actor} ${r.type === 'approval.granted' ? 'approved' : 'denied'} ${String(d.tool)} for task ${instances.get(String(d.instance))}`];
    if (r.type === 'assurance.overridden' && d.run === run.id) return [`${r.at} — assurance verdict overridden by ${r.actor}: ${String(d.reason)}`];
    return [];
  });
  const injections = ledger.filter((r) => r.type === 'injection.flagged' && data(r).run === run.id).map((r) => {
    const d = data(r);
    const source = d.source === 'document' ? `${String(d.document)} ${String(d.anchor)}`
      : d.source === 'project-memory' ? `project memory entry ${String(d.task)}` : `result of task ${String(d.task)}`;
    return [source, (d.patterns as string[]).join(', '), r.actor];
  });
  const seqs = ledger.filter((r) => data(r).run === run.id || instances.has(String(data(r).instance))).map((r) => r.seq);

  const lines = [
    `# ${report.title}`,
    '',
    `Run \`${run.id}\`, requested by ${run.user}. Assurance verdict: **${verdict.verdict}**${override ? ` — overridden by ${override.approver}` : ''}.`,
    '',
    `> ${run.objective.trim().replace(/\n/g, '\n> ')}`,
    '',
    '## Summary', '', report.summary,
    ...report.sections.flatMap((s) => ['', `## ${s.heading}`, '', s.body, '', s.evidence.length ? `Evidence: ${s.evidence.join(', ')}` : '_No evidence cited for this section._']),
    '', '## Recommendations', '', ...report.recommendations.map((r) => `- ${r}`),
    ...(report.openQuestions?.length ? ['', '## Open questions', '', ...report.openQuestions.map((q) => `- ${q}`)] : []),
    '', '---', '', '# Traceability', '',
    '_Generated by the platform from its run store, evidence store and audit ledger._',
    '', '## Independent assurance', '',
    `Verdict: **${verdict.verdict}**. ${verdict.summary}`,
    '',
    ...independence.map((i) => `- ${i.task}: reviewed on provider ${i.provider ?? 'unknown'}, ${i.independent ? 'different from every authoring provider' : '**the same provider as at least one author; independence is reduced**'}.`),
    ...(reworked.length ? [`- One rework round was run for: ${reworked.join(', ')}. First verdict was ${firstVerdict.verdict}.`] : ['- No rework was needed.']),
    ...(override ? [`- The fail verdict was overridden by ${override.approver}. Reason given: ${override.reason}`] : []),
    '',
    verdict.findings.length
      ? table(['Severity', 'Task', 'Finding', 'Resolution'], verdict.findings.map((f) => [f.severity, f.task, f.issue, f.resolution]))
      : '_No findings remain._',
    ...(uncovered.length ? [
      '', '## Not covered by the plan', '',
      'The approved plan assigned these parts of the objective to no one, because no approved agent or skill fits them. They were not assessed. `npm run assess` drafts the skills or agents that would cover them.',
      '', table(['Need', 'Why not covered'], uncovered.map((u) => [u.need, u.reason || 'not stated'])),
    ] : []),
    '', '## Evidence register', '',
    evidence.length
      ? table(['Id', 'Document', 'Passage', 'Content hash', 'Retrieved by', 'Cited by'],
        evidence.map((e) => [e.id, e.document, e.anchor, e.contentHash.slice(0, 12), e.retrievedBy, (citedBy.get(e.id) ?? []).join(', ') || 'not cited']))
      : '_No evidence was retrieved._',
    '',
    'Every evidence id cited in a task result or in this report was checked against this register before the result was accepted.',
    '', '## Suspected prompt injection', '',
    injections.length
      ? `Text that reads as an instruction to the reader was found and removed before any agent saw it. Treat these sources with suspicion.\n\n${table(['Source', 'Patterns matched', 'Seen by'], injections)}`
      : '_None detected. Detection is by pattern and can miss things; the other controls do not depend on it._',
    '', '## How the work was done', '',
    table(['Task', 'Agent', 'Stage', 'Models tried', 'Attempts', 'Tokens in / out', 'Cost (USD)'], tasks.map((t) => {
      const u = usage.get(t.id);
      return [t.id, t.agent, isStageTask(t.id) ? 'platform' : 'planned', t.tried.join(' → '), t.attempts,
        u ? `${u.input} / ${u.output}` : 'unknown', !u || u.unknown ? 'unknown' : u.cost.toFixed(4)];
    })),
    '', '## Approvals and decisions', '',
    ...(approvals.length ? approvals.map((a) => `- ${a}`) : ['_None recorded._']),
    '',
    seqs.length ? `Audit ledger records ${Math.min(...seqs)} to ${Math.max(...seqs)} cover this run. Check the chain with \`npm run verify-ledger\`.` : '',
    ...(ledger.length ? ['', `Ledger head when this report was written: \`${ledger.at(-1)!.seq}:${ledger.at(-1)!.hash}\`. Keep it outside this machine; \`npm run verify-ledger -- ${ledger.at(-1)!.seq}:${ledger.at(-1)!.hash}\` then detects records removed after it.`] : []),
    '',
  ];
  return lines.join('\n');
}
