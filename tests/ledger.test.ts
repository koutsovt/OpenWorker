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
    assert.deepEqual(reopened.verify(), { ok: true, count: 3 });
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
