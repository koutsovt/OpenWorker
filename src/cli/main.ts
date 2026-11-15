// Command line: run a registered agent, ask one question under a model policy,
// check or lock the registry, or verify the audit ledger.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { AuditLedger } from '../audit/ledger.ts';
import { loadConfig } from '../config/load.ts';
import { ModelGateway } from '../gateway/gateway.ts';
import { runTask } from '../gateway/run.ts';
import { ClaudeCodeHarness } from '../harness/claude-code.ts';
import { OpenWorkerHarness } from '../harness/openworker.ts';
import { RoutingHarness } from '../harness/routing.ts';
import { Governance } from '../governance/policy.ts';
import { Registry } from '../registry/registry.ts';
import { Workforce } from '../runtime/workforce.ts';
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
  const user = process.env.WORKFORCE_USER ?? 'local';
  const config = loadConfig(configDir);
  const harness = newHarness();
  const workforce = new Workforce({
    harness, ledger, gateway: new ModelGateway(config, ledger), registry: new Registry(resolve('registry')),
    governance: Governance.load(resolve(configDir, 'users.yaml'), resolve(configDir, 'policies.yaml')),
    implementations: skillTools(ledger, resolve(stateDir, 'proposals')),
  });
  try {
    await workforce.start(available(config));
    const outcome = await workforce.runAgent({
      agentId, user, skills, input: words.join(' '),
      // The person at the terminal decides. Their identity is checked against the approver role.
      approver: async (request, instance) => {
        const terminal = createInterface({ input: process.stdin, output: process.stderr });
        const answer = await terminal.question(`\nApproval needed: ${instance.id} wants to call ${request.tool}\n${JSON.stringify(request.arguments, null, 2)}\nApprove? [y/N] `);
        terminal.close();
        return { approver: user, decision: answer.trim().toLowerCase() === 'y' ? 'approve' : 'deny' };
      },
    });
    console.log(outcome.output ?? `Run ${outcome.status}: ${outcome.failure ?? 'no output'}`);
    console.error(`[${outcome.instance}; model ${outcome.model}; tried ${outcome.tried.join(' -> ')}]`);
    process.exitCode = outcome.status === 'completed' ? 0 : 1;
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    await harness.shutdown();
  }
} else {
  console.error('Commands: run <agent-id> [--skills a,b] <task> | ask <model-policy> <question> | registry check|lock | verify-ledger');
  process.exit(2);
}
