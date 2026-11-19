// What a person watching a run should know, built only from audit ledger records as they are appended:
// each task's state and work, the run's stage, totals, the latest verdict, and a log of notable events,
// each with its reason. The terminal view and the dashboard both draw from this.
import type { AuditRecord } from '../audit/ledger.ts';
import type { Json } from '../harness/port.ts';

export type TaskStatus = 'waiting' | 'running' | 'retrying' | 'done' | 'failed' | 'blocked' | 'attention';
export type Tone = 'good' | 'warn' | 'bad' | 'info';
export type Stage = 'planning' | 'approval' | 'working' | 'assurance' | 'rework' | 'report' | 'done' | 'held' | 'failed' | 'assessing';

export interface TaskView {
  id: string;
  agent: string;
  status: TaskStatus;
  startedAt?: number;
  endedAt?: number;
  attempt: number;
  tools: number;
  passages: number;
  modelCalls: number;
  tokensIn: number;
  tokensOut: number;
  last?: string;
  note?: string;
}

export interface RunEvent {
  seq: number;
  at: string;
  mark: string;
  tone: Tone;
  /** Short label for the log, such as ENTER or VERDICT. */
  kind: string;
  text: string;
  /** Why: the reason recorded with the event, where there is one. */
  reason?: string;
}

export interface Verdict {
  task: string;
  verdict: string;
  critical: number;
  major: number;
  minor: number;
  independent: boolean;
}

export const PLANNING = 'planning';
const REVIEW = new Set(['assurance', 'assurance-2']);

