// Append-only audit ledger. Each record is hash-chained to the previous one, so an edit,
// deletion or reordering inside the chain is detectable by `verify()`. Deleting records from
// the end leaves a valid chain, so the latest seq and hash (the head) are also kept in their own
// table, written in the same transaction. That stops a careless truncation; someone who can
// rewrite the file can rewrite the head too, so for real assurance record `head()` somewhere
// else (the final report prints it) and pass it to `verify()` later.
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Json } from '../harness/port.ts';

export interface AuditRecord {
  seq: number;
  at: string;
  /** Dotted event type, e.g. `model.selected`, `tool.denied`. */
  type: string;
  /** Who acted: `user:<id>`, `agent:<instance>` or `system`. */
  actor: string;
  data: Json;
  prevHash: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);

/** Stable serialisation: object keys sorted at every level. */
function canonical(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k]!)}`).join(',')}}`;
}

function hashOf(r: Omit<AuditRecord, 'hash'>): string {
  return createHash('sha256')
    .update(canonical({ seq: r.seq, at: r.at, type: r.type, actor: r.actor, data: r.data, prevHash: r.prevHash }))
    .digest('hex');
}

export interface LedgerHead {
  seq: number;
  hash: string;
}

export type Verification =
  | { ok: true; count: number; head: LedgerHead }
  | { ok: false; brokenAt: number; reason: string };

export class AuditLedger {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS audit (
      seq INTEGER PRIMARY KEY, at TEXT NOT NULL, type TEXT NOT NULL, actor TEXT NOT NULL,
      data TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL)`);
    this.db.exec('CREATE TABLE IF NOT EXISTS head (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL, hash TEXT NOT NULL)');
    // A ledger written before the head table existed adopts its current last record.
    this.db.exec('INSERT OR IGNORE INTO head (id, seq, hash) SELECT 1, seq, hash FROM audit ORDER BY seq DESC LIMIT 1');
  }

  /** The latest record's seq and hash; genesis for an empty ledger. Record it elsewhere to detect truncation later. */
  head(): LedgerHead {
    const row = this.db.prepare('SELECT seq, hash FROM head WHERE id = 1').get() as LedgerHead | undefined;
    return row ? { seq: row.seq, hash: row.hash } : { seq: 0, hash: GENESIS };
  }

  append(type: string, actor: string, data: Json): AuditRecord {
    const last = this.db.prepare('SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1').get() as
      | { seq: number; hash: string } | undefined;
    const partial = {
      seq: (last?.seq ?? 0) + 1, at: new Date().toISOString(), type, actor, data, prevHash: last?.hash ?? GENESIS,
    };
    const record = { ...partial, hash: hashOf(partial) };
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO audit (seq, at, type, actor, data, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(record.seq, record.at, record.type, record.actor, canonical(record.data), record.prevHash, record.hash);
      this.db.prepare('INSERT OR REPLACE INTO head (id, seq, hash) VALUES (1, ?, ?)').run(record.seq, record.hash);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return record;
  }

  records(): AuditRecord[] {
    const rows = this.db.prepare('SELECT * FROM audit ORDER BY seq').all() as unknown as {
      seq: number; at: string; type: string; actor: string; data: string; prev_hash: string; hash: string;
    }[];
    return rows.map((r) => ({
      seq: r.seq, at: r.at, type: r.type, actor: r.actor, data: JSON.parse(r.data) as Json, prevHash: r.prev_hash, hash: r.hash,
    }));
  }

  /**
   * Returns the first broken sequence number, or `ok` with the head. `expect` is a head recorded
   * earlier, outside this file: the chain must still contain that exact record.
   */
  verify(expect?: LedgerHead): Verification {
    let prev = GENESIS;
    let expected = 1;
    const all = this.records();
    for (const r of all) {
      if (r.seq !== expected) return { ok: false, brokenAt: expected, reason: 'missing record' };
      if (r.prevHash !== prev) return { ok: false, brokenAt: r.seq, reason: 'chain link mismatch' };
      if (hashOf(r) !== r.hash) return { ok: false, brokenAt: r.seq, reason: 'record content changed' };
      prev = r.hash;
      expected++;
    }
    const head = this.head();
    const last = all.at(-1);
    if ((last?.seq ?? 0) !== head.seq || (last?.hash ?? GENESIS) !== head.hash)
      return { ok: false, brokenAt: Math.min(expected, head.seq), reason: 'records missing from the end (head mismatch)' };
    if (expect) {
      const anchored = expect.seq === 0 ? expect.hash === GENESIS : all[expect.seq - 1]?.hash === expect.hash;
      if (!anchored) return { ok: false, brokenAt: expect.seq, reason: 'does not contain the expected head' };
    }
    return { ok: true, count: all.length, head };
  }

  close(): void {
    this.db.close();
  }
}
