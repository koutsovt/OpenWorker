import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuditLedger } from '../src/audit/ledger.ts';
import { formatUsage, usageReport } from '../src/audit/usage.ts';
import { platform } from './support/scenario-platform.ts';

describe('cost and usage report', () => {
  const ledger = new AuditLedger(':memory:');
  const instance = (id: string, run: string | null, task: string | null) => ledger.append('agent.instantiated', 'user:a', { instance: id, agent: 'worker', run, task });
  const usage = (id: string | null, model: string, costUsd: number | null, usageComplete = true) =>
    ledger.append('model.usage', 'agent:x', { instance: id, model, modelCalls: 2, inputTokens: 1000, outputTokens: 100, usageComplete, costUsd });
  instance('i1', 'run-1', 'a'); instance('i2', 'run-1', 'b'); instance('i3', 'run-2', 'a'); instance('i4', null, null);
  usage('i1', 'priced', 0.5); usage('i2', 'priced', 0.25); usage('i2', 'unpriced', null); usage('i3', 'priced', null, false); usage('i4', 'priced', 0.1); usage(null, 'priced', 0.05);

  it('totals by model and by run, and counts unknown cost apart from zero', () => {
    const report = usageReport(ledger.records());
    const priced = report.byModel.find((r) => r.key === 'priced')!;
    assert.deepEqual([priced.sessions, priced.inputTokens, priced.unpriced, priced.incomplete], [5, 5000, 1, 1]);
    assert.ok(Math.abs(priced.costUsd - 0.9) < 1e-9);
    assert.deepEqual(report.byRun.map((r) => [r.key, r.sessions]), [['run-1', 3], ['run-2', 1], ['(not part of a run)', 2]]);
    assert.equal(report.total.sessions, 6);
    assert.equal(report.total.unpriced, 2);
  });

  it('breaks one run down by task', () => {
    const report = usageReport(ledger.records(), { runId: 'run-1' });
    assert.deepEqual(report.byTask!.map((r) => [r.key, r.sessions, r.unpriced]), [['a', 1, 0], ['b', 2, 1]]);
    assert.equal(report.total.modelCalls, 6);
  });

  it('prints unknown, never zero, when no session has a price', () => {
    const text = formatUsage('model', usageReport(ledger.records()).byModel, (k) => (k === 'unpriced' ? 'note' : ''));
    assert.match(text, /unpriced\s+1\s+2\s+1000\s+100\s+unknown\s+note/);
    assert.match(text, /priced\s+5\s+10\s+5000\s+500\s+0\.9000 \+ 1 unpriced\s+1 with incomplete usage/);
  });

  it('accounts for every model session of a real orchestrated run', async () => {
    const t = await platform();
    const runId = await t.start();
    await t.orchestrator.execute(runId);
    const report = usageReport(t.ledger.records(), { runId });
    assert.deepEqual(report.byTask!.map((r) => r.key).sort(), ['architecture', 'architecture-rework', 'assurance', 'assurance-2', 'costs', 'costs-rework', 'data', 'evidence', 'report', 'security']);
    assert.deepEqual(report.byModel.map((r) => [r.key, r.sessions]), [['claude-author', 8], ['openai-assurance', 2]]);
    // The planner ran before the run existed, so it is outside the run's total but inside the ledger's.
    assert.equal(usageReport(t.ledger.records()).total.sessions, report.total.sessions + 1);
    assert.equal(report.total.unpriced, report.total.sessions);
  });
});
