// Append-only audit ledger. Each record is hash-chained to the previous one,
// so any edit, deletion or reordering is detectable by `verify()`.
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

export class AuditLedger {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS audit (
      seq INTEGER PRIMARY KEY, at TEXT NOT NULL, type TEXT NOT NULL, actor TEXT NOT NULL,
      data TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL)`);
  }

  append(type: string, actor: string, data: Json): AuditRecord {
    const last = this.db.prepare('SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1').get() as
      | { seq: number; hash: string } | undefined;
    const partial = {
      seq: (last?.seq ?? 0) + 1, at: new Date().toISOString(), type, actor, data, prevHash: last?.hash ?? GENESIS,
    };
    const record = { ...partial, hash: hashOf(partial) };
    this.db.prepare('INSERT INTO audit (seq, at, type, actor, data, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(record.seq, record.at, record.type, record.actor, canonical(record.data), record.prevHash, record.hash);
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

  /** Returns the first broken sequence number, or `ok`. */
  verify(): { ok: true; count: number } | { ok: false; brokenAt: number; reason: string } {
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
    return { ok: true, count: all.length };
  }

  close(): void {
    this.db.close();
  }
}
