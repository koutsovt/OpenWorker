// Renders the final report as two files. The brief is short and meant to be read: the report
// task's validated result, then a condensed traceability section. The appendix holds the detail:
// every task's final result, the full assurance review, the evidence register and the work log.
// Everything outside the report task's own text is generated here from the run store, the
// evidence store and the audit ledger, so it does not depend on what any model chose to say.
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
  /** File name of the appendix, as the brief should refer to it. */
  appendixName: string;
}

const cell = (value: unknown): string => String(value ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const table = (head: string[], rows: unknown[][]): string =>
  [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
const data = (r: AuditRecord) => (r.data ?? {}) as Record<string, Json>;
const humanize = (key: string) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

/** A brief from before the decision-brief contract (summary and sections) still renders. */
function briefOf(result: Json | null): ReportResult {
  const r = (result ?? {}) as Partial<ReportResult> & { summary?: string; sections?: { heading: string; body: string; evidence: string[] }[]; openQuestions?: string[] };
  return {
    title: r.title ?? 'Report',
    answer: r.answer ?? r.summary ?? '',
    findings: r.findings ?? (r.sections ?? []).map((s) => ({ heading: s.heading, point: s.body, evidence: s.evidence })),
    recommendations: r.recommendations ?? [],
    decisionsNeeded: r.decisionsNeeded ?? r.openQuestions ?? [],
  };
}

/** A list of short plain values (ids, names, numbers) reads better on one line. */
const inline = (value: Json): string | undefined =>
  Array.isArray(value) && value.every((x) => x === null || typeof x !== 'object') && value.every((x) => String(x).length <= 40)
    ? (value.length ? value.map(String).join(', ') : '_none_') : undefined;

/** Any task result as readable Markdown: fields as labels, lists as bullets, claims with their evidence. */
function renderValue(value: Json, depth = 0): string {
  const pad = '  '.repeat(depth);
  if (value === null || typeof value !== 'object') return `${pad}${String(value)}`;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const o = item as Record<string, Json>;
        if (typeof o.statement === 'string') {
          const ids = Array.isArray(o.evidence) && o.evidence.length ? ` (${o.evidence.join(', ')})` : ' (no evidence cited)';
          return `${pad}- ${o.statement}${ids}`;
        }
        // One bullet per object, its fields as labelled lines under it.
        return Object.entries(o).map(([k, v], i) => {
          const lead = i === 0 ? `${pad}- ` : `${pad}  `;
          const short = inline(v);
          if (short !== undefined) return `${lead}**${humanize(k)}:** ${short}`;
          return v !== null && typeof v === 'object' ? `${lead}**${humanize(k)}:**\n${renderValue(v, depth + 2)}` : `${lead}**${humanize(k)}:** ${String(v)}`;
        }).join('\n');
      }
      return `${pad}- ${typeof item === 'object' && item !== null ? JSON.stringify(item) : String(item)}`;
    }).join('\n');
  }
  return Object.entries(value).map(([k, v]) => {
    const short = inline(v);
    if (short !== undefined) return `${pad}**${humanize(k)}:** ${short}`;
    return v !== null && typeof v === 'object' ? `${pad}**${humanize(k)}**\n\n${renderValue(v, depth)}` : `${pad}**${humanize(k)}:** ${String(v)}`;
  }).join('\n\n');
}

/** One line per document: which passages the brief cites from it, with their ids. */
const citedByDocument = (records: EvidenceRecord[]): string[] => {
  const byDocument = new Map<string, string[]>();
  for (const e of records) byDocument.set(e.document, [...(byDocument.get(e.document) ?? []), `${e.anchor} (${e.id})`]);
  return [...byDocument].map(([document, passages]) => `- ${document}: ${passages.join(', ')}`);
};

