// Cost and usage report, computed from the audit ledger alone. Unknown is never shown as
// zero: sessions whose usage was incomplete or whose model has no price are counted apart.
import type { Json } from '../harness/port.ts';
import type { AuditRecord } from './ledger.ts';

export interface UsageRow {
  key: string;
  /** Model sessions: one per task attempt per model tried. */
  sessions: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Sum over the sessions whose cost is known. */
  costUsd: number;
  /** Sessions with no cost figure: the model has no price, or usage was incomplete. */
  unpriced: number;
  /** Sessions where a model call reported no usage, so the token counts are a lower bound. */
  incomplete: number;
}

export interface UsageReport {
  byModel: UsageRow[];
  byRun: UsageRow[];
  /** Present when the report is for one run. */
  byTask?: UsageRow[];
  total: UsageRow;
}

const NO_RUN = '(not part of a run)';

export function usageReport(records: AuditRecord[], options: { runId?: string } = {}): UsageReport {
  const data = (r: AuditRecord) => (r.data ?? {}) as Record<string, Json>;
  const owner = new Map<string, { run: string; task: string }>();
  for (const r of records) {
    if (r.type !== 'agent.instantiated') continue;
    const d = data(r);
    owner.set(String(d.instance), { run: typeof d.run === 'string' ? d.run : NO_RUN, task: typeof d.task === 'string' ? d.task : String(d.agent) });
  }
  const groups = { model: new Map<string, UsageRow>(), run: new Map<string, UsageRow>(), task: new Map<string, UsageRow>() };
  const total = blank('total');
  const add = (row: UsageRow, d: Record<string, Json>) => {
    row.sessions++;
    row.modelCalls += Number(d.modelCalls);
    row.inputTokens += Number(d.inputTokens);
    row.outputTokens += Number(d.outputTokens);
    if (typeof d.costUsd === 'number') row.costUsd += d.costUsd;
    else row.unpriced++;
    if (d.usageComplete !== true) row.incomplete++;
  };
  const row = (map: Map<string, UsageRow>, key: string) => map.get(key) ?? map.set(key, blank(key)).get(key)!;
  for (const r of records) {
    if (r.type !== 'model.usage') continue;
    const d = data(r);
    const at = owner.get(String(d.instance)) ?? { run: NO_RUN, task: NO_RUN };
    if (options.runId && at.run !== options.runId) continue;
    add(row(groups.model, String(d.model)), d);
    add(row(groups.run, at.run), d);
    add(row(groups.task, at.task), d);
    add(total, d);
  }
  return {
    byModel: [...groups.model.values()], byRun: [...groups.run.values()], total,
    ...(options.runId ? { byTask: [...groups.task.values()] } : {}),
  };
}

function blank(key: string): UsageRow {
  return { key, sessions: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unpriced: 0, incomplete: 0 };
}

/** Plain-text table. `note` adds a remark per row key, for example that a model runs on a subscription. */
export function formatUsage(title: string, rows: UsageRow[], note: (key: string) => string = () => ''): string {
  const cost = (r: UsageRow) => (r.unpriced === r.sessions && r.sessions > 0 ? 'unknown' : `${r.costUsd.toFixed(4)}${r.unpriced ? ` + ${r.unpriced} unpriced` : ''}`);
  const cells = [
    [title, 'sessions', 'model calls', 'tokens in', 'tokens out', 'cost USD', ''],
    ...rows.map((r) => [r.key, r.sessions, r.modelCalls, r.inputTokens, r.outputTokens, cost(r), [r.incomplete ? `${r.incomplete} with incomplete usage` : '', note(r.key)].filter(Boolean).join('; ')].map(String)),
  ];
  const widths = cells[0]!.map((_, i) => Math.max(...cells.map((c) => c[i]!.length)));
  return cells.map((c) => c.map((v, i) => (i === 0 || i === 6 ? v.padEnd(widths[i]!) : v.padStart(widths[i]!))).join('  ').trimEnd()).join('\n');
}
