// Minimal command line: ask one question under a model policy, or verify the audit ledger.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { AuditLedger } from '../audit/ledger.ts';
import { loadConfig } from '../config/load.ts';
import { ModelGateway } from '../gateway/gateway.ts';
import { runTask } from '../gateway/run.ts';
import { ClaudeCodeHarness } from '../harness/claude-code.ts';
import { OpenWorkerHarness } from '../harness/openworker.ts';
import { RoutingHarness } from '../harness/routing.ts';

const [command, ...rest] = process.argv.slice(2);
const stateDir = resolve(process.env.WORKFORCE_STATE_DIR ?? '.state');
mkdirSync(stateDir, { recursive: true });
const ledger = new AuditLedger(resolve(stateDir, 'audit.sqlite'));

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
  const config = loadConfig(resolve('config'));
  const gateway = new ModelGateway(config, ledger);
  const claudeDir = resolve(stateDir, 'claude-code');
  mkdirSync(claudeDir, { recursive: true });
  const harness = new RoutingHarness([
    { harness: new ClaudeCodeHarness({ cwd: claudeDir }), serves: (p) => p.api === 'claude-code' },
    { harness: new OpenWorkerHarness({ stateDir: resolve(stateDir, 'harness') }), serves: (p) => p.api !== 'claude-code' },
  ]);
  // Register only providers whose key is present; a policy that needs a missing one fails with a clear error.
  await harness.start({ providers: config.providers.filter((p) => !p.apiKeyEnv || process.env[p.apiKeyEnv]), tools: [] });
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
} else {
  console.error('Commands: ask <model-policy> <question> | verify-ledger');
  process.exit(2);
}