export function renderReport(input: ReportInput): { brief: string; appendix: string } {
  const { run, tasks, evidence, decisions, ledger, appendixName } = input;
  const by = new Map(tasks.map((t) => [t.id, t]));
  const report = briefOf(by.get(STAGE.report)!.result);
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
  const totals = [...usage.values()].reduce((a, u) => ({ input: a.input + u.input, output: a.output + u.output, cost: a.cost + u.cost, unknown: a.unknown || u.unknown }),
    { input: 0, output: 0, cost: 0, unknown: false });
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
  const head = ledger.at(-1);
  const count = (severity: string) => verdict.findings.filter((f) => f.severity === severity).length;
  const serious = verdict.findings.filter((f) => f.severity !== 'minor');
  const evidenceRows = (list: EvidenceRecord[]) => list.map((e) => [e.id, e.document, e.anchor, e.contentHash.slice(0, 12), e.retrievedBy, (citedBy.get(e.id) ?? []).join(', ') || 'not cited']);
  const independenceLines = independence.map((i) => `- ${i.task}: reviewed on provider ${i.provider ?? 'unknown'}, ${i.independent ? 'different from every authoring provider' : '**the same provider as at least one author; independence is reduced**'}.`);
  const reworkLine = reworked.length ? `- One rework round was run for: ${reworked.join(', ')}. First verdict was ${firstVerdict.verdict}.` : '- No rework was needed.';
  const overrideLine = override ? [`- The fail verdict was overridden by ${override.approver}. Reason given: ${override.reason}`] : [];
  const injectionSection = injections.length
    ? `Text that reads as an instruction to the reader was found and removed before any agent saw it. Treat these sources with suspicion.\n\n${table(['Source', 'Patterns matched', 'Seen by'], injections)}`
    : '_None detected. Detection is by pattern and can miss things; the other controls do not depend on it._';
  const cost = totals.unknown ? 'cost unknown' : `USD ${totals.cost.toFixed(4)}`;

  const documents = new Set(evidence.map((e) => e.document)).size;
  const independent = independence.length > 0 && independence.every((i) => i.independent);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // The brief is for the reader who decides: the answer first, then a few short checks. Everything an
  // auditor needs (citations by finding, approvals, injection screening, usage, ledger range) is in the appendix.
  const brief = [
    `# ${report.title}`,
    '',
    `_Independent review: **${verdict.verdict}**${override ? `, overridden by ${override.approver}` : ''}. Full detail and sources: \`${appendixName}\`._`,
    '',
    '## Answer', '', report.answer,
    '', '## Key findings',
    ...report.findings.flatMap((f) => ['', `**${f.heading}.** ${f.point}`]),
    '', '## Recommendations', '', ...report.recommendations.map((r) => `- ${r}`),
    ...(report.decisionsNeeded.length ? ['', '## Decisions needed', '', ...report.decisionsNeeded.map((q) => `- ${q}`)] : []),
    ...(uncovered.length ? ['', '## Not assessed', '', 'No approved agent covers these, so the plan left them out:', '', ...uncovered.map((u) => `- ${u.need}`)] : []),
    '', '---', '', '## How this was checked', '',
    `- ${plural(evidence.length, 'passage')} from ${plural(documents, 'document')} were read; every claim cites one, and each citation was checked before it was accepted.`,
    `- An independent review ${reworked.length ? `sent ${reworked.join(' and ')} back for one rework round, then ` : ''}gave a final verdict of ${verdict.verdict}, with ${count('critical')} critical, ${count('major')} major and ${count('minor')} minor findings open.`,
    ...(independent ? [] : ['- The reviewer ran on the same AI provider as the authors, so the review is less independent than it should be.']),
    ...(override ? [`- The fail verdict was overridden by ${override.approver}: ${override.reason}`] : []),
    ...(injections.length ? [`- Text that read as an instruction to the AI was found in ${plural(injections.length, 'source')} and removed. See the appendix.`] : []),
    ...(serious.length ? ['', '**Open critical and major findings**', '', table(['Severity', 'About', 'Finding'], serious.map((f) => [f.severity, f.task, f.issue]))] : []),
    '',
    `_Run \`${run.id}\`, requested by ${run.user}.${head ? ` Audit ledger head \`${head.seq}:${head.hash.slice(0, 16)}…\`; see the appendix to verify it._` : '_'}`,
    '',
  ].join('\n');

  // The latest version of each planned task: its rework if it was revised.
  const planned = tasks.filter((t) => !isStageTask(t.id));
  const latest = planned.map((t) => by.get(STAGE.rework(t.id)) ?? t);
  const review = (title: string, v: AssuranceResult | undefined) => (v ? [
    '', `### ${title}: ${v.verdict}`, '', v.summary, '',
    v.findings.length ? table(['Severity', 'Task', 'Finding', 'Resolution'], v.findings.map((f) => [f.severity, f.task, f.issue, f.resolution])) : '_No findings._',
  ] : []);

  const appendix = [
    `# Appendix: ${report.title}`,
    '',
    `Run \`${run.id}\`. The brief is the report; this is the detail behind it, generated by the platform from the run store, the evidence store and the audit ledger.`,
    '', `> ${run.objective.trim().replace(/\n/g, '\n> ')}`,
    '', '## Sources for the brief', '',
    '_The evidence each finding in the brief rests on, by document and passage._',
    ...report.findings.flatMap((f) => {
      const records = evidence.filter((e) => f.evidence.includes(e.id));
      return ['', `**${f.heading}**`, '', ...(records.length ? citedByDocument(records) : ['- _No evidence cited._'])];
    }),
    '', '## Task results',
    '', '_The final version of each planned task. A task that was revised after review shows its revised result._',
    ...latest.flatMap((t) => [
      '', `### ${t.id.replace(/-rework$/, '')} (${t.agent}${t.id.endsWith('-rework') ? ', revised after review' : ''})`, '',
      t.result === null ? '_No result._' : renderValue((t.result as { text?: Json }).text !== undefined && Object.keys(t.result as object).length === 1 ? (t.result as { text: Json }).text : t.result),
    ]),
    '', '## Independent assurance',
    '', ...independenceLines, reworkLine, ...overrideLine,
    ...review(by.get(STAGE.reassurance) ? 'Final review' : 'Review', verdict),
    ...(by.get(STAGE.reassurance) ? review('First review', firstVerdict) : []),
    '', '## Evidence register', '',
    evidence.length ? table(['Id', 'Document', 'Passage', 'Content hash', 'Retrieved by', 'Cited by'], evidenceRows(evidence)) : '_No evidence was retrieved._',
    '',
    'Every evidence id cited in a task result or in the brief was checked against this register before the result was accepted.',
    '', '## Suspected prompt injection', '', injectionSection,
    '', '## How the work was done', '',
    `${tasks.length} tasks, ${reworked.length ? 'one rework round' : 'no rework'}; ${totals.input} tokens in, ${totals.output} out, ${cost}.`,
    '',
    table(['Task', 'Agent', 'Stage', 'Models tried', 'Attempts', 'Tokens in / out', 'Cost (USD)'], tasks.map((t) => {
      const u = usage.get(t.id);
      return [t.id, t.agent, isStageTask(t.id) ? 'platform' : 'planned', t.tried.join(' → '), t.attempts,
        u ? `${u.input} / ${u.output}` : 'unknown', !u || u.unknown ? 'unknown' : u.cost.toFixed(4)];
    })),
    '', '## Approvals and decisions', '',
    ...(approvals.length ? approvals.map((a) => `- ${a}`) : ['_None recorded._']),
    '', '## Audit ledger', '',
    seqs.length ? `Records ${Math.min(...seqs)} to ${Math.max(...seqs)} cover this run. Check the chain with \`npm run verify-ledger\`.` : '_No records._',
    ...(head ? ['', `Ledger head when this report was written: \`${head.seq}:${head.hash}\`. Keep it outside this machine; \`npm run verify-ledger -- ${head.seq}:${head.hash}\` then detects records removed after it.`] : []),
    '',
  ].join('\n');

  return { brief, appendix };
}
