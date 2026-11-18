// A live dashboard for one run, served by the command line on this machine only. It follows the audit
// ledger through RunState and pushes each change to the browser (server-sent events). A question the
// command line would ask on the terminal (approve the plan, approve a tool call, override a fail
// verdict) can be answered here or there, whichever comes first; the answer goes through the same
// policy checks either way. Every request must carry the random token printed with the address.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, join } from 'node:path';
import type { AuditLedger } from '../audit/ledger.ts';
import type { Json } from '../harness/port.ts';
import { DASHBOARD_PAGE } from './dashboard-page.ts';
import { RunState } from './run-state.ts';

/**
 * The first answer from the terminal or the page. `local` asks on the terminal and must give up when its
 * signal is aborted; that happens once the page answers, and the abort is not an error.
 */
export async function firstAnswer(local: (signal: AbortSignal) => Promise<string>, remote?: Promise<string>): Promise<{ answer: string; from: 'terminal' | 'dashboard' }> {
  const stop = new AbortController();
  const fromTerminal = local(stop.signal).then(
    (answer) => ({ answer, from: 'terminal' as const }),
    // Once the page has answered, the terminal's abort error must never win the race.
    (e: unknown) => (stop.signal.aborted ? new Promise<never>(() => {}) : Promise.reject(e)),
  );
  if (!remote) return fromTerminal;
  const fromPage = remote.then((answer) => ({ answer, from: 'dashboard' as const }));
  const first = await Promise.race([fromTerminal, fromPage]);
  stop.abort();
  return first;
}

export interface AgentCard {
  id: string;
  purpose: string;
  /** The rule the agent works under, in a few words. */
  rule: string;
}

export interface Question {
  kind: 'confirm' | 'text';
  title: string;
  /** Detail shown with the question: the plan, the tool call's arguments, the failed verdict. */
  body?: Json;
}

interface Pending extends Question {
  id: string;
  resolve: (answer: string) => void;
}

export interface DashboardOptions {
  ledger: AuditLedger;
  title: string;
  agents: AgentCard[];
  /** Reports in this folder may be opened from the page. */
  reportsDir?: string;
  /** Extra detail for an event, such as the findings behind a verdict. */
  detail?: (taskId: string) => Json | undefined;
  port?: number;
}

export class Dashboard {
  readonly state = new RunState();
  private readonly options: DashboardOptions;
  private readonly token = randomBytes(16).toString('hex');
  private readonly clients = new Set<ServerResponse>();
  private readonly details = new Map<string, Json>();
  private readonly reports: string[] = [];
  private server: Server | undefined;
  private unsubscribe: (() => void) | undefined;
  private pending: Pending | undefined;
  private plan: Json | undefined;
  private timer: NodeJS.Timeout | undefined;
  private dirty = false;
  private nextId = 1;

  constructor(options: DashboardOptions) {
    this.options = options;
  }

  /** Starts serving on 127.0.0.1 and following the ledger. Returns the address to open, token included. */
  async start(): Promise<string> {
    this.unsubscribe = this.options.ledger.onAppend((record) => {
      this.state.on(record);
      const d = (record.data ?? {}) as Record<string, Json>;
      if (record.type === 'assurance.verdict' && typeof d.task === 'string') {
        const detail = this.options.detail?.(d.task);
        if (detail !== undefined) this.details.set(d.task, detail);
      }
      if (record.type === 'report.written' && this.options.reportsDir) {
        const run = String(d.run);
        for (const name of [`${run}.md`, `${run}-appendix.md`]) if (existsSync(join(this.options.reportsDir, name)) && !this.reports.includes(name)) this.reports.push(name);
      }
      this.dirty = true;
    });
    // Changes are sent at most every 150 ms; the page keeps its own clock between them.
    this.timer = setInterval(() => {
      if (this.dirty) this.broadcast();
    }, 150).unref();
    this.server = createServer((req, res) => this.handle(req, res));
    const port = await new Promise<number>((resolve, reject) => {
      const listen = (p: number) => {
        this.server!.once('error', (e: NodeJS.ErrnoException) => (e.code === 'EADDRINUSE' && p !== 0 ? listen(0) : reject(e)));
        this.server!.listen(p, '127.0.0.1', () => resolve((this.server!.address() as AddressInfo).port));
      };
      listen(this.options.port ?? 4317);
    });
    return `http://127.0.0.1:${port}/?t=${this.token}`;
  }

