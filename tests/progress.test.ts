// The live progress view follows the audit ledger. Run the scripted scenario with it attached and check
// what a person would see, both as a redrawn terminal block and as plain lines in a log.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AuditLedger } from '../src/audit/ledger.ts';
import { LiveProgress } from '../src/cli/progress.ts';
import { platform } from './support/scenario-platform.ts';

const capture = (isTTY: boolean) => {
  const out = { text: '', columns: 160, isTTY, write(s: string) { out.text += s; return true; } };
  return out;
};
// What is on screen once cursor-up and erase codes are applied: the permanent lines plus the last block.
const screen = (text: string): string[] => {
  const lines: string[] = [];
  for (const part of text.split(/(\x1b\[\d+A\x1b\[J)/)) {
    const up = /\x1b\[(\d+)A\x1b\[J/.exec(part);
    if (up) lines.splice(lines.length - Number(up[1]));
    else lines.push(...part.split('\n').filter((l, i, all) => i < all.length - 1 || l));
  }
  return lines;
};

describe('live progress', () => {
  it('shows planning, each task, the verdicts and the rework on a terminal', async () => {
    const out = capture(true);
    const t = await platform();
    const progress = new LiveProgress('OpenWorker · eforms', { out: out as unknown as NodeJS.WriteStream, color: false }).follow(t.ledger);
    const runId = await t.start();
    progress.seed(t.store.tasks(runId).map((x) => ({ id: x.id, agent: x.agent })));
    await t.orchestrator.execute(runId);
    progress.stop();

    const shown = screen(out.text);
    assert.ok(shown.includes('! assurance verdict: conditional (0 critical, 1 major, 1 minor)'), shown.join('\n'));
    assert.ok(shown.some((l) => l === '↻ Rework requested for architecture (costs redone too, because they depend on it)'));
    assert.ok(shown.includes('✓ assurance-2 verdict: pass (0 critical, 0 major, 1 minor)'));
    assert.ok(shown.some((l) => l.startsWith('✓ Report written')));
    const block = shown.slice(shown.findIndex((l) => l.startsWith('■ OpenWorker · eforms')));
    assert.match(block[0]!, /11\/11 done/);
    assert.match(block.find((l) => l.includes(' planning '))!, /✓ planning +orchestrator .* 5 tasks proposed/);
    assert.match(block.find((l) => l.includes(' evidence '))!, /✓ evidence +research .*6 tool calls, 3 passages read/);
    for (const id of ['architecture-rework', 'costs-rework', 'assurance-2', 'report']) assert.ok(block.some((l) => l.includes(`✓ ${id} `)), id);
  });

  it('prints one line per event when the output is not a terminal', async () => {
    const out = capture(false);
    const t = await platform();
    const progress = new LiveProgress('OpenWorker', { out: out as unknown as NodeJS.WriteStream }).follow(t.ledger);
    await t.orchestrator.execute(await t.start(' BAD-CITATION'));
    progress.stop();
    assert.doesNotMatch(out.text, /\x1b/);
    assert.match(out.text, /↻ security sent back; trying again \(invalid_result\)/);
    assert.match(out.text, /^ {2}✓ security +security .*attempt 2/m);
    assert.match(out.text, /^ {2}✓ report +orchestrator/m);
  });

  it('never lets a display error reach the audit trail', () => {
    const ledger = new AuditLedger(join(mkdtempSync(join(tmpdir(), 'progress-')), 'audit.sqlite'));
    ledger.onAppend(() => { throw new Error('display broke'); });
    ledger.append('test.event', 'system', {});
    assert.equal(ledger.verify().ok, true);
    assert.equal(ledger.records().length, 1);
  });

  it('puts anything else written to the same stream above the block, and leaves no stale lines', () => {
    const out = capture(true);
    const ledger = new AuditLedger(join(mkdtempSync(join(tmpdir(), 'progress-')), 'audit.sqlite'));
    const progress = new LiveProgress('OpenWorker', { out: out as unknown as NodeJS.WriteStream, color: false })
      .seed([{ id: 'evidence', agent: 'research' }]).follow(ledger);
    out.write('warning from the engine\n');
    out.write('\n');
    progress.stop();
    const shown = screen(out.text);
    assert.deepEqual(shown.slice(0, 2), ['warning from the engine', '']);
    assert.equal(shown.filter((l) => l.includes('OpenWorker')).length, 1, shown.join('\n'));
    out.write('after\n');
    assert.equal(screen(out.text).at(-1), 'after');
  });

  it('clears itself for a question and draws again after', () => {
    const out = capture(true);
    const progress = new LiveProgress('OpenWorker', { out: out as unknown as NodeJS.WriteStream, color: false }).seed([{ id: 'evidence', agent: 'research' }]);
    progress.pause();
    assert.deepEqual(screen(out.text), []);
    assert.equal(progress.isPaused, true);
    progress.resume();
    assert.match(screen(out.text).join('\n'), /· evidence +research +waiting/);
    progress.stop();
    progress.stop();
  });
});
