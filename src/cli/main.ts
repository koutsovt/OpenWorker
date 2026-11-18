// Command line: orchestrate an objective, run a registered agent, ask one question
// under a model policy, check or lock the registry, or verify the audit ledger.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AuditLedger } from '../audit/ledger.ts';
import { formatUsage, usageReport } from '../audit/usage.ts';
import { loadConfig } from '../config/load.ts';
import { ModelGateway } from '../gateway/gateway.ts';
import { runTask } from '../gateway/run.ts';
import { ClaudeCodeHarness } from '../harness/claude-code.ts';
import { OpenWorkerHarness } from '../harness/openworker.ts';
import { RoutingHarness } from '../harness/routing.ts';
import { Governance } from '../governance/policy.ts';
import type { Json } from '../harness/port.ts';
import { KnowledgeBase } from '../memory/knowledge.ts';
import { EvidenceStore, openState, ProjectMemory } from '../memory/state.ts';
import { Orchestrator, type RunSummary } from '../orchestrator/orchestrator.ts';
import { CapabilityAssessor } from '../orchestrator/assessment.ts';
import { AnswerKeyError, compareScorecards, findScorecard, listScorecards, loadAnswerKey, renderComparison, renderScorecard, RunEvaluator, runRecords, type AnswerKey } from '../evaluation/evaluate.ts';
import { Improver } from '../evaluation/improve.ts';
import { Dashboard, firstAnswer, type AgentCard, type Question } from './dashboard.ts';
import { LiveProgress } from './progress.ts';
import { isAssuranceStage } from '../orchestrator/graph.ts';
import { RunStore } from '../orchestrator/store.ts';
import { Registry } from '../registry/registry.ts';
import { Workforce, type Approver } from '../runtime/workforce.ts';
import { knowledgeTools } from '../tools/knowledge.ts';
import { ResultInbox } from '../tools/result.ts';
import { skillTools } from '../tools/skills.ts';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parse, stringify } from 'yaml';
import type { Budget } from '../governance/budget.ts';

const [command, ...rest] = process.argv.slice(2);
const stateDir = resolve(process.env.WORKFORCE_STATE_DIR ?? '.state');
const configDir = resolve(process.env.WORKFORCE_CONFIG_DIR ?? 'config');
mkdirSync(stateDir, { recursive: true });
const ledger = new AuditLedger(resolve(stateDir, 'audit.sqlite'));

const newHarness = () => {
  const claudeDir = resolve(stateDir, 'claude-code');
  mkdirSync(claudeDir, { recursive: true });
  return new RoutingHarness([
    { harness: new ClaudeCodeHarness({ cwd: claudeDir }), serves: (p) => p.api === 'claude-code' },
    { harness: new OpenWorkerHarness({ stateDir: resolve(stateDir, 'harness') }), serves: (p) => p.api !== 'claude-code' },
  ]);
};
// Register only providers whose key is present; a policy that needs a missing one fails with a clear error.
const available = (config: ReturnType<typeof loadConfig>) => config.providers.filter((p) => !p.apiKeyEnv || process.env[p.apiKeyEnv]);

// Identities at the command line are self-asserted until an identity provider replaces users.yaml.
// The requester and the approver are named separately, so separation of duties can be exercised.
const user = process.env.WORKFORCE_USER ?? 'local';
const approverId = process.env.WORKFORCE_APPROVER ?? user;
// The live status block, while one is shown. Questions clear it first and redraw it after.
let progress: LiveProgress | undefined;
// The browser dashboard, with --dashboard. A question can then be answered there or on the terminal, whichever is first.
let dashboard: Dashboard | undefined;
const prompt = async (question: string, web?: Question): Promise<string> => {
  const hold = progress && !progress.isPaused ? progress : undefined;
  hold?.pause();
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  const remote = dashboard && web ? dashboard.ask(web) : undefined;
  try {
    const { answer, from } = await firstAnswer((signal) => terminal.question(question, { signal }), remote?.answer);
    if (from === 'dashboard') process.stderr.write(`${web!.kind === 'confirm' ? answer : answer ? 'override' : '(stop)'}   ← answered in the dashboard\n`);
    return answer.trim();
  } finally {
    remote?.withdraw();
    terminal.close();
    hold?.resume();
  }
};
const ask = async (question: string, web?: Question): Promise<boolean> => (await prompt(question, web)).toLowerCase() === 'y';
// The person at the terminal decides. Their identity is checked against the approver role.
const approver: Approver = async (request, instance) => ({
  approver: approverId,
  decision: await ask(`\nApproval needed: ${instance.id} wants to call ${request.tool}\n${JSON.stringify(request.arguments, null, 2)}\nApprove? [y/N] `,
    { kind: 'confirm', title: `${instance.id} wants to call ${request.tool}`, body: request.arguments }) ? 'approve' : 'deny',
});

