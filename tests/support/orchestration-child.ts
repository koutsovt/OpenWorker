// Runs one orchestrated run in its own process so a test can kill it mid-flight.
// Usage: node orchestration-child.ts <registryDir> <stateDir> <runId> <slowMs>
import { buildPlatform } from './orchestration.ts';

const [registryDir, stateDir, runId, slowMs] = process.argv.slice(2);
const platform = await buildPlatform({
  registryDir: registryDir!, stateDir: stateDir!, slowMs: Number(slowMs),
  onSlow: (taskId) => console.log(`SLOW_STARTED ${taskId}`),
});
const summary = await platform.orchestrator.execute(runId!);
console.log(`FINISHED ${summary.status}`);
