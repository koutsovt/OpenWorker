// Evaluation and improvement: every benchmark scenario has an answer key; a run is graded against it in code
// and by the evaluator agent; two scorecards are compared; and a run's problems are traced to the agent and
// skill versions behind them, with changes drafted to the proposals folder and never to the registry.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  AnswerKeyError, compareScorecards, findScorecard, listScorecards, loadAnswerKey, renderComparison, RunEvaluator, runRecords, type Scorecard,
} from '../src/evaluation/evaluate.ts';
import { gatherSignals, Improver } from '../src/evaluation/improve.ts';
import type { Json } from '../src/harness/port.ts';
import { platform, scenarioDir, script, submit } from './support/scenario-platform.ts';

const scenarios = readdirSync(resolve('scenarios'), { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(resolve('scenarios', d.name, 'objective.md'))).map((d) => resolve('scenarios', d.name));
const keyIn = (yaml: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'key-'));
  writeFileSync(join(dir, 'eval.yaml'), yaml);
  return dir;
};

describe('answer keys', () => {
  it('exist and are valid for every scenario, and stay outside what the agents read', () => {
    assert.ok(scenarios.length >= 4);
    for (const dir of scenarios) {
      const key = loadAnswerKey(dir);
      assert.ok(key.checks.some((c) => c.judge), `${dir} has a criterion for the evaluator`);
      assert.ok(key.checks.some((c) => c.critical), `${dir} has a critical check`);
      assert.equal(existsSync(join(dir, 'knowledge', 'eval.yaml')), false);
    }
  });

  it('refuses a scenario without one, and keys that are malformed', () => {
    assert.throws(() => loadAnswerKey(mkdtempSync(join(tmpdir(), 'none-'))), (e: unknown) => e instanceof AnswerKeyError && /has no answer key/.test(e.message));
    assert.throws(() => loadAnswerKey(keyIn('scenario: x\nchecks:\n  - { id: a, about: x, judge: y, text: { in: brief, matches: z } }\n')), /exactly one of/);
    assert.throws(() => loadAnswerKey(keyIn('scenario: x\nchecks:\n  - { id: a, about: x, text: { in: brief, absent: "(" } }\n')), /Invalid regular expression/);
    assert.throws(() => loadAnswerKey(keyIn('scenario: x\nchecks:\n  - { id: a, about: x, judge: y }\n  - { id: a, about: x, judge: y }\n')), /appears twice/);
    assert.throws(() => loadAnswerKey(keyIn('scenario: x\nchecks:\n  - { id: a, about: x, ledger: { event: tool.denied } }\n')), /needs min or max/);
    assert.throws(() => loadAnswerKey(keyIn('scenario: x\nchecks:\n  - { id: a, about: x, judge: y, extra: 1 }\n')), /Unrecognized key/);
  });
});

/** A finished run of the eForms scenario on the scripted model, ready to grade. */
const finishedRun = async (judge?: (n: number, input: string) => Json) => {
  const t = await platform({
    script: (model, n, input) => {
      if (judge && input.startsWith('Grade the finished run')) return judge(n, input) as never;
      if (input.startsWith('Find what in the agents')) return (retrospective?.(n, input) ?? { text: 'Done.' }) as never;
      return script(model, n, input);
    },
  });
  let retrospective: ((n: number, input: string) => Json) | undefined;
  const runId = await t.start();
  await t.orchestrator.execute(runId);
  const evidence = () => ({
    run: t.store.run(runId)!, tasks: t.store.tasks(runId), records: runRecords(t.ledger.records(), runId),
    brief: readFileSync(t.orchestrator.reportPath(runId)!, 'utf8'), appendix: readFileSync(t.orchestrator.appendixPath(runId)!, 'utf8'),
  });
  return { t, runId, evidence, setRetrospective: (f: typeof retrospective) => { retrospective = f; } };
};

const grades = (ids: string[], verdict = 'pass') => ({ summary: 'Graded.', checks: ids.map((id) => ({ id, verdict, reason: `Section on ${id}.` })) });

