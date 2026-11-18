// Live progress for the command line. It follows the audit ledger as records are appended, so it
// shows only what the platform has actually recorded: which agents are working, what they read,
// verdicts, rework and anything that went wrong. On a terminal it redraws a status block in place;
// otherwise (a pipe, a log file) it prints one line per event.
import type { AuditLedger, AuditRecord } from '../audit/ledger.ts';
import { RunState, type TaskView } from './run-state.ts';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** Routine events the status block already shows; only the rest are printed as lines. */
const QUIET = new Set(['START', 'DONE', 'PLAN', 'APPROVE']);

export const seconds = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

export interface ProgressOptions {
  /** Where to draw. Standard error by default, so standard output keeps only the result. */
  out?: NodeJS.WriteStream;
  /** Redraw in place. Defaults to whether `out` is a terminal. */
  live?: boolean;
  color?: boolean;
  /** For tests: the clock. */
  now?: () => number;
}

export class LiveProgress {
  private readonly state: RunState;
  private readonly out: NodeJS.WriteStream;
  private readonly live: boolean;
  private readonly color: boolean;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly title: string;
  private drawn = 0;
  private frame = 0;
  private paused = false;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private restore: (() => void) | undefined;
  private write: (text: string) => void;

  constructor(title: string, options: ProgressOptions = {}) {
    this.title = title;
    this.out = options.out ?? process.stderr;
    this.live = options.live ?? Boolean(this.out.isTTY);
    this.color = options.color ?? (this.live && !process.env.NO_COLOR);
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.state = new RunState(this.now);
    this.write = (text) => void this.out.write(text);
  }

  /** Tasks known in advance, shown as waiting until they start. */
  seed(tasks: { id: string; agent: string }[]): this {
    this.state.seed(tasks);
    this.draw();
    return this;
  }

  /** Starts following the ledger. */
  follow(ledger: AuditLedger): this {
    this.unsubscribe = ledger.onAppend((r) => this.on(r));
    if (this.live) {
      this.timer = setInterval(() => this.draw(), 120).unref();
      // Anything else written to the same stream (an engine's warning, a log line) goes above the block,
      // so the block's line count stays right and nothing is left half-erased.
      const original = this.out.write;
      const own = original.bind(this.out) as (text: string) => boolean;
      this.write = (text) => void own(text);
      this.out.write = ((chunk: unknown, ...rest: unknown[]) => {
        const held = this.drawn > 0;
        this.clear();
        const result = (original as (...a: unknown[]) => boolean).call(this.out, chunk, ...rest);
        if (held) this.draw();
        return result;
      }) as typeof this.out.write;
      this.restore = () => { this.out.write = original; };
    }
    this.draw();
    return this;
  }

  /** Clears the block so a question can be asked on the terminal. */
  pause(): void {
    this.clear();
    this.paused = true;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  resume(): void {
    this.paused = false;
    this.draw();
  }

  /** Draws the final state once, unless paused, and stops following. Safe to call twice. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
    if (!this.paused) this.draw(true);
    this.restore?.();
    this.paused = true;
    this.drawn = 0;
  }

  /** Applies one ledger record. Public for tests. */
  on(record: AuditRecord): void {
    const e = this.state.on(record);
    if (e && !QUIET.has(e.kind)) this.event(e.mark, e.tone === 'info' ? 'accent' : e.tone, `${e.text}${e.reason ? ` (${e.reason})` : ''}`);
    if (!this.live && ['run.task_started', 'run.task_completed', 'plan.accepted', 'assessment.completed'].includes(record.type)) {
      const id = (record.data as { task?: string } | null)?.task ?? (record.type === 'plan.accepted' ? 'planning' : 'assessment');
      const t = this.state.tasks.get(id);
      if (t) this.write(`${this.line(t)}\n`);
    }
  }

  /** A permanent line above the status block. */
  private event(mark: string, tone: 'good' | 'warn' | 'bad' | 'accent', text: string): void {
    this.clear();
    this.write(`${this.paint(tone, mark)} ${text}\n`);
    this.draw();
  }

  private clear(): void {
    if (!this.live || !this.drawn) return;
    this.write(`\x1b[${this.drawn}A\x1b[J`);
    this.drawn = 0;
  }

  private draw(final = false): void {
    if (!this.live || this.paused) return;
    this.clear();
    this.frame = (this.frame + 1) % FRAMES.length;
    const all = [...this.state.tasks.values()];
    const done = all.filter((t) => t.status === 'done').length;
    const running = all.some((t) => t.status === 'running');
    const head = `${final ? this.paint('dim', '■') : this.paint('accent', FRAMES[this.frame]!)} ${this.title} · ${seconds(this.now() - this.startedAt)}`
      + (all.length ? ` · ${done}/${all.length} done` : '') + (!final && !running && all.length ? this.paint('dim', ' · waiting') : '');
    const lines = [head, ...all.map((t) => this.line(t))];
    const width = Math.max(40, (this.out.columns ?? 100) - 1);
    // Each line is cut to the terminal width, so the count of lines to erase stays exact.
    this.write(`${lines.map((l) => cut(l, width)).join('\n')}\n`);
    this.drawn = lines.length;
  }

  private line(t: TaskView): string {
    const mark = { waiting: this.paint('dim', '·'), running: this.paint('accent', FRAMES[this.frame]!), retrying: this.paint('warn', '↻'),
      done: this.paint('good', '✓'), failed: this.paint('bad', '✗'), blocked: this.paint('dim', '⊘'), attention: this.paint('warn', '!') }[t.status];
    const time = t.startedAt ? seconds((t.endedAt ?? this.now()) - t.startedAt).padStart(6) : ''.padStart(6);
    const work = [t.tools ? `${t.tools} tool ${t.tools === 1 ? 'call' : 'calls'}` : '', t.passages ? `${t.passages} passages read` : ''].filter(Boolean).join(', ');
    const detail = t.status === 'running' ? [work, t.last ? this.paint('dim', t.last) : ''].filter(Boolean).join(' · ')
      : t.status === 'waiting' ? this.paint('dim', 'waiting') : [work, t.note ?? ''].filter(Boolean).join(' · ');
    return `  ${mark} ${t.id.padEnd(24)} ${this.paint('dim', t.agent.padEnd(22))} ${time}  ${detail}`;
  }

  private paint(tone: 'good' | 'warn' | 'bad' | 'dim' | 'accent', text: string): string {
    if (!this.color) return text;
    const code = { good: 32, warn: 33, bad: 31, dim: 2, accent: 36 }[tone];
    return `\x1b[${code}m${text}\x1b[0m`;
  }
}

/** Cuts a line to `width` visible characters, ignoring colour codes. */
function cut(line: string, width: number): string {
  let visible = 0;
  let out = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\x1b') {
      const end = line.indexOf('m', i);
      out += line.slice(i, end + 1);
      i = end;
      continue;
    }
    if (visible >= width) {
      out += '\x1b[0m';
      break;
    }
    out += line[i];
    visible++;
  }
  return out;
}
