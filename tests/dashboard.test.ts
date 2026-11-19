// The dashboard server: only reachable with its token, pushes the run as it happens, takes an answer
// to the open question, and serves only this run's reports.
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { describe, it } from 'node:test';
import { DASHBOARD_PAGE } from '../src/cli/dashboard-page.ts';
import { Dashboard, firstAnswer } from '../src/cli/dashboard.ts';
import type { Json } from '../src/harness/port.ts';
import { platform } from './support/scenario-platform.ts';

/** Reads the event stream until `until` matches a snapshot, then closes it. */
const snapshotWhen = (url: string, until: (s: Record<string, Json>) => boolean): Promise<Record<string, Json>> => new Promise((resolve, reject) => {
  const req = get(url, (res) => {
    let buffer = '';
    res.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
        const message = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const snapshot = JSON.parse(message.replace(/^data: /, '')) as Record<string, Json>;
        if (until(snapshot)) {
          req.destroy();
          resolve(snapshot);
          return;
        }
      }
    });
  });
  req.on('error', (e) => (e.message.includes('aborted') || (e as NodeJS.ErrnoException).code === 'ECONNRESET' ? undefined : reject(e)));
});

describe('dashboard', () => {
  it('serves a page whose script is valid and escapes what the run says', () => {
    const script = DASHBOARD_PAGE.split('<script>')[1]!.split('</script>')[0]!;
    assert.doesNotThrow(() => new Function(script));
    assert.match(script, /const esc = /);
    assert.match(script, /Show more/);
  });

  // The first live run crashed here: the page answered, the terminal question was aborted, and the abort error won.
  it('takes the page\'s answer even though cancelling the terminal question throws', async () => {
    const terminal = (signal: AbortSignal) => new Promise<string>((_, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
    });
    let cancelled = false;
    const local = (signal: AbortSignal) => {
      signal.addEventListener('abort', () => { cancelled = true; });
      return terminal(signal);
    };
    assert.deepEqual(await firstAnswer(local, Promise.resolve('y')), { answer: 'y', from: 'dashboard' });
    assert.equal(cancelled, true);
    assert.deepEqual(await firstAnswer(async () => 'n', new Promise<string>(() => {})), { answer: 'n', from: 'terminal' });
    await assert.rejects(firstAnswer(async () => { throw new Error('stdin closed'); }), /stdin closed/);
  });

  it('refuses requests without the token, and shows the run live once it has it', async () => {
    const t = await platform();
    const dashboard: Dashboard = new Dashboard({
      ledger: t.ledger, title: 'OpenWorker · eforms', agents: [{ id: 'research', purpose: 'Gather evidence', rule: 'read-only' }],
      reportsDir: `${t.stateDir}/reports`, detail: (task): Json | undefined => t.store.tasks(dashboard.state.runId!).find((x) => x.id === task)?.result ?? undefined, port: 0,
    });
    const url = new URL(await dashboard.start());
    try {
      assert.equal((await fetch(`${url.origin}/`)).status, 403);
      assert.equal((await fetch(`${url.origin}/?t=wrong`)).status, 403);
      const page = await (await fetch(url)).text();
      assert.match(page, /<title>OpenWorker live<\/title>/);
      assert.doesNotMatch(page, /https?:\/\/(?!127\.0\.0\.1)/, 'the page loads nothing from elsewhere');

      const finished = snapshotWhen(`${url.origin}/events?t=${url.searchParams.get('t')}`, (s) => s.stage === 'done' && (s.reports as string[]).length === 2);
      const runId = await t.start();
      await t.orchestrator.execute(runId);
      const s = await finished;
      assert.equal(s.runId, runId);
      assert.deepEqual((s.tasks as { id: string; status: string }[]).map((x) => `${x.id}:${x.status}`), [
        'planning:done', 'evidence:done', 'architecture:done', 'security:done', 'data:done', 'costs:done',
        'assurance:done', 'architecture-rework:done', 'costs-rework:done', 'assurance-2:done', 'report:done',
      ]);
      assert.deepEqual(s.verdict, { task: 'assurance-2', verdict: 'pass', critical: 0, major: 0, minor: 1, independent: true });
      assert.match(JSON.stringify((s.details as Record<string, Json>).assurance), /no Australian region/);
      const kinds = (s.events as { kind: string }[]).map((e) => e.kind);
      for (const kind of ['PLAN', 'APPROVE', 'START', 'VERDICT', 'REWORK', 'REPORT', 'END']) assert.ok(kinds.includes(kind), kind);
      assert.ok((s.events as { kind: string; reason?: string }[]).filter((e) => e.kind === 'VERDICT').every((e) => e.reason), 'every verdict carries its reason');

      const token = url.searchParams.get('t')!;
      const brief = await fetch(`${url.origin}/report?t=${token}&name=${runId}.md`);
      assert.equal(brief.status, 200);
      assert.match(await brief.text(), /Research Ethics eForms/);
      assert.equal((await fetch(`${url.origin}/report?t=${token}&name=../audit.sqlite`)).status, 404);
    } finally {
      await dashboard.stop();
    }
  });

  it('takes the answer to the open question from the page, once, and only as JSON', async () => {
    const t = await platform();
    const dashboard = new Dashboard({ ledger: t.ledger, title: 'x', agents: [], port: 0 });
    const url = new URL(await dashboard.start());
    const token = url.searchParams.get('t')!;
    const post = (body: string, type = 'application/json') => fetch(`${url.origin}/answer?t=${token}`, { method: 'POST', headers: { 'content-type': type }, body });
    try {
      const question = dashboard.ask({ kind: 'confirm', title: 'Approve this plan?' });
      const shown = await snapshotWhen(`${url.origin}/events?t=${token}`, (s) => s.question !== null);
      const id = (shown.question as { id: string }).id;
      assert.equal((await post(`id=${id}&answer=y`, 'application/x-www-form-urlencoded')).status, 415, 'a plain form from another site cannot answer');
      assert.equal((await post(JSON.stringify({ id: 'other', answer: 'y' }))).status, 409);
      assert.equal((await post(JSON.stringify({ id, answer: 'y' }))).status, 200);
      assert.equal(await question.answer, 'y');
      assert.equal((await post(JSON.stringify({ id, answer: 'n' }))).status, 409, 'an answered question is closed');
      assert.equal(dashboard.snapshot() && (dashboard.snapshot() as { question: Json }).question, null);

      // Answered on the terminal instead: the question is withdrawn from the page.
      const second = dashboard.ask({ kind: 'text', title: 'Override?' });
      second.withdraw();
      assert.equal((dashboard.snapshot() as { question: Json }).question, null);
    } finally {
      await dashboard.stop();
    }
  });
});