describe('eval', () => {
  it('grades a run in code and by the evaluator, sending back a result that skips a criterion, and saves the scorecard', async () => {
    const criteria = ['residency', 'prime', 'deliverables', 'silent-documents'];
    const { t, runId, evidence } = await finishedRun((n, input) => [
      submit(input.includes('previous result was rejected') ? grades(criteria) : grades(criteria.slice(1)) as unknown as Record<string, Json>),
    ][n] ?? { text: 'Submitted.' });
    const evalsDir = join(t.stateDir, 'evals');
    const evaluator = new RunEvaluator({ workforce: t.workforce, ledger: t.ledger, results: t.results }, { evalsDir, registryDir: resolve('registry') });
    const { scorecard, path } = await evaluator.evaluate({ user: 'local', scenarioDir, key: loadAnswerKey(scenarioDir), objective: 'x', evidence: evidence() });

    assert.equal(scorecard.runId, runId);
    assert.deepEqual(scorecard.checks.map((c) => `${c.id}:${c.status}`), ['completed:pass', 'review-passed:pass', ...criteria.map((c) => `${c}:pass`)]);
    assert.equal(scorecard.score.percent, 100);
    assert.equal(scorecard.judge.status, 'completed');
    assert.match(JSON.stringify(t.find('eval.judge_rejected')[0]!.data), /criteria not graded: residency/);
    assert.equal(scorecard.versions.agents['solution-architecture'], 1);
    assert.equal(scorecard.versions.skills['hosting-architecture-review'], '1.0.0');
    assert.match(scorecard.lockDigest!, /^[0-9a-f]{64}$/);
    assert.ok(existsSync(path) && existsSync(path.replace(/\.json$/, '.md')));
    assert.equal(t.find('eval.completed').length, 1);
    assert.ok(scorecard.usage.modelCalls > 0, 'model usage is counted for the graded run');
    // The evaluator never reads the knowledge folder and works under its own id, not the graded run's.
    const judged = t.find('agent.instantiated').filter((r) => (r.data as { agent: string }).agent === 'evaluator');
    assert.ok(judged.every((r) => String((r.data as { run: string }).run).startsWith('eval-')));
    assert.ok(t.inputs.find((i) => i.startsWith('Grade the finished run'))!.includes('<brief>'));
  });

  it('fails the judged criteria when the evaluator cannot grade, and grades code checks alone with --no-judge', async () => {
    const { t, evidence } = await finishedRun(() => submit({ summary: 'x', checks: [] }));
    const evaluator = new RunEvaluator({ workforce: t.workforce, ledger: t.ledger, results: t.results }, { evalsDir: join(t.stateDir, 'evals'), registryDir: resolve('registry') });
    const failed = (await evaluator.evaluate({ user: 'local', scenarioDir, key: loadAnswerKey(scenarioDir), objective: 'x', evidence: evidence() })).scorecard;
    assert.equal(failed.judge.status, 'failed');
    assert.deepEqual(failed.checks.filter((c) => c.kind === 'judge').map((c) => c.status), ['skipped', 'skipped', 'skipped', 'skipped']);
    assert.equal(t.find('eval.judge_failed').length, 1);

    const codeOnly = (await evaluator.evaluate({ user: 'local', scenarioDir, key: loadAnswerKey(scenarioDir), objective: 'x', evidence: evidence(), judge: false })).scorecard;
    assert.equal(codeOnly.judge.status, 'skipped');
    assert.equal(codeOnly.score.graded, 2);
  });

  it('checks the ledger only for the run being graded, and text in the report', async () => {
    const { t, evidence } = await finishedRun();
    const key = loadAnswerKey(keyIn([
      'scenario: x', 'checks:',
      '  - { id: reads, about: x, ledger: { event: tool.called, where: { tool: knowledge.read }, min: 3, max: 3 } }',
      '  - { id: none-denied, about: x, ledger: { event: tool.denied, max: 0 } }',
      '  - { id: residency, about: x, critical: true, text: { in: brief, matches: "residency" } }',
      '  - { id: no-railway-claim, about: x, critical: true, text: { in: both, absent: "unmet on the managed host" } }',
    ].join('\n')));
    // A second run in the same ledger must not be counted.
    await t.orchestrator.execute(await t.start());
    const evaluator = new RunEvaluator({ workforce: t.workforce, ledger: t.ledger, results: t.results }, { evalsDir: join(t.stateDir, 'evals'), registryDir: resolve('registry') });
    const card = (await evaluator.evaluate({ user: 'local', scenarioDir, key, objective: 'x', evidence: evidence() })).scorecard;
    assert.deepEqual(card.checks.map((c) => `${c.id}:${c.status}`), ['reads:pass', 'none-denied:pass', 'residency:pass', 'no-railway-claim:fail']);
    assert.match(card.checks[3]!.detail, /found "unmet on the managed host" in the report: …/);
    assert.deepEqual(card.score.criticalFailed, ['no-railway-claim']);
  });
});

