// Enterprise knowledge: a read-only folder of documents, split into passages and
// indexed with SQLite full-text search. Nothing here writes to the folder.
// The index is rebuilt in memory at start, so it can never drift from the files.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface Passage {
  /** Path of the document relative to the knowledge folder, with forward slashes. */
  document: string;
  /** `p<n>`: the n-th passage of the document, counted from 1. */
  anchor: string;
  /** Nearest heading above the passage, if any. */
  heading: string;
  text: string;
  /** SHA-256 of the passage text. Lets a later reader detect that the source changed. */
  contentHash: string;
}

export interface SearchHit {
  document: string;
  anchor: string;
  heading: string;
  snippet: string;
}

const EXTENSIONS = ['.md', '.txt'];
const MAX_PASSAGE = 1600;

/** Paragraphs become passages; a heading starts a new one and labels those below it. */
function split(text: string): { heading: string; text: string }[] {
  const passages: { heading: string; text: string }[] = [];
  let heading = '';
  for (const block of text.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const title = /^#{1,6}\s+(.*)$/.exec(trimmed.split('\n')[0]!);
    if (title) heading = title[1]!.trim();
    // A heading on its own carries no content worth citing.
    if (title && !trimmed.includes('\n')) continue;
    for (let i = 0; i < trimmed.length; i += MAX_PASSAGE) passages.push({ heading, text: trimmed.slice(i, i + MAX_PASSAGE) });
  }
  return passages;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    if (entry.name.startsWith('.')) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.isFile() && EXTENSIONS.some((ext) => entry.name.endsWith(ext)) ? [path] : [];
  });
}

export class KnowledgeBase {
  private readonly db = new DatabaseSync(':memory:');
  private readonly passages = new Map<string, Passage>();
  readonly documents: string[] = [];

  /** A missing folder is an empty knowledge base, not an error. */
  constructor(dir: string | undefined) {
    this.db.exec("CREATE VIRTUAL TABLE passages USING fts5(text, heading, document UNINDEXED, anchor UNINDEXED, tokenize='porter unicode61')");
    if (!dir || !existsSync(dir)) return;
    const insert = this.db.prepare('INSERT INTO passages (text, heading, document, anchor) VALUES (?, ?, ?, ?)');
    for (const path of walk(dir)) {
      const document = relative(dir, path).split(sep).join('/');
      this.documents.push(document);
      split(readFileSync(path, 'utf8')).forEach((p, i) => {
        const passage: Passage = {
          document, anchor: `p${i + 1}`, heading: p.heading, text: p.text,
          contentHash: createHash('sha256').update(p.text).digest('hex'),
        };
        this.passages.set(`${document}#${passage.anchor}`, passage);
        insert.run(passage.text, passage.heading, document, passage.anchor);
      });
    }
  }

  /** Keyword search. Any word may match; passages matching more words rank higher. */
  search(query: string, limit = 5): SearchHit[] {
    // Words are quoted so that nothing in the query is read as search syntax.
    const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 24);
    if (!words.length) return [];
    const rows = this.db.prepare(
      "SELECT document, anchor, heading, snippet(passages, 0, '', '', ' … ', 40) AS snippet FROM passages WHERE passages MATCH ? ORDER BY bm25(passages) LIMIT ?",
    ).all(words.map((w) => `"${w}"`).join(' OR '), Math.min(Math.max(1, Math.trunc(limit)), 20));
    return rows.map((r) => ({ document: String(r.document), anchor: String(r.anchor), heading: String(r.heading), snippet: String(r.snippet) }));
  }

  read(document: string, anchor: string): Passage | undefined {
    return this.passages.get(`${document}#${anchor}`);
  }
}