export class RunState {
  readonly tasks = new Map<string, TaskView>();
  readonly events: RunEvent[] = [];
  readonly totals = { modelCalls: 0, tokensIn: 0, tokensOut: 0, evidence: 0, toolCalls: 0, costUsd: 0, costUnknown: false };
  verdict: Verdict | undefined;
  stage: Stage = 'planning';
  runId: string | undefined;
  readonly startedAt: number;
  private readonly instances = new Map<string, string>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.startedAt = now();
  }

  /** Tasks known in advance, shown as waiting until they start. */
  seed(tasks: { id: string; agent: string }[]): void {
    for (const t of tasks) this.task(t.id, t.agent);
  }

  /** Applies one record. Returns the event it added to the log, if any. */
  on(record: AuditRecord): RunEvent | undefined {
    const d = (record.data ?? {}) as Record<string, Json>;
    const str = (key: string) => (typeof d[key] === 'string' ? (d[key] as string) : undefined);
    const num = (key: string) => (typeof d[key] === 'number' ? (d[key] as number) : 0);
    const byInstance = (actor: string) => this.tasks.get(this.instances.get(actor.replace(/^agent:/, '')) ?? '');
    const event = (mark: string, tone: Tone, kind: string, text: string, reason?: string): RunEvent => {
      const e = { seq: record.seq, at: record.at, mark, tone, kind, text, ...(reason ? { reason } : {}) };
      this.events.push(e);
      return e;
    };

    switch (record.type) {
      case 'agent.instantiated': {
        const t = this.task(str('task') ?? (str('run') ? undefined : PLANNING), str('agent'));
        if (t) {
          this.instances.set(String(d.instance), t.id);
          this.start(t);
        }
        if (str('task') === 'assessment') this.stage = 'assessing';
        return undefined;
      }
      case 'run.task_started': {
        const t = this.task(str('task'), str('agent'))!;
        this.start(t);
        this.stage = t.id === 'report' ? 'report' : REVIEW.has(t.id) ? 'assurance' : t.id.endsWith('-rework') ? 'rework' : this.stage === 'approval' ? 'working' : this.stage;
        return t.attempt > 1 ? undefined : event('▶', 'info', 'START', `${t.id} started`, t.agent);
      }
      case 'tool.called': {
        const t = byInstance(record.actor);
        this.totals.toolCalls++;
        if (t) {
          t.tools++;
          t.last = str('tool');
        }
        return undefined;
      }
      case 'evidence.recorded': {
        const t = byInstance(record.actor);
        this.totals.evidence++;
        if (t) {
          t.passages++;
          t.last = `read ${str('document')} ${str('anchor')}`;
        }
        return undefined;
      }
      case 'model.usage': {
        const t = byInstance(`agent:${str('instance') ?? ''}`);
        this.totals.modelCalls += num('modelCalls');
        this.totals.tokensIn += num('inputTokens');
        this.totals.tokensOut += num('outputTokens');
        if (typeof d.costUsd === 'number') this.totals.costUsd += d.costUsd;
        else this.totals.costUnknown = true;
        if (t) {
          t.modelCalls += num('modelCalls');
          t.tokensIn += num('inputTokens');
          t.tokensOut += num('outputTokens');
        }
        return undefined;
      }
      case 'plan.accepted': {
        this.runId = str('run');
        const tasks = (d.tasks as { id: string; agent: string }[] | undefined) ?? [];
        this.end(this.task(PLANNING), 'done', `${tasks.length} tasks proposed`);
        this.seed(tasks);
        this.stage = 'approval';
        const uncovered = (d.uncovered as string[] | undefined) ?? [];
        return event('◆', uncovered.length ? 'warn' : 'info', 'PLAN', `Plan proposed: ${tasks.map((t) => t.id).join(', ')}`,
          uncovered.length ? `not covered: ${uncovered.join('; ')}` : 'waiting for approval');
      }
      case 'plan.rejected': {
        this.end(this.task(PLANNING), 'retrying', 'plan sent back');
        return event('↻', 'warn', 'REJECT', 'Plan rejected and sent back to the planner', (d.problems as string[]).slice(0, 3).join('; '));
      }
      case 'plan.approved': {
        this.runId = str('run');
        this.stage = 'working';
        return event('✓', 'good', 'APPROVE', `Plan approved by ${record.actor.replace(/^user:/, '')}`, d.selfApproval ? 'self-approval, allowed by policy' : undefined);
      }
      case 'plan.denied': {
        this.stage = 'failed';
        return event('✗', 'bad', 'DENY', `Plan denied by ${record.actor.replace(/^user:/, '')}`, 'nothing ran');
      }
      case 'run.task_completed': {
        const t = this.task(str('task'))!;
        this.end(t, 'done');
        return event('✓', 'good', 'DONE', `${t.id} completed`, [t.tools ? `${t.tools} tool calls` : '', t.passages ? `${t.passages} passages read` : ''].filter(Boolean).join(', ') || undefined);
      }
      case 'run.task_retried': {
        this.end(this.task(str('task')), 'retrying', String(d.reason));
        return event('↻', 'warn', 'RETRY', `${str('task')} sent back; trying again`, String(d.reason));
      }
      case 'run.task_failed': {
        this.end(this.task(str('task')), 'failed', String(d.reason).slice(0, 80));
        return event('✗', 'bad', 'FAIL', `${str('task')} failed`, String(d.reason).slice(0, 300));
      }
      case 'run.task_blocked': {
        this.end(this.task(str('task')), 'blocked', `waits on ${str('dependency')}`);
        return event('⊘', 'warn', 'BLOCK', `${str('task')} cannot start`, `${str('dependency')} did not complete`);
      }
      case 'run.task_needs_attention': {
        this.end(this.task(str('task')), 'attention', 'needs a person');
        return event('!', 'warn', 'ATTENTION', `${str('task')} stopped after changing something`, 'a person must decide');
      }
      case 'assessment.started': {
        this.runId = str('run');
        this.task('assessment', 'capability-analyst');
        this.stage = 'assessing';
        return undefined;
      }
      case 'assessment.rejected': {
        this.end(this.task('assessment'), 'retrying', 'sent back');
        return event('↻', 'warn', 'RETRY', 'Assessment sent back by the platform', (d.problems as string[]).slice(0, 3).join('; '));
      }
      case 'assessment.completed': {
        this.end(this.task('assessment'), 'done', `${num('needs')} needs, ${num('gaps')} gaps, ${num('partial')} partial`);
        this.stage = 'done';
        return event('✓', 'good', 'DONE', `Assessment complete: ${num('needs')} needs, ${num('gaps')} gaps, ${num('partial')} partly covered`,
          ((d.recommended as string[] | undefined) ?? []).join(', ') || undefined);
      }
      case 'assessment.failed': {
        this.end(this.task('assessment'), 'failed');
        this.stage = 'failed';
        return event('✗', 'bad', 'FAIL', 'Assessment failed', (d.problems as string[]).slice(0, 3).join('; '));
      }
      case 'assurance.verdict': {
        const v = String(d.verdict);
        this.verdict = { task: str('task')!, verdict: v, critical: num('critical'), major: num('major'), minor: num('minor'), independent: d.independent === true };
        return event(v === 'pass' ? '✓' : v === 'fail' ? '✗' : '!', v === 'pass' ? 'good' : v === 'fail' ? 'bad' : 'warn', 'VERDICT',
          `${str('task')} verdict: ${v}`, `${num('critical')} critical, ${num('major')} major, ${num('minor')} minor`);
      }
      case 'assurance.independence_reduced':
        return event('!', 'warn', 'NOTE', `${str('task')}: independence is reduced`, 'the reviewer ran on the same provider as the authors');
      case 'assurance.rework_requested': {
        const cascaded = (d.cascaded as string[] | undefined) ?? [];
        this.stage = 'rework';
        return event('↻', 'warn', 'REWORK', `Rework requested for ${(d.tasks as string[]).join(', ')}`,
          cascaded.length ? `${cascaded.join(', ')} redone too, because they depend on it` : 'findings must be fixed by their authors');
      }
      case 'assurance.blocked': {
        this.stage = 'held';
        return event('✗', 'bad', 'HOLD', 'Run held: assurance failed the work', 'an approver must override with a reason, or stop here');
      }
      case 'assurance.overridden':
        return event('!', 'warn', 'OVERRIDE', `Assurance overridden by ${record.actor.replace(/^user:/, '')}`, str('reason'));
      case 'injection.flagged':
        return event('!', 'warn', 'INJECTION', `Suspected prompt injection removed from ${str('document') ?? str('task') ?? 'a source'}`, (d.patterns as string[]).join(', '));
      case 'budget.exceeded': case 'budget.run_exceeded':
        return event('!', 'bad', 'BUDGET', 'Budget reached', str('limit'));
      case 'model.fallback_failed': case 'model.fallback_exhausted':
        return event('!', 'warn', 'MODEL', `Model fallback ${record.type.split('_')[1]}`, str('reason'));
      case 'tool.denied':
        return event('!', 'warn', 'DENIED', `${byInstance(record.actor)?.id ?? 'An agent'} was refused ${str('tool')}`, str('reason') ?? str('code'));
      case 'approval.requested':
        return event('?', 'warn', 'ASK', `${byInstance(record.actor)?.id ?? 'An agent'} asks to call ${str('tool')}`, 'waiting for an approver');
      case 'report.written':
        return event('✓', 'good', 'REPORT', 'Report written', str('run'));
      case 'run.finished': {
        const status = str('status');
        this.stage = status === 'completed' ? 'done' : status === 'held' ? 'held' : 'failed';
        return event(status === 'completed' ? '■' : '✗', status === 'completed' ? 'good' : 'bad', 'END', `Run ${status}`);
      }
      default:
        return undefined;
    }
  }

  /** A JSON-ready copy for the dashboard. */
  snapshot(): Json {
    return {
      runId: this.runId ?? null, stage: this.stage, startedAt: this.startedAt, now: this.now(),
      tasks: [...this.tasks.values()] as unknown as Json, totals: this.totals as unknown as Json,
      verdict: (this.verdict ?? null) as unknown as Json, events: this.events.slice(-200) as unknown as Json,
    };
  }

  private task(id: string | undefined, agent = ''): TaskView | undefined {
    if (!id) return undefined;
    let t = this.tasks.get(id);
    if (!t) this.tasks.set(id, t = { id, agent, status: 'waiting', attempt: 0, tools: 0, passages: 0, modelCalls: 0, tokensIn: 0, tokensOut: 0 });
    if (agent && !t.agent) t.agent = agent;
    return t;
  }

  private start(t: TaskView): void {
    if (t.status !== 'running') t.attempt++;
    t.status = 'running';
    t.startedAt ??= this.now();
    t.endedAt = undefined;
    t.note = t.attempt > 1 ? `attempt ${t.attempt}` : undefined;
  }

  private end(t: TaskView | undefined, status: TaskStatus, note?: string): void {
    if (!t) return;
    t.status = status;
    t.endedAt = this.now();
    t.note = note ?? (t.attempt > 1 ? `attempt ${t.attempt}` : undefined);
  }
}