describe('scorecard comparison', () => {
  const card = (id: string, statuses: Record<string, 'pass' | 'fail'>, extra: Partial<Scorecard> = {}): Scorecard => {
    const checks = Object.entries(statuses).map(([c, status]) => ({ id: c, about: c, kind: 'judge' as const, critical: c === 'answer', weight: 1, status, detail: '' }));
    const passed = checks.filter((c) => c.status === 'pass').length;
    return {
      id, scenario: 'S', scenarioDir: 's', at: `2026-11-1${id.slice(-1)}T00:00:00Z`, runId: `run-${id}`, runStatus: 'completed',
      git: { commit: 'abc', branch: 'main', registryChanged: false }, lockDigest: 'lock-a',
      versions: { agents: { research: 1 }, skills: { 'evidence-verification': '1.0.0' } }, checks,
      score: { passed, graded: checks.length, weightPassed: passed, weightGraded: checks.length, percent: Math.round((passed / checks.length) * 100), criticalFailed: checks.filter((c) => c.critical && c.status !== 'pass').map((c) => c.id) },
      usage: { modelCalls: 10, inputTokens: 1000, outputTokens: 100, costUsd: null }, judge: { status: 'completed', summary: '', problems: [] }, ...extra,
    };
  };

  it('calls a new version better, worse or mixed, and says when nothing but the model changed', () => {
    const base = card('e1', { answer: 'fail', cited: 'pass', tone: 'pass' });
    const fixed = card('e2', { answer: 'pass', cited: 'pass', tone: 'pass' }, { lockDigest: 'lock-b', versions: { agents: { research: 2 }, skills: { 'evidence-verification': '1.1.0' } } });
    const better = compareScorecards(base, fixed);
    assert.equal(better.verdict, 'better');
    assert.deepEqual(better.improvements, ['answer']);
    assert.deepEqual(better.changedVersions, ['research 1 → 2', 'evidence-verification 1.0.0 → 1.1.0']);
    assert.equal(compareScorecards(fixed, base).verdict, 'worse', 'losing a critical check is worse whatever else improved');
    const mixed = compareScorecards(card('e3', { answer: 'pass', cited: 'fail', tone: 'pass' }), card('e4', { answer: 'pass', cited: 'pass', tone: 'fail' }));
    assert.equal(mixed.verdict, 'mixed');
    const same = compareScorecards(base, card('e5', { answer: 'fail', cited: 'pass', tone: 'pass' }));
    assert.equal(same.sameDefinitions, true);
    assert.match(renderComparison(same), /same approval lock, so the definitions were identical/);
    assert.match(renderComparison(better), /\*\*BETTER\*\*: score 67% → 100%[\s\S]*\| answer \(critical\) \| ✘ fail \| ✔ pass \|/);
  });

  it('finds the latest earlier scorecard for the scenario', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evals-'));
    for (const c of [card('e1', { answer: 'pass' }), card('e2', { answer: 'pass' })]) {
      mkdirSync(join(dir, 's'), { recursive: true });
      writeFileSync(join(dir, 's', `${c.id}.json`), JSON.stringify(c));
    }
    assert.deepEqual(listScorecards(dir).map((c) => c.id), ['e1', 'e2']);
    assert.equal(findScorecard(dir, 'latest', 's', 'e2')!.id, 'e1');
    assert.equal(findScorecard(dir, 'e2', 's')!.id, 'e2');
    assert.equal(findScorecard(dir, 'latest', 'other'), undefined);
  });
});

