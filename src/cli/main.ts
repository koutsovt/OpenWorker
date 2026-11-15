// Command line: orchestrate an objective, run a registered agent, ask one question
// under a model policy, check or lock the registry, or verify the audit ledger.
import { mkdirSync, readFileSync } from 'node:fs';
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
import { RunStore } from '../orchestrator/store.ts';
import { Registry } from '../registry/registry.ts';
import { Workforce, type Approver } from '../runtime/workforce.ts';
import { knowledgeTools } from '../tools/knowledge.ts';
import { ResultInbox } from '../tools/result.ts';
import { skillTools } from '../tools/skills.ts';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stringify } from 'yaml';

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

const user = process.env.WORKFORCE_USER ?? 'local';
const prompt = async (question: string): Promise<string> => {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await terminal.question(question);
  terminal.close();
  return answer.trim();
};
const ask = async (question: string): Promise<boolean> => (await prompt(question)).toLowerCase() === 'y';
// The person at the terminal decides. Their identity is checked against the approver role.
const approver: Approver = async (request, instance) => ({
  approver: user,
  decision: await ask(`\nApproval needed: ${instance.id} wants to call ${request.tool}\n${JSON.stringify(request.arguments, null, 2)}\nApprove? [y/N] `) ? 'approve' : 'deny',
});

/** Everything a governed run needs, wired once: registries, policy, tools, stores and the engines. */
const platform = (knowledgeDir = resolve(process.env.WORKFORCE_KNOWLEDGE_DIR ?? 'knowledge')) => {
  const config = loadConfig(configDir);
  const registry = new Registry(resolve('registry'));
  const governance = Governance.load(resolve(configDir, 'users.yaml'), resolve(configDir, 'policies.yaml'));
  const state = openState(resolve(stateDir, 'state.sqlite'));
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
    { reportsDir: resolve(stateDir, 'reports') },
  );
  return { harness, workforce, orchestrator, store, project, knowledgeDir, start: () => workforce.start(available(config)) };
};

const report = (summary: RunSummary): void => {
  for (const t of summary.tasks)
    console.log(`${t.status.padEnd(15)} ${t.id} (${t.agent}${t.model ? `, ${t.tried.join(' -> ')}` : ''})${t.failure ? ` — ${t.failure}` : ''}`);
  console.log(`\nRun ${summary.runId}: ${summary.status}.`);
  if (summary.status !== 'completed') for (const t of summary.tasks.filter((x) => x.result !== null)) console.log(`\n## ${t.id}\n${JSON.stringify(t.result, null, 2)}`);
};

if (command === 'verify-ledger') {
  const verdict = ledger.verify();
  console.log(verdict.ok ? `Ledger intact: ${verdict.count} records.` : `Ledger BROKEN at record ${verdict.brokenAt}: ${verdict.reason}.`);
  process.exit(verdict.ok ? 0 : 1);
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
  // orchestrate [--scenario dir] [--plan file.json] [objective]: plan (or take a written plan), ask for approval, run.
  // resume <run-id>: continue a run that was interrupted or is held by assurance.
  const flag = (name: string): string | undefined => {
    const at = rest.indexOf(name);
    return at >= 0 ? rest.splice(at, 2)[1] ?? '' : undefined;
  };
  const planFile = flag('--plan');
  const scenario = flag('--scenario');
  const objective = rest.join(' ') || (scenario ? readFileSync(resolve(scenario, 'objective.md'), 'utf8').trim() : '');
  if (planFile === '' || scenario === '' || (command === 'resume' ? rest.length !== 1 : !objective)) {
    console.error('Usage: npm run orchestrate -- [--scenario dir] [--plan plan.json] [objective]   |   npm run resume -- <run-id>');
    process.exit(2);
  }
  // A run always uses the knowledge folder it started with, also after a restart.
  const remembered = command === 'resume'
    ? new ProjectMemory(openState(resolve(stateDir, 'state.sqlite'))).entries(rest[0]!, 'decision').find((d) => d.key === 'knowledge-dir')?.content
    : undefined;
  const { harness, orchestrator, store, project, knowledgeDir, start } = platform(
    typeof remembered === 'string' ? remembered : scenario ? resolve(scenario, 'knowledge') : undefined);
  try {
    await start();
    let runId = rest[0]!;
    if (command === 'orchestrate') {
      const planned = planFile
        ? orchestrator.submitPlan({ user, objective, plan: JSON.parse(readFileSync(resolve(planFile), 'utf8')) as Json })
        : await orchestrator.plan({ user, objective });
      runId = planned.runId;
      project.put(runId, 'decision', 'knowledge-dir', knowledgeDir);
      console.error(`\nPlan for ${runId}:`);
      for (const t of planned.plan.tasks)
        console.error(`  ${t.id}  [${t.agent}${t.skills.length ? `; skills ${t.skills.join(', ')}` : ''}]${t.dependsOn.length ? `  after ${t.dependsOn.join(', ')}` : ''}\n      ${t.objective}`);
      console.error('  Then, run by the platform: independent assurance, one rework round if needed, and the final report.');
    }
    if (store.run(runId)?.status === 'planned')
      orchestrator.approvePlan(runId, user, await ask(`\nApprove this plan and run it as ${user}? [y/N] `) ? 'approve' : 'deny');
    if (store.run(runId)?.status === 'rejected') {
      console.log(`Plan for ${runId} was not approved. Nothing ran.`);
      process.exitCode = 1;
    } else {
      let summary = await orchestrator.execute(runId, { approver });
      if (summary.status === 'held') {
        const verdict = (summary.tasks.findLast((t) => t.id.startsWith('assurance'))?.result ?? {}) as { summary?: string; findings?: { severity: string; task: string; issue: string }[] };
        console.error(`\nIndependent assurance FAILED this work, so no report was produced.\n${verdict.summary ?? ''}`);
        for (const f of verdict.findings ?? []) console.error(`  [${f.severity}] ${f.task}: ${f.issue}`);
        const reason = await prompt(`\nTo override as ${user} and produce the report anyway, type a reason. Leave empty to stop here: `);
        if (reason) {
          orchestrator.overrideAssurance(runId, user, reason);
          summary = await orchestrator.execute(runId, { approver });
        }
      }
      report(summary);
      const path = orchestrator.reportPath(runId);
      if (summary.status === 'completed' && path) console.log(`\nFinal report: ${path}\n\n${readFileSync(path, 'utf8')}`);
      if (summary.status === 'held') console.log(`\nHeld by assurance. An approver can override with: npm run resume -- ${runId}`);
      process.exitCode = summary.status === 'completed' ? 0 : 1;
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    await harness.shutdown();
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
  console.error('Commands: orchestrate [--scenario dir] [--plan file] [objective] | resume <run-id> | runs | usage [run-id] | run <agent-id> [--skills a,b] <task> | ask <model-policy> <question> | registry check|lock | verify-ledger');
  process.exit(2);
}
