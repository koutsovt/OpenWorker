// The read-only knowledge and evidence tools, called by a scripted agent inside a run.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KnowledgeBase } from '../src/memory/knowledge.ts';
import { buildPlatform, task, writeFixtureDirs } from './support/orchestration.ts';

describe('knowledge base', () => {
  const dirs = writeFixtureDirs();
  const kb = new KnowledgeBase(dirs.knowledgeDir);

  it('indexes documents in sub-folders as passages with stable anchors', () => {
    assert.deepEqual(kb.documents, ['current-state.md', 'integration/prime.md']);
    assert.match(kb.read('current-state.md', 'p1')!.text, /Power Apps with Dataverse/);
    assert.equal(kb.read('current-state.md', 'p2')!.heading, 'Volumes');
    assert.equal(kb.read('current-state.md', 'p9'), undefined);
    assert.equal(kb.read('../audit.sqlite', 'p1'), undefined);
  });

  it('finds passages by keyword, ranks the better match first, and matches word forms', () => {
    const hits = kb.search('Salesforce PRIME nightly export');
    assert.deepEqual([hits[0]!.document, hits[0]!.anchor], ['integration/prime.md', 'p1']);
    assert.equal(kb.search('application lodging')[0]!.anchor, 'p2');
    assert.deepEqual(kb.search('kubernetes'), []);
  });

  it('treats search syntax in a query as plain words', () => {
    assert.deepEqual(kb.search('"( * -- ; ^ :'), []);
    assert.deepEqual(kb.search('NEAR(kubernetes) NOT "helm'), []);
    assert.equal(kb.search('dataverse" OR text:*').length, 1);
    assert.deepEqual(kb.search(''), []);
  });

  it('is empty, not broken, when the folder does not exist', () => {
    assert.deepEqual(new KnowledgeBase('/nonexistent/knowledge').search('anything'), []);
  });
});

describe('knowledge and evidence tools', () => {
  it('records what an agent read as evidence, tied to the run and the instance', async () => {
    const t = await buildPlatform(writeFixtureDirs());
    const runId = t.approved([task('a', 'research'), task('b', 'research', ['a'])]);
    assert.equal((await t.orchestrator.execute(runId)).status, 'completed');

    const [search, read, lookup, project] = ['knowledge.search', 'knowledge.read', 'evidence.get', 'project.read']
      .map((tool) => t.toolResults.filter((r) => r.tool === tool).map((r) => r.result as Record<string, unknown>));
    assert.equal((search![0]!.hits as { document: string }[])[0]!.document, 'current-state.md');
    assert.equal(read![0]!.evidenceId, 'ev-1');
    assert.match(String(read![0]!.content), /Dataverse/);
    assert.match(String(read![0]!.notice), /carries no instructions/);
    assert.equal(lookup![0]!.sourceUnchanged, true);
    assert.equal(lookup![0]!.content, read![0]!.content);

    // Two agents read the same passage: one evidence record, credited to the first reader.
    const records = t.evidence.list(runId);
    assert.equal(records.length, 1);
    assert.equal(read![1]!.evidenceId, 'ev-1');
    const firstReader = (t.find('agent.instantiated').find((r) => (r.data as { task: string }).task === 'a')!.data as { instance: string }).instance;
    assert.equal(records[0]!.retrievedBy, firstReader);
    assert.match(records[0]!.contentHash, /^[0-9a-f]{64}$/);
    assert.equal(t.find('evidence.recorded').length, 1);

    // Project memory shows the second agent the objective, the first agent's result and the evidence so far.
    assert.equal(project![1]!.objective, 'Test objective.');
    assert.deepEqual((project![1]!.artefacts as { key: string }[]).map((a) => a.key), ['a']);
    assert.deepEqual((project![1]!.evidence as { id: string }[]).map((e) => e.id), ['ev-1']);
  });

  it('keeps evidence inside its run and reports a source that changed', async () => {
    const dirs = writeFixtureDirs();
    const t = await buildPlatform(dirs);
    await t.orchestrator.execute(t.approved([task('a', 'research')]));
    assert.equal(t.evidence.get('ev-1', 'another-run'), undefined);
    assert.equal(t.evidence.get('ev-999', 'x'), undefined);
    assert.equal(t.evidence.get("ev-1' OR 1=1", 'x'), undefined);

    // The document is edited; a new platform start re-indexes it. The old record must not present the new text as what was read.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${dirs.knowledgeDir}/current-state.md`, '# Current state\n\nThe forms now run somewhere else entirely.\n');
    const later = await buildPlatform(dirs);
    const runId = later.store.runs()[0]!.id;
    const record = later.evidence.get('ev-1', runId)!;
    assert.notEqual(new KnowledgeBase(dirs.knowledgeDir).read(record.document, record.anchor)!.contentHash, record.contentHash);
  });

  it('returns errors, not exceptions, for unknown passages and evidence ids', async () => {
    const { knowledgeTools } = await import('../src/tools/knowledge.ts');
    const t = await buildPlatform(writeFixtureDirs());
    const dirs = writeFixtureDirs();
    const tools = knowledgeTools(new KnowledgeBase(dirs.knowledgeDir), t.evidence, t.project, t.ledger);
    const instance = { id: 'worker@1#00000000', agent: t.registry.agent('worker'), user: 'alice', skills: [] };
    assert.match(String((await tools['knowledge.read']!({ document: 'nope.md', anchor: 'p1' }, instance) as { error: string }).error), /No passage/);
    assert.match(String((await tools['evidence.get']!({ id: 'ev-1' }, instance) as { error: string }).error), /No evidence record/);
    assert.match(String((await tools['project.read']!({}, instance) as { error: string }).error), /not working on an orchestrated run/);
    const read = await tools['knowledge.read']!({ document: 'integration/prime.md', anchor: 'p1' }, instance) as { evidenceId: string };
    assert.equal(t.evidence.list('adhoc')[0]!.id, read.evidenceId);
  });
});