/** Everything a governed run needs, wired once: registries, policy, tools, stores and the engines. */
const platform = (knowledgeDir = resolve(process.env.WORKFORCE_KNOWLEDGE_DIR ?? 'knowledge')) => {
  const config = loadConfig(configDir);
  const registry = new Registry(resolve('registry'));
  const governance = Governance.load(resolve(configDir, 'users.yaml'), resolve(configDir, 'policies.yaml'));
  const state = openState(resolve(stateDir, 'state.sqlite'));
  // task: limits per task attempt; run: limits across every task of one run (see config/budgets.yaml).
  const budgetsPath = resolve(configDir, 'budgets.yaml');
  const budgets = (existsSync(budgetsPath) ? parse(readFileSync(budgetsPath, 'utf8')) ?? {} : {}) as { task?: Budget; run?: Budget };
  const project = new ProjectMemory(state);
  const evidence = new EvidenceStore(state);
  const results = new ResultInbox();
  const gateway = new ModelGateway(config, ledger);
  const harness = newHarness();
  const workforce = new Workforce({
    harness, ledger, gateway, registry, governance,
    implementations: {
      ...skillTools(ledger, resolve(stateDir, 'proposals')),
      ...knowledgeTools(new KnowledgeBase(knowledgeDir), evidence, project, ledger),
      ...results.tools,
    },
  });
  const store = new RunStore(state);
  const orchestrator = new Orchestrator(
    { workforce, registry, governance, ledger, store, project, evidence, results, providerOf: (alias) => gateway.providerOf(alias) },
    { reportsDir: resolve(stateDir, 'reports'), ...(budgets.task ? { budget: budgets.task } : {}), ...(budgets.run ? { runBudget: budgets.run } : {}) },
  );
  const assessor = new CapabilityAssessor({ workforce, registry, ledger, evidence, results },
    { reportsDir: resolve(stateDir, 'reports'), ...(budgets.task ? { budget: budgets.task } : {}) });
  return { harness, workforce, orchestrator, assessor, registry, store, project, results, budgets, knowledgeDir, start: () => workforce.start(available(config)) };
};

/** The agent cards on the dashboard: each approved agent with the rule it works under. */
const agentCards = (registry: Registry): AgentCard[] => registry.usableAgents().map((a) => ({
  id: a.id, purpose: a.purpose.split('. ')[0]!.replace(/\.$/, ''),
  rule: a.outputContract === 'assurance' ? 'reviews the work, never repairs it'
    : a.outputContract === 'capability-assessment' ? 'recommends, creates nothing'
    : a.outputContract === 'evaluation' ? 'grades runs, changes nothing'
    : a.outputContract === 'improvement-proposals' ? 'drafts changes, writes none'
    : !a.outputContract ? 'plans and reports, never does the work'
    : 'read-only · every claim cites evidence',
}));

/** Starts the dashboard when --dashboard was given, and prints where to open it. */
const openDashboard = async (title: string, registry: Registry, detail?: (task: string) => Json | undefined): Promise<void> => {
  dashboard = new Dashboard({ ledger, title, agents: agentCards(registry), reportsDir: resolve(stateDir, 'reports'), ...(detail ? { detail } : {}) });
  const url = await dashboard.start();
  console.error(`Dashboard: ${url}\n(this machine only; the token in the address is the key)\n`);
};
const closeDashboard = async (): Promise<void> => {
  if (!dashboard) return;
  if (process.stdin.isTTY) await prompt('\nThe dashboard stays open until you press Enter. ');
  await dashboard.stop();
  dashboard = undefined;
};

const report = (summary: RunSummary): void => {
  for (const t of summary.tasks)
    console.log(`${t.status.padEnd(15)} ${t.id} (${t.agent}${t.model ? `, ${t.tried.join(' -> ')}` : ''})${t.failure ? ` — ${t.failure}` : ''}`);
  console.log(`\nRun ${summary.runId}: ${summary.status}.`);
  if (summary.status !== 'completed') for (const t of summary.tasks.filter((x) => x.result !== null)) console.log(`\n## ${t.id}\n${JSON.stringify(t.result, null, 2)}`);
};

