// Durable platform state: evidence records and project memory, in one SQLite file
// shared with the run store. Agents never write here directly; tools and the
// orchestrator do, and each write is also recorded in the audit ledger by the caller.
import { DatabaseSync } from 'node:sqlite';
import type { Json } from '../harness/port.ts';

export function openState(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  // Survive a second process opening the same file (for example a resume while an old process is dying).
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

export interface EvidenceRecord {
  /** `ev-<n>`, unique within the state file. */
  id: string;
  /** The orchestrated run it was gathered for, or `adhoc` for a single agent run. */
  runId: string;
  document: string;
  anchor: string;
  contentHash: string;
  /** The agent instance that first retrieved the passage. */
  retrievedBy: string;
  retrievedAt: string;
}

/** Evidence is a first-class record: what was read, from where, by whom, and a hash of what it said. */
export class EvidenceStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS evidence (
      seq INTEGER PRIMARY KEY, run_id TEXT NOT NULL, document TEXT NOT NULL, anchor TEXT NOT NULL,
      content_hash TEXT NOT NULL, retrieved_by TEXT NOT NULL, retrieved_at TEXT NOT NULL,
      UNIQUE (run_id, document, anchor, content_hash))`);
  }

  /** Records a retrieval. The same passage with the same content in the same run keeps its first record. */
  record(entry: Omit<EvidenceRecord, 'id' | 'retrievedAt'>): { record: EvidenceRecord; created: boolean } {
    const existing = this.db.prepare('SELECT * FROM evidence WHERE run_id = ? AND document = ? AND anchor = ? AND content_hash = ?')
      .get(entry.runId, entry.document, entry.anchor, entry.contentHash);
    if (existing) return { record: toRecord(existing), created: false };
    const at = new Date().toISOString();
    const { lastInsertRowid } = this.db.prepare(
      'INSERT INTO evidence (run_id, document, anchor, content_hash, retrieved_by, retrieved_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(entry.runId, entry.document, entry.anchor, entry.contentHash, entry.retrievedBy, at);
    return { record: { ...entry, id: `ev-${lastInsertRowid}`, retrievedAt: at }, created: true };
  }

  /** A record is visible only inside the run it was gathered for. */
  get(id: string, runId: string): EvidenceRecord | undefined {
    const seq = /^ev-(\d+)$/.exec(id)?.[1];
    if (!seq) return undefined;
    const row = this.db.prepare('SELECT * FROM evidence WHERE seq = ? AND run_id = ?').get(Number(seq), runId);
    return row ? toRecord(row) : undefined;
  }

  list(runId: string): EvidenceRecord[] {
    return this.db.prepare('SELECT * FROM evidence WHERE run_id = ? ORDER BY seq').all(runId).map(toRecord);
  }
}

function toRecord(row: Record<string, unknown>): EvidenceRecord {
  return {
    id: `ev-${row.seq}`, runId: String(row.run_id), document: String(row.document), anchor: String(row.anchor),
    contentHash: String(row.content_hash), retrievedBy: String(row.retrieved_by), retrievedAt: String(row.retrieved_at),
  };
}

export type MemoryKind = 'objective' | 'decision' | 'artefact' | 'open_question';

export interface MemoryEntry {
  kind: MemoryKind;
  /** For an artefact, the id of the task that produced it. */
  key: string;
  content: Json;
  at: string;
}

/** Project memory for a run. Only orchestrator code writes; agents read through the `project.read` tool. */
export class ProjectMemory {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS project_memory (
      run_id TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, content TEXT NOT NULL, at TEXT NOT NULL,
      PRIMARY KEY (run_id, kind, key))`);
  }

  /** Writing the same kind and key again replaces the entry, so a re-run task leaves one artefact. */
  put(runId: string, kind: MemoryKind, key: string, content: Json): void {
    this.db.prepare('INSERT OR REPLACE INTO project_memory (run_id, kind, key, content, at) VALUES (?, ?, ?, ?, ?)')
      .run(runId, kind, key, JSON.stringify(content), new Date().toISOString());
  }

  entries(runId: string, kind?: MemoryKind): MemoryEntry[] {
    const rows = this.db.prepare('SELECT kind, key, content, at FROM project_memory WHERE run_id = ? ORDER BY at, key').all(runId);
    return rows
      .map((r) => ({ kind: String(r.kind) as MemoryKind, key: String(r.key), content: JSON.parse(String(r.content)) as Json, at: String(r.at) }))
      .filter((e) => !kind || e.kind === kind);
  }
}
