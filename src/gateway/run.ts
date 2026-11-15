// Runs one task under a model policy, with task-level fallback.
// A fallback starts a fresh session on the next approved model; a session is
// never switched mid-conversation, because engine state is bound to its provider.
import type { AuditLedger } from '../audit/ledger.ts';
import type { AgentHarness, AgentSpec, TurnResult } from '../harness/port.ts';
import type { ModelGateway, Selection } from './gateway.ts';

export interface TaskRequest {
  /** Agent definition without a model; the gateway supplies it. */
  agent: Omit<AgentSpec, 'model'>;
  policy: string;
  input: string;
  /** `user:<id>` on whose behalf the task runs. */
  actor: string;
}

export interface TaskOutcome {
  result: TurnResult;
  model: string;
  tried: string[];
}

export async function runTask(
  harness: AgentHarness, gateway: ModelGateway, ledger: AuditLedger, request: TaskRequest,
): Promise<TaskOutcome> {
  const tried: string[] = [];
  let selection: Selection | undefined = gateway.select(request.policy, request.actor);
  let last: TaskOutcome | undefined;
  while (selection) {
    tried.push(selection.alias);
    // The model is part of an immutable definition, so each model gets its own agent name.
    const name = `${request.agent.name}--${selection.alias}`;
    await harness.defineAgent({ ...request.agent, name, model: selection.ref });
    const session = await harness.startSession(name);
    ledger.append('task.started', request.actor, { agent: name, session: session.id, model: selection.alias });
    const result = await session.run(request.input);
    gateway.recordUsage(selection.alias, result.usage, `agent:${name}#${session.id}`);
    ledger.append('task.finished', request.actor, {
      agent: name, session: session.id, status: result.status, failure: result.failure?.category ?? null,
    });
    last = { result, model: selection.alias, tried: [...tried] };
    // Fall back only on a retryable provider failure. Anything else needs a person or a fix.
    if (result.status !== 'failed' || !result.failure?.retryable) return last;
    selection = gateway.fallback(request.policy, tried, request.actor, result.failure.category);
  }
  return last!;
}
