// Scripted in-memory harness. Enforces the same contract as a real engine so
// orchestration and governance can be tested without model calls.
import { randomUUID } from 'node:crypto';
import {
  HarnessError, emptyUsage,
  type AgentHarness, type AgentSession, type AgentSpec, type ApprovalRequest, type HarnessSetup, type Json,
  type ModelRef, type PolicyCheck, type SessionOptions, type ToolSpec, type TurnOptions, type TurnResult, type Usage,
} from './port.ts';

export type FakeStep =
  | { text: string }
  | { tool: string; args: Record<string, Json> }
  | { error: 'rate_limit' };
export type FakeScript = (model: string, toolResults: number, input: string, options: TurnOptions) => FakeStep;

interface SessionState {
  id: string;
  agent: AgentSpec;
  model: ModelRef;
  toolResults: number;
  input: string;
  options: TurnOptions;
  usage: Usage;
  pending?: { request: ApprovalRequest; decision?: 'approve' | 'deny' };
  cancelled: boolean;
  tag: string;
}

export class FakeHarness implements AgentHarness {
  private readonly script: FakeScript;
  private readonly sessions = new Map<string, SessionState>();
  private readonly agents = new Map<string, AgentSpec>();
  private tools = new Map<string, ToolSpec>();
  private providers = new Set<string>();
  private policy: PolicyCheck | undefined;

  constructor(script: FakeScript) {
    this.script = script;
  }

  async start(setup: HarnessSetup): Promise<void> {
    this.tools = new Map(setup.tools.map((t) => [t.name, t]));
    this.providers = new Set(setup.providers.map((p) => p.name));
    this.policy = setup.policy;
  }

  async defineAgent(spec: AgentSpec): Promise<void> {
    const existing = this.agents.get(spec.name);
    if (existing && JSON.stringify(existing) !== JSON.stringify(spec))
      throw new HarnessError('definition_conflict', `Agent ${spec.name} already defined differently`);
    for (const tool of spec.tools)
      if (!this.tools.has(tool)) throw new HarnessError('unknown_tool', `Agent ${spec.name} lists unregistered tool ${tool}`);
    if (!this.providers.has(spec.model.provider))
      throw new HarnessError('unknown_provider', `Unknown provider ${spec.model.provider}`);
    this.agents.set(spec.name, structuredClone(spec));
  }

  async startSession(agent: string, options: SessionOptions = {}): Promise<AgentSession> {
    const spec = this.agents.get(agent);
    if (!spec) throw new HarnessError('unknown_agent', `Unknown agent ${agent}`);
    const model = options.model ?? spec.model;
    if (!this.providers.has(model.provider)) throw new HarnessError('unknown_provider', `Unknown provider ${model.provider}`);
    const state: SessionState = {
      id: randomUUID(), agent: spec, model, toolResults: 0, input: '', options: {}, usage: emptyUsage(), cancelled: false, tag: options.tag ?? '',
    };
    this.sessions.set(state.id, state);
    return this.handle(state);
  }

  async resumeSession(agent: string, reference: string, options: { tag?: string } = {}): Promise<AgentSession> {
    const state = this.sessions.get(reference);
    if (!state || state.agent.name !== agent) throw new HarnessError('invalid_state', 'Unknown session reference');
    if (options.tag !== undefined) state.tag = options.tag;
    return this.handle(state);
  }

  async shutdown(): Promise<void> {}

  private handle(state: SessionState): AgentSession {
    return {
      id: state.id,
      reference: () => state.id,
      run: async (input, options = {}) => {
        state.input = input;
        state.options = options;
        state.usage = emptyUsage();
        state.cancelled = false;
        return this.loop(state);
      },
      respond: async (approvalId, decision) => {
        if (state.pending?.request.id !== approvalId) throw new HarnessError('invalid_state', 'No such pending approval');
        state.pending.decision = decision;
      },
      resume: async () => {
        const pending = state.pending;
        if (!pending?.decision) throw new HarnessError('invalid_state', 'Approval not answered');
        state.pending = undefined;
        if (pending.decision === 'approve') await this.execute(state, pending.request.tool, pending.request.arguments, pending.request.id);
        state.toolResults++;
        return this.loop(state);
      },
      cancel: async () => {
        state.cancelled = true;
      },
    };
  }

  private async execute(state: SessionState, tool: string, args: Json, callId: string): Promise<void> {
    await this.tools.get(tool)!.execute(args as Record<string, Json>, { sessionId: state.id, callId, tag: state.tag });
  }

  private async loop(state: SessionState): Promise<TurnResult> {
    const limit = state.agent.limits?.maxModelCalls ?? 50;
    while (true) {
      if (state.cancelled) return { status: 'cancelled', output: null, approvals: [], usage: state.usage };
      if (state.usage.modelCalls >= limit)
        return { status: 'failed', output: null, approvals: [], failure: { category: 'limit', retryable: false }, usage: state.usage };
      const step = this.script(state.model.model, state.toolResults, state.input, state.options);
      state.usage.modelCalls++;
      if ('error' in step)
        return { status: 'failed', output: null, approvals: [], failure: { category: step.error, retryable: true }, usage: state.usage };
      state.usage.inputTokens += 100;
      state.usage.outputTokens += 20;
      if ('text' in step) return { status: 'completed', output: step.text, approvals: [], usage: state.usage };

      const callId = randomUUID();
      // A tool outside the definition is rejected without running; the model is told and continues.
      if (state.agent.tools.includes(step.tool)) {
        const decision = this.policy
          ? await this.policy({ sessionId: state.id, tag: state.tag, tool: step.tool, arguments: step.args })
          : ({ allow: true } as const);
        if (decision.allow) {
          if (state.agent.approvalRequired?.includes(step.tool)) {
            const request = { id: callId, tool: step.tool, arguments: step.args };
            state.pending = { request };
            return { status: 'needs_approval', output: null, approvals: [request], usage: state.usage };
          }
          await this.execute(state, step.tool, step.args, callId);
        }
      }
      state.toolResults++;
    }
  }
}