  /** The plan, once proposed, for the approval card. */
  showPlan(plan: Json): void {
    this.plan = plan;
    if (this.state.stage === 'planning') this.state.stage = 'approval';
    this.dirty = true;
  }

  seed(tasks: { id: string; agent: string }[]): void {
    this.state.seed(tasks);
    this.dirty = true;
  }

  /** Puts a question on the page. Resolves with the answer given there; `withdraw` removes it if the terminal answered first. */
  ask(question: Question): { answer: Promise<string>; withdraw: () => void } {
    const id = String(this.nextId++);
    const answer = new Promise<string>((resolve) => {
      this.pending = { ...question, id, resolve };
    });
    this.dirty = true;
    return {
      answer,
      withdraw: () => {
        if (this.pending?.id === id) this.pending = undefined;
        this.dirty = true;
      },
    };
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
    this.broadcast();
    for (const client of this.clients) client.end();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** Everything the page shows. */
  snapshot(): Json {
    return {
      title: this.options.title,
      agents: this.options.agents as unknown as Json,
      plan: this.plan ?? null,
      question: this.pending ? { id: this.pending.id, kind: this.pending.kind, title: this.pending.title, body: this.pending.body ?? null } : null,
      details: Object.fromEntries(this.details),
      reports: this.reports,
      ...(this.state.snapshot() as Record<string, Json>),
    };
  }

  private broadcast(): void {
    this.dirty = false;
    const data = `data: ${JSON.stringify(this.snapshot())}\n\n`;
    for (const client of this.clients) client.write(data);
  }

  private authorised(url: URL, req: IncomingMessage): boolean {
    const given = Buffer.from(url.searchParams.get('t') ?? String(req.headers['x-dashboard-token'] ?? ''));
    const expected = Buffer.from(this.token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (status: number, type: string, body: string) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      res.end(body);
    };
    // Only this machine, and only someone who has the token printed on the terminal.
    if (!this.authorised(url, req)) return send(403, 'text/plain', 'Open the address printed on the terminal, including its token.');

    if (req.method === 'GET' && url.pathname === '/') {
      res.setHeader('content-security-policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:");
      return send(200, 'text/html; charset=utf-8', DASHBOARD_PAGE);
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(this.snapshot())}\n\n`);
      this.clients.add(res);
      req.on('close', () => this.clients.delete(res));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/report') {
      const name = basename(url.searchParams.get('name') ?? '');
      if (!this.reports.includes(name) || !this.options.reportsDir) return send(404, 'text/plain', 'No such report.');
      return send(200, 'text/plain; charset=utf-8', readFileSync(join(this.options.reportsDir, name), 'utf8'));
    }
    if (req.method === 'POST' && url.pathname === '/answer') {
      // A cross-site form cannot set this header, so only the page itself can answer.
      if (req.headers['content-type'] !== 'application/json') return send(415, 'text/plain', 'JSON only.');
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
        if (body.length > 10_000) req.destroy();
      });
      req.on('end', () => {
        let parsed: { id?: unknown; answer?: unknown };
        try { parsed = JSON.parse(body) as typeof parsed; } catch { return send(400, 'text/plain', 'Bad JSON.'); }
        const pending = this.pending;
        if (!pending || parsed.id !== pending.id || typeof parsed.answer !== 'string') return send(409, 'text/plain', 'That question is no longer open.');
        this.pending = undefined;
        this.dirty = true;
        pending.resolve(parsed.answer.slice(0, 2_000));
        send(200, 'application/json', '{"ok":true}');
      });
      return;
    }
    send(404, 'text/plain', 'Not found.');
  }
}