describe('improve', () => {
  it('ties each signal to the agent and skill versions in use', async () => {
    const { t, runId } = await finishedRun();
    const signals = gatherSignals({ run: t.store.run(runId)!, tasks: t.store.tasks(runId), records: runRecords(t.ledger.records(), runId), uncovered: [{ need: 'Legal review', reason: 'no agent' }] });
    const finding = signals.find((s) => s.kind === 'finding' && s.task === 'architecture')!;
    assert.equal(finding.agent, 'solution-architecture@1');
    assert.deepEqual(finding.skills, ['solution-architecture-assessment@1.0.0', 'hosting-architecture-review@1.0.0']);
    assert.equal(finding.severity, 'medium');
    assert.match(finding.text, /ev-2 says the host has no Australian region/);
    assert.ok(signals.some((s) => s.kind === 'uncovered' && !s.agent));
    assert.deepEqual(signals.map((s) => s.id), signals.map((_, i) => `S${i + 1}`));
  });

  it('drafts changes to definitions the run used, citing real signals, into the proposals folder only', async () => {
    const { t, runId, setRetrospective } = await finishedRun();
    const lock = readFileSync(resolve('registry/approved.lock.yaml'), 'utf8');
    const signals = gatherSignals({ run: t.store.run(runId)!, tasks: t.store.tasks(runId), records: runRecords(t.ledger.records(), runId) });
    const finding = signals.find((s) => s.kind === 'finding' && s.task === 'architecture')!.id;
    const proposal = (target: string, cited: string) => ({
      target: { kind: 'skill', id: target }, problem: 'A claim contradicted the passage it cited.', signals: [cited],
      where: 'Method, step on hosting', change: 'Before claiming a requirement is met, quote the passage that says so.', expectedEffect: 'No major finding on contradicted claims.', priority: 'high',
    });
    setRetrospective((n, input) => [submit({
      summary: 'One recurring cause.',
      proposals: input.includes('previous result was rejected') ? [proposal('hosting-architecture-review', finding)] : [proposal('legal-review', 'S99')],
    })][n] ?? { text: 'Submitted.' });
    const improver = new Improver({ workforce: t.workforce, registry: t.registry, ledger: t.ledger, results: t.results }, { proposalsDir: join(t.stateDir, 'proposals') });
    const outcome = await improver.improve({ user: 'local', run: t.store.run(runId)!, tasks: t.store.tasks(runId), records: runRecords(t.ledger.records(), runId) });

    assert.equal(outcome.status, 'completed');
    assert.match(JSON.stringify(t.find('improve.rejected')[0]!.data), /legal-review\): not a skill this run used.*S99/);
    const text = readFileSync(outcome.path!, 'utf8');
    assert.match(text, /### 1\. skill `hosting-architecture-review` → new version 1\.1\.0 \(high priority\)/);
    assert.match(text, /Nothing here is approved, and nothing here changes the registry/);
    assert.ok(outcome.path!.startsWith(join(t.stateDir, 'proposals')));
    assert.equal(readFileSync(resolve('registry/approved.lock.yaml'), 'utf8'), lock);
    const brief = t.inputs.find((i) => i.startsWith('Find what in the agents'))!;
    assert.match(brief, /## skill hosting-architecture-review \(used 1\.0\.0; current 1\.0\.0\)/);
    assert.deepEqual((t.find('improve.completed')[0]!.data as { targets: string[] }).targets, ['skill:hosting-architecture-review']);
  });

  it('lists the signals without a model call when asked', async () => {
    const { t, runId } = await finishedRun();
    const before = t.inputs.length;
    const improver = new Improver({ workforce: t.workforce, registry: t.registry, ledger: t.ledger, results: t.results }, { proposalsDir: join(t.stateDir, 'proposals') });
    const outcome = await improver.improve({ user: 'local', run: t.store.run(runId)!, tasks: t.store.tasks(runId), records: runRecords(t.ledger.records(), runId), signalsOnly: true });
    assert.equal(t.inputs.length, before);
    assert.equal(outcome.result, undefined);
    assert.match(readFileSync(outcome.path!, 'utf8'), /## Signals\n\n### solution-architecture@1/);
  });
});
