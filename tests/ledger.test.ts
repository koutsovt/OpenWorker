import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { AuditLedger } from '../src/audit/ledger.ts';

const newPath = () => join(mkdtempSync(join(tmpdir(), 'ledger-')), 'audit.sqlite');

describe('audit ledger', () => {
  it('chains records and verifies, across reopen', () => {
    const path = newPath();
    const ledger = new AuditLedger(path);
    const first = ledger.append('run.started', 'user:alice', { objective: 'assess' });
    const second = ledger.append('model.selected', 'system', { b: 2, a: 1 });
    assert.equal(first.prevHash, '0'.repeat(64));
    assert.equal(second.prevHash, first.hash);
    ledger.close();
    const reopened = new AuditLedger(path);
    reopened.append('run.completed', 'system', null);
    const verdict = reopened.verify();
    assert.equal(verdict.ok, true);
    assert.equal(verdict.ok && verdict.count, 3);
    assert.deepEqual(verdict.ok && verdict.head, { seq: 3, hash: reopened.records()[2]!.hash });
    assert.deepEqual(reopened.records()[1]!.data, { a: 1, b: 2 });
  });

  const tamper = (sql: string) => {
    const path = newPath();
    const ledger = new AuditLedger(path);
    for (const n of [1, 2, 3]) ledger.append('tool.called', 'agent:research#1', { n });
    ledger.close();
    const db = new DatabaseSync(path);
    db.exec(sql);
    db.close();
    return new AuditLedger(path).verify();
  };

  it('detects an edited record', () => {
    assert.deepEqual(tamper(`UPDATE audit SET data = '{"n":99}' WHERE seq = 2`), { ok: false, brokenAt: 2, reason: 'record content changed' });
  });
  it('detects a changed actor', () => {
    assert.equal(tamper(`UPDATE audit SET actor = 'user:mallory' WHERE seq = 1`).ok, false);
  });
  it('detects a deleted record', () => {
    assert.deepEqual(tamper('DELETE FROM audit WHERE seq = 2'), { ok: false, brokenAt: 2, reason: 'missing record' });
  });
  it('detects a record rewritten with a self-consistent hash', () => {
    // Replacing a record wholesale still breaks the next record's link.
    assert.equal(tamper(`UPDATE audit SET hash = '${'a'.repeat(64)}' WHERE seq = 1`).ok, false);
  });
});

describe('ledger anchors', () => {
  it('catches a ledger that was rewritten from scratch with a valid chain', () => {
    const path = newPath();
    const original = new AuditLedger(path);
    original.append('plan.approved', 'user:alice', { run: 'run-1' });
    original.append('tool.denied', 'agent:x', { tool: 'ops.write' });
    const anchor = original.head();
    original.append('run.finished', 'user:alice', { run: 'run-1' });
    assert.deepEqual(original.checkAnchors([anchor]), []);
    original.close();

    // Someone with the file drops the denial and rebuilds every hash. The chain alone looks fine.
    new DatabaseSync(path).exec('DELETE FROM audit');
    const forged = new AuditLedger(path);
    forged.append('plan.approved', 'user:alice', { run: 'run-1' });
    forged.append('run.finished', 'user:alice', { run: 'run-1' });
    assert.equal(forged.verify().ok, true);
    assert.match(forged.checkAnchors([anchor]).join(), /record 2: the ledger holds a different record than was anchored/);
    assert.match(forged.checkAnchors([{ seq: 9, hash: anchor.hash }]).join(), /no longer has that record/);
  });
});
