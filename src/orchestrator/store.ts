// Durable record of orchestrated runs and their tasks. Every state change is written
// before the next step starts, so a killed process can be resumed from this file alone.
import type { DatabaseSync } from 'node:sqlite';
import type { Json } from '../harness/port.ts';
import type { Plan, PlannedTask } from './graph.ts';

export type RunStatus = 'planned' | 'approved' | 'rejected' | 'running' | 'completed' | 'failed';
/** `blocked`: a task it depends on did not complete. `needs_attention`: it stopped after changing something, so a person must decide. */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'needs_attention';

export interface RunRecord {
  id: string;
  user: string;
  objective: string;
  status: RunStatus;
  createdAt: string;
}

export interface TaskRecord extends PlannedTask {
  status: TaskStatus;
  /** Attempts started, including one cut short by a process kill. */
  attempts: number;
  instance: string | null;
  model: string | null;
  tried: string[];
  result: Json | null;
  failure: string | null;
  /** The current or last attempt ran a tool that is not a read. */
  sideEffects: boolean;
}

const now = () => new Date().toISOString();

export class RunStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, user TEXT NOT NULL, objective TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      run_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, agent TEXT NOT NULL, objective TEXT NOT NULL,
      skills TEXT NOT NULL, depends_on TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      instance TEXT, model TEXT, tried TEXT NOT NULL DEFAULT '[]', result TEXT, failure TEXT,
      side_effects INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (run_id, id))`);
  }

  createRun(id: string, user: string, objective: string, plan: Plan): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO runs (id, user, objective, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, user, objective, 'planned', now(), now());
      const insert = this.db.prepare(
        'INSERT INTO tasks (run_id, id, position, agent, objective, skills, depends_on, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      plan.tasks.forEach((t, i) => insert.run(id, t.id, i, t.agent, t.objective, JSON.stringify(t.skills), JSON.stringify(t.dependsOn), 'pending', now()));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  run(id: string): RunRecord | undefined {
    const r = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    return r ? toRun(r) : undefined;
  }

  runs(): RunRecord[] {
    return this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC').all().map(toRun);
  }

  setRunStatus(id: string, status: RunStatus): void {
    this.db.prepare('UPDATE runs SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
  }

  /** In plan order. */
  tasks(runId: string): TaskRecord[] {
    return this.db.prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY position').all(runId).map((r) => ({
      id: String(r.id), agent: String(r.agent), objective: String(r.objective),
      skills: JSON.parse(String(r.skills)) as string[], dependsOn: JSON.parse(String(r.depends_on)) as string[],
      status: String(r.status) as TaskStatus, attempts: Number(r.attempts),
      instance: r.instance === null ? null : String(r.instance), model: r.model === null ? null : String(r.model),
      tried: JSON.parse(String(r.tried)) as string[], result: r.result === null ? null : JSON.parse(String(r.result)) as Json,
      failure: r.failure === null ? null : String(r.failure), sideEffects: Number(r.side_effects) === 1,
    }));
  }

  /** Marks an attempt as started. Written before the agent is instantiated. */
  startAttempt(runId: string, taskId: string): void {
    this.db.prepare(`UPDATE tasks SET status = 'running', attempts = attempts + 1, side_effects = 0, failure = NULL, updated_at = ? WHERE run_id = ? AND id = ?`)
      .run(now(), runId, taskId);
  }

  /** Written before the first tool call that is not a read, so it is known even if the process dies during the call. */
  markSideEffects(runId: string, taskId: string): void {
    this.db.prepare('UPDATE tasks SET side_effects = 1, updated_at = ? WHERE run_id = ? AND id = ?').run(now(), runId, taskId);
  }

  setTaskStatus(runId: string, taskId: string, status: TaskStatus, failure: string | null = null): void {
    this.db.prepare('UPDATE tasks SET status = ?, failure = ?, updated_at = ? WHERE run_id = ? AND id = ?').run(status, failure, now(), runId, taskId);
  }

  finishTask(
    runId: string, taskId: string,
    outcome: { status: TaskStatus; instance: string | null; model: string | null; tried: string[]; result: Json | null; failure: string | null },
  ): void {
    this.db.prepare('UPDATE tasks SET status = ?, instance = ?, model = ?, tried = ?, result = ?, failure = ?, updated_at = ? WHERE run_id = ? AND id = ?')
      .run(outcome.status, outcome.instance, outcome.model, JSON.stringify(outcome.tried),
        outcome.result === null ? null : JSON.stringify(outcome.result), outcome.failure, now(), runId, taskId);
  }
}

function toRun(r: Record<string, unknown>): RunRecord {
  return { id: String(r.id), user: String(r.user), objective: String(r.objective), status: String(r.status) as RunStatus, createdAt: String(r.created_at) };
}