/**
 * orchestrate [--scenario dir] [--plan file.json] [--dashboard] [objective]: plan (or take a written plan), ask for approval, run.
 * resume [--dashboard] <run-id>: continue a run that was interrupted or is held by assurance.
 * `after` runs once the run has ended (completed, held or failed), while the engines are still up.
 */
const orchestrateCommand = async (mode: 'orchestrate' | 'resume', args: string[], after?: (runId: string, p: ReturnType<typeof platform>) => Promise<void>): Promise<void> => {
  const flag = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at >= 0 ? args.splice(at, 2)[1] ?? '' : undefined;
  };
  const planFile = flag('--plan');
  const scenario = flag('--scenario');
  const withDashboard = args.includes('--dashboard');
  if (withDashboard) args.splice(args.indexOf('--dashboard'), 1);
  const objective = args.join(' ') || (scenario ? readFileSync(resolve(scenario, 'objective.md'), 'utf8').trim() : '');
  if (planFile === '' || scenario === '' || (mode === 'resume' ? args.length !== 1 : !objective)) {
    console.error('Usage: npm run orchestrate -- [--scenario dir] [--plan plan.json] [--dashboard] [objective]   |   npm run resume -- [--dashboard] <run-id>');
    process.exit(2);
  }
  // A run always uses the knowledge folder it started with, also after a restart.
  const remembered = mode === 'resume'
    ? new ProjectMemory(openState(resolve(stateDir, 'state.sqlite'))).entries(args[0]!, 'decision').find((d) => d.key === 'knowledge-dir')?.content
    : undefined;
  const built = platform(
    typeof remembered === 'string' ? remembered : scenario ? resolve(scenario, 'knowledge') : undefined);
  const { harness, orchestrator, registry, store, project, knowledgeDir, start } = built;
  try {
    await start();
    let runId = args[0]!;
    const title = scenario ? `OpenWorker · ${scenario.replace(/\/+$/, '').split('/').pop()}` : 'OpenWorker';
    if (withDashboard) {
      await openDashboard(title, registry, (task) => {
        const run = dashboard?.state.runId;
        return run ? store.tasks(run).find((t) => t.id === task)?.result ?? undefined : undefined;
      });
      if (mode === 'resume') {
        const tasks = store.tasks(runId);
        dashboard!.state.runId = runId;
        dashboard!.seed(tasks.map((t) => ({ id: t.id, agent: t.agent })));
        if (store.run(runId)?.status === 'planned') dashboard!.showPlan({ tasks: tasks as unknown as Json, uncovered: orchestrator.uncovered(runId) as unknown as Json });
      }
    }
    progress = new LiveProgress(title).follow(ledger);
    if (mode === 'orchestrate') {
      const planned = planFile
        ? orchestrator.submitPlan({ user, objective, plan: JSON.parse(readFileSync(resolve(planFile), 'utf8')) as Json })
        : await orchestrator.plan({ user, objective });
      runId = planned.runId;
      progress.pause();
      dashboard?.showPlan(planned.plan as unknown as Json);
      project.put(runId, 'decision', 'knowledge-dir', knowledgeDir);
      console.error(`\nPlan for ${runId}:`);
      for (const t of planned.plan.tasks)
        console.error(`  ${t.id}  [${t.agent}${t.skills.length ? `; skills ${t.skills.join(', ')}` : ''}]${t.dependsOn.length ? `  after ${t.dependsOn.join(', ')}` : ''}\n      ${t.objective}`);
      console.error('  Then, run by the platform: independent assurance, one rework round if needed, and the final report.');
    }
    const gaps = orchestrator.uncovered(runId);
    if (store.run(runId)?.status === 'planned' && gaps.length) {
      console.error('\nNOT COVERED: no approved agent or skill fits these parts of the objective, so this plan leaves them undone:');
      for (const g of gaps) console.error(`  - ${g.need}${g.reason ? `\n      ${g.reason}` : ''}`);
      console.error('  To cover them, run `npm run assess` on this scenario and have the proposed skills or agents reviewed and approved.');
    }
    if (store.run(runId)?.status === 'planned')
      orchestrator.approvePlan(runId, approverId, await ask(`\nApprove this plan as ${approverId}, to run as ${user}? [y/N] `,
        { kind: 'confirm', title: `Approve this plan as ${approverId}, to run as ${user}?` }) ? 'approve' : 'deny');
    console.error('');
    progress.seed(store.tasks(runId).map((t) => ({ id: t.id, agent: t.agent })));
    if (store.run(runId)?.status !== 'rejected') progress.resume();
    if (store.run(runId)?.status === 'rejected') {
      console.log(`Plan for ${runId} was not approved. Nothing ran.`);
      process.exitCode = 1;
    } else {
      let summary = await orchestrator.execute(runId, { approver });
      if (summary.status === 'held') {
        progress.pause();
        const verdict = (summary.tasks.findLast((t) => isAssuranceStage(t.id))?.result ?? {}) as { summary?: string; findings?: { severity: string; task: string; issue: string }[] };
        console.error(`\nIndependent assurance FAILED this work, so no report was produced.\n${verdict.summary ?? ''}`);
        for (const f of verdict.findings ?? []) console.error(`  [${f.severity}] ${f.task}: ${f.issue}`);
        const reason = await prompt(`\nTo override as ${approverId} and produce the report anyway, type a reason. Leave empty to stop here: `,
          { kind: 'text', title: `Assurance failed this work. Override as ${approverId} and produce the report anyway?`, body: verdict as unknown as Json });
        if (reason) {
          orchestrator.overrideAssurance(runId, approverId, reason);
          progress.resume();
          summary = await orchestrator.execute(runId, { approver });
        }
      }
      progress.stop();
      progress = undefined;
      report(summary);
      const path = orchestrator.reportPath(runId);
      if (summary.status === 'completed' && path)
        console.log(`\nFinal report: ${path}\nAppendix (task results, full review, evidence register): ${orchestrator.appendixPath(runId)}\n\n${readFileSync(path, 'utf8')}`);
      if (summary.status === 'held') console.log(`\nHeld by assurance. An approver can override with: npm run resume -- ${runId}`);
      process.exitCode = summary.status === 'completed' ? 0 : 1;
      await after?.(runId, built);
    }
    await closeDashboard();
  } catch (e) {
    progress?.stop();
    console.error(`Error: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    progress?.stop();
    await dashboard?.stop();
    await harness.shutdown();
  }
};

if (command === 'verify-ledger' || command === 'anchor-ledger') {
  // verify-ledger [<seq>:<hash> | anchor-file]: check the chain, and a head recorded earlier (for example in a
  // final report) or every anchor in a file; WORKFORCE_ANCHOR_FILE names a default file.
  // anchor-ledger <anchor-file>: append the current head to that file. Keep it where this machine's users cannot rewrite it.
  const target = rest[0] ?? process.env.WORKFORCE_ANCHOR_FILE;
  const single = target && /^\d+:[0-9a-f]{64}$/.test(target) ? { seq: Number(target.split(':')[0]), hash: target.split(':')[1]! } : undefined;
  const verdict = ledger.verify(single);
  console.log(verdict.ok
    ? `Ledger intact: ${verdict.count} records. Head ${verdict.head.seq}:${verdict.head.hash}`
    : `Ledger BROKEN at record ${verdict.brokenAt}: ${verdict.reason}.`);
  let ok = verdict.ok;
  if (command === 'anchor-ledger') {
    const head = ledger.head();
    if (!target || single || !verdict.ok || head.seq === 0) {
      console.error(!target || single ? 'Usage: npm run anchor-ledger -- <anchor-file>' : 'Nothing anchored: the ledger is empty or broken.');
      process.exit(2);
    }
    appendFileSync(resolve(target), `${JSON.stringify({ at: new Date().toISOString(), ...head })}\n`);
    console.log(`Anchored record ${head.seq} (${head.hash.slice(0, 12)}…) in ${target}.`);
  } else if (target && !single) {
    if (!existsSync(resolve(target))) {
      console.error(`No anchor file at ${target}.`);
      process.exit(2);
    }
    const anchors = readFileSync(resolve(target), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { seq: number; hash: string });
    const problems = ledger.checkAnchors(anchors);
    console.log(problems.length ? problems.map((p) => `ANCHOR MISMATCH  ${p}`).join('\n') : `All ${anchors.length} anchors match.`);
    ok = ok && !problems.length;
  }
  process.exit(ok ? 0 : 1);
} else if (command === 'ask') {
  const [policy, ...words] = rest;
  if (!policy || !words.length) {
    console.error('Usage: npm run ask -- <model-policy> <question>');
    process.exit(2);
  }
  const config = loadConfig(configDir);
  const gateway = new ModelGateway(config, ledger);
  const harness = newHarness();
  await harness.start({ providers: available(config), tools: [] });
  try {
    const outcome = await runTask(harness, gateway, ledger, {
      agent: { name: 'cli-ask-v1', instructions: 'Answer concisely and accurately.', tools: [] },
      policy, input: words.join(' '), actor: `user:${process.env.USER ?? 'local'}`,
    });
    console.log(outcome.result.output ?? `Task ${outcome.result.status}: ${outcome.result.failure?.category ?? 'no output'}`);
    console.error(`[model ${outcome.model}; tried ${outcome.tried.join(' -> ')}; ${outcome.result.usage.inputTokens} in / ${outcome.result.usage.outputTokens} out tokens]`);
    process.exitCode = outcome.result.status === 'completed' ? 0 : 1;
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    await harness.shutdown();
  }
} else if (command === 'registry') {
  const registry = new Registry(resolve('registry'));
  if (rest[0] === 'lock') {
    // Run by a registry administrator after review. The lock file change is what approval means.
    writeFileSync(resolve('registry', 'approved.lock.yaml'),
      `# Digests of approved agent and skill definitions. Changed only by reviewed pull request.\n${stringify(registry.approvedDigests())}`);
    console.log('Wrote registry/approved.lock.yaml');
  } else {
    const problems = registry.problems();
    console.log(problems.length ? problems.map((p) => `PROBLEM  ${p}`).join('\n') : 'Registry matches the approval lock file.');
    process.exit(problems.length ? 1 : 0);
  }
} else if (command === 'run') {
  const skillsFlag = rest.indexOf('--skills');
  const skills = skillsFlag >= 0 ? (rest[skillsFlag + 1] ?? '').split(',').filter(Boolean) : [];
  const [agentId, ...words] = skillsFlag >= 0 ? rest.filter((_, i) => i !== skillsFlag && i !== skillsFlag + 1) : rest;
  if (!agentId || !words.length) {
    console.error('Usage: npm run agent -- <agent-id> [--skills a,b] <task>');
    process.exit(2);
  }
  const { harness, workforce, start } = platform();
  try {
    await start();
    const outcome = await workforce.runAgent({ agentId, user, skills, input: words.join(' '), approver });
    console.log(outcome.output ?? `Run ${outcome.status}: ${outcome.failure ?? 'no output'}`);
    console.error(`[${outcome.instance}; model ${outcome.model}; tried ${outcome.tried.join(' -> ')}]`);
    process.exitCode = outcome.status === 'completed' ? 0 : 1;
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    await harness.shutdown();
  }
} else if (command === 'orchestrate' || command === 'resume') {
  await orchestrateCommand(command, rest);
} else if (command === 'assess') {
  // assess [--scenario dir] [description]: which approved agents and skills cover the work, and what is missing.
  const at = rest.indexOf('--scenario');
  const scenario = at >= 0 ? rest.splice(at, 2)[1] ?? '' : undefined;
  const withDashboard = rest.includes('--dashboard');
  if (withDashboard) rest.splice(rest.indexOf('--dashboard'), 1);
  const scope = rest.join(' ') || (scenario ? readFileSync(resolve(scenario, 'objective.md'), 'utf8').trim() : '');
  if (scenario === '' || !scope) {
    console.error('Usage: npm run assess -- [--scenario dir] [--dashboard] [description of the work]');
    process.exit(2);
  }
  const { harness, assessor, registry, start } = platform(scenario ? resolve(scenario, 'knowledge') : undefined);
  try {
    await start();
    const title = `Capability assessment${scenario ? ` · ${scenario.replace(/\/+$/, '').split('/').pop()}` : ''}`;
    if (withDashboard) {
      await openDashboard(title, registry);
      dashboard!.seed([{ id: 'assessment', agent: 'capability-analyst' }]);
    }
    progress = new LiveProgress(title).seed([{ id: 'assessment', agent: 'capability-analyst' }]).follow(ledger);
    const outcome = await assessor.assess({ user, scope });
    progress.stop();
    progress = undefined;
    if (outcome.status === 'completed') {
      console.log(outcome.reportPath ? `Gap report: ${outcome.reportPath}\n\n${readFileSync(outcome.reportPath, 'utf8')}` : JSON.stringify(outcome.result, null, 2));
    } else {
      console.error(`Assessment ${outcome.assessmentId} failed:\n  - ${outcome.problems.join('\n  - ')}`);
      process.exitCode = 1;
    }
    await closeDashboard();
  } catch (e) {
    progress?.stop();
    console.error(`Error: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    await dashboard?.stop();
    await harness.shutdown();
  }
} else if (command === 'eval') {
  // eval <scenario-dir> [--run <run-id>] [--compare latest|<scorecard>] [--no-judge] [--dashboard]: run the scenario (or take a
  // finished run of it) and grade it against the scenario's answer key, eval.yaml. eval --list [scenario]: the saved scorecards.
  const evalsDir = resolve(stateDir, 'evals');
  const flag = (name: string): string | undefined => {
    const at = rest.indexOf(name);
    return at >= 0 ? rest.splice(at, 2)[1] ?? '' : undefined;
  };
  const toggle = (name: string): boolean => (rest.includes(name) ? (rest.splice(rest.indexOf(name), 1), true) : false);
  if (toggle('--list')) {
    const cards = listScorecards(evalsDir, rest[0] ? rest[0].replace(/\/+$/, '').split('/').pop() : undefined);
    for (const c of cards) console.log(`${c.id}  ${c.at.slice(0, 16).replace('T', ' ')}  ${c.scenarioDir.padEnd(24)} ${String(c.score.percent).padStart(3)}%  critical failed ${c.score.criticalFailed.length}  ${c.git.branch ?? '?'}@${c.git.commit ?? '?'}  run ${c.runId}`);
    if (!cards.length) console.log('No scorecards yet.');
    process.exit(0);
  }
  const runFlag = flag('--run');
  const compare = flag('--compare');
  const noJudge = toggle('--no-judge');
  const withDashboard = toggle('--dashboard');
  const scenario = rest[0];
  if (!scenario || rest.length !== 1 || runFlag === '' || compare === '') {
    console.error('Usage: npm run eval -- <scenario-dir> [--run <run-id>] [--compare latest|<scorecard>] [--no-judge] [--dashboard]   |   npm run eval -- --list [scenario-dir]');
    process.exit(2);
  }
  let key: AnswerKey;
  try {
    key = loadAnswerKey(resolve(scenario));
  } catch (e) {
    if (!(e instanceof AnswerKeyError)) throw e;
    console.error(e.message);
    process.exit(2);
  }
  const objective = readFileSync(resolve(scenario, 'objective.md'), 'utf8').trim();
  const grade = async (runId: string, p: ReturnType<typeof platform>): Promise<void> => {
    const run = p.store.run(runId)!;
    const read = (path: string | undefined) => (path && existsSync(path) ? readFileSync(path, 'utf8') : '');
    console.error(`\nGrading ${runId} against ${scenario}/eval.yaml${noJudge ? ' (code checks only)' : ''}…`);
    const evaluator = new RunEvaluator({ workforce: p.workforce, ledger, results: p.results },
      { evalsDir, registryDir: resolve('registry'), ...(p.budgets.task ? { budget: p.budgets.task } : {}) });
    const { scorecard, path } = await evaluator.evaluate({
      user, scenarioDir: resolve(scenario), key, objective, judge: !noJudge,
      evidence: { run, tasks: p.store.tasks(runId), records: runRecords(ledger.records(), runId), brief: read(p.orchestrator.reportPath(runId)), appendix: read(p.orchestrator.appendixPath(runId)) },
    });
    console.log(`\n${renderScorecard(scorecard)}\nScorecard: ${path}`);
    if (compare) {
      const baseline = findScorecard(evalsDir, compare, scorecard.scenarioDir, scorecard.id);
      if (!baseline) console.error(`\nNothing to compare with: no scorecard ${compare === 'latest' ? `for ${scorecard.scenarioDir} before this one` : `named ${compare}`}.`);
      else {
        const text = renderComparison(compareScorecards(baseline, scorecard));
        const out = path.replace(/\.json$/, `-vs-${baseline.id}.md`);
        writeFileSync(out, text);
        console.log(`\n${text}\nComparison: ${out}`);
      }
    }
    if (scorecard.score.criticalFailed.length) process.exitCode = 1;
  };
  if (!runFlag) {
    await orchestrateCommand('orchestrate', ['--scenario', scenario, ...(withDashboard ? ['--dashboard'] : [])], grade);
  } else {
    const p = platform(resolve(scenario, 'knowledge'));
    const run = p.store.run(runFlag);
    const knowledge = p.project.entries(runFlag, 'decision').find((d) => d.key === 'knowledge-dir')?.content;
    if (!run || run.status === 'planned' || run.status === 'rejected') {
      console.error(!run ? `No run ${runFlag} in ${stateDir}.` : `Run ${runFlag} is ${run.status}: nothing ran, so there is nothing to grade.`);
      process.exit(2);
    }
    if (knowledge !== resolve(scenario, 'knowledge')) {
      console.error(`Run ${runFlag} used ${knowledge ?? 'an unrecorded knowledge folder'}, not ${resolve(scenario, 'knowledge')}: it is not a run of this scenario.`);
      process.exit(2);
    }
    try {
      if (!noJudge) await p.start();
      await grade(runFlag, p);
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      process.exitCode = 1;
    } finally {
      await p.harness.shutdown();
    }
  }
} else if (command === 'improve') {
  // improve <run-id> [--signals-only]: what went wrong in a run, tied to the agent and skill versions in use, and drafted
  // changes to those definitions for their owners. Writes to the proposals folder only.
  const signalsOnly = rest.includes('--signals-only');
  const args = rest.filter((a) => a !== '--signals-only');
  if (args.length !== 1) {
    console.error('Usage: npm run improve -- <run-id> [--signals-only]');
    process.exit(2);
  }
  const runId = args[0]!;
  const p = platform();
  const run = p.store.run(runId);
  if (!run) {
    console.error(`No run ${runId} in ${stateDir}.`);
    process.exit(2);
  }
  try {
    if (!signalsOnly) await p.start();
    const improver = new Improver({ workforce: p.workforce, registry: p.registry, ledger, results: p.results },
      { proposalsDir: resolve(stateDir, 'proposals'), ...(p.budgets.task ? { budget: p.budgets.task } : {}) });
    const outcome = await improver.improve({
      user, run, tasks: p.store.tasks(runId), records: runRecords(ledger.records(), runId), uncovered: p.orchestrator.uncovered(runId),
      scorecards: listScorecards(resolve(stateDir, 'evals')).filter((s) => s.runId === runId), signalsOnly,
    });
    if (outcome.path) console.log(`${readFileSync(outcome.path, 'utf8')}\nProposals: ${outcome.path}`);
    if (outcome.status === 'failed') {
      console.error(`\nNo changes were drafted: ${outcome.problems.join('; ')}`);
      process.exitCode = 1;
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    await p.harness.shutdown();
  }
} else if (command === 'usage') {
  // usage [run-id]: tokens and cost from the audit ledger, by model and by run, or by task for one run.
  const config = loadConfig(configDir);
  const usage = usageReport(ledger.records(), rest[0] ? { runId: rest[0] } : {});
  const subscription = new Set(config.models.filter((m) => config.providers.find((p) => p.name === m.provider)?.api === 'claude-code').map((m) => m.alias));
  const unpriced = config.models.filter((m) => !m.price).map((m) => m.alias);
  console.log(formatUsage('model', usage.byModel, (alias) => (subscription.has(alias) ? 'subscription: rate-limited, not billed per token' : '')));
  console.log(`\n${formatUsage(usage.byTask ? 'task' : 'run', usage.byTask ?? usage.byRun)}`);
  console.log(`\n${formatUsage('', [usage.total])}`);
  if (unpriced.length) console.log(`\nNo price is set for: ${unpriced.join(', ')}. Add price: { input, output } (USD per million tokens) in config/models.yaml to get cost figures.`);
} else if (command === 'runs') {
  const store = new RunStore(openState(resolve(stateDir, 'state.sqlite')));
  for (const run of store.runs()) console.log(`${run.id}  ${run.status.padEnd(9)}  ${run.createdAt}  ${run.user}  ${run.objective.slice(0, 80)}`);
} else {
  console.error('Commands: orchestrate [--scenario dir] [--plan file] [objective] | resume <run-id> | assess [--scenario dir] [description] | eval <scenario-dir> [--run id] [--compare latest] | improve <run-id> | runs | usage [run-id] | run <agent-id> [--skills a,b] <task> | ask <model-policy> <question> | registry check|lock | verify-ledger [<seq>:<hash> | anchor-file] | anchor-ledger <anchor-file>');
  process.exit(2);
}
