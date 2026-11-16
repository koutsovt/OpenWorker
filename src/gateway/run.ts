// Runs one task under a model policy, with approvals, a time limit and task-level fallback.
// A fallback starts a fresh session on the next approved model; a session is
// never switched mid-conversation, because engine state is bound to its provider.
import type { AuditLedger } from '../audit/ledger.ts';
import type { AgentHarness, AgentSpec, ApprovalRequest, TurnResult, Usage } from '../harness/port.ts';
import type { ModelGateway, Selection } from './gateway.ts';

export interface TaskRequest {
  /** Agent definition without a model; the gateway supplies it. */
  agent: Omit<AgentSpec, 'model'>;
  policy: string;
  input: string;
  /** `user:<id>` on whose behalf the task runs. */
  actor: string;
  /** Passed to the policy check and to tools for every call in the task's sessions. */
  tag?: string;
  /** Application-owned instructions for the turn. */
  addendum?: string;
  /** Answers approval requests. Without one, every request is denied: unattended runs never self-approve. */
  approve?: (request: ApprovalRequest) => Promise<'approve' | 'deny'>;
  /** Seconds before the session is cancelled. */
  timeoutSeconds?: number;
  /** Returns false once the task has done something that must not be repeated on another model. */
  mayFallBack?: () => boolean;
}

export interface TaskOutcome {
  result: TurnResult;
  model: string;
  tried: string[];
  /** Usage of every attempt, in order, including those that failed before a fallback. */
  attempts: { model: string; usage: Usage }[];
}

export async function runTask(
  harness: AgentHarness, gateway: ModelGateway, ledger: AuditLedger, request: TaskRequest,
): Promise<TaskOutcome> {
  const tried: string[] = [];
  const attempts: TaskOutcome['attempts'] = [];
  let selection: Selection | undefined = gateway.select(request.policy, request.actor);
  let last: TaskOutcome | undefined;
  while (selection) {
    tried.push(selection.alias);
    // The model is part of an immutable definition, so each model gets its own agent name.
    const name = `${request.agent.name}--${selection.alias}`;
    await harness.defineAgent({ ...request.agent, name, model: selection.ref });
    const session = await harness.startSession(name, request.tag !== undefined ? { tag: request.tag } : {});
    const started = ledger.append('task.started', request.actor, { agent: name, model: selection.alias, tag: request.tag ?? null });

    let timedOut = false;
    const timer = request.timeoutSeconds === undefined ? undefined
      : setTimeout(() => { timedOut = true; void session.cancel(); }, Math.max(0, request.timeoutSeconds) * 1000);
    let result: TurnResult;
    try {
      result = await session.run(request.input, request.addendum ? { addendum: request.addendum } : {});
      // The time limit also covers waiting for a person: once it has passed, the turn is not resumed.
      while (result.status === 'needs_approval' && !timedOut) {
        for (const approval of result.approvals) {
          const decision = request.approve ? await request.approve(approval) : 'deny';
          if (timedOut) break;
          await session.respond(approval.id, decision);
        }
        if (timedOut) break;
        result = await session.resume();
      }
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) result = { ...result, status: 'failed', output: null, failure: { category: 'timeout', retryable: false } };

    gateway.recordUsage(selection.alias, result.usage, `agent:${name}`, request.tag);
    ledger.append('task.finished', request.actor, {
      agent: name, startedSeq: started.seq, status: result.status, failure: result.failure?.category ?? null,
    });
    attempts.push({ model: selection.alias, usage: result.usage });
    last = { result, model: selection.alias, tried: [...tried], attempts: [...attempts] };
    // Fall back only on a retryable provider failure. Anything else needs a person or a fix.
    if (result.status !== 'failed' || !result.failure?.retryable) return last;
    if (request.mayFallBack && !request.mayFallBack()) {
      ledger.append('model.fallback_blocked', request.actor, { agent: name, reason: 'side_effects_already_made' });
      return last;
    }
    try {
      selection = gateway.fallback(request.policy, tried, request.actor, result.failure.category);
      if (selection) {
        const next = `${request.agent.name}--${selection.alias}`;
        await harness.defineAgent({ ...request.agent, name: next, model: selection.ref });
      }
    } catch (e) {
      // A fallback that cannot be set up (no model id, no key) must not hide the failure that caused it.
      ledger.append('model.fallback_failed', request.actor, { agent: name, reason: (e as Error).message });
      return last;
    }
  }
  return last!;
}
