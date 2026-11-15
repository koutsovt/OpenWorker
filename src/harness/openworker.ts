// OpenWorker Harness SDK adapter. The only file allowed to import the SDK.
import { Harness, hook, type AgentHandle, type Interruption, type RunStream, type Session } from '@openworkerai/harness-sdk';
import {
  HarnessError, emptyUsage,
  type AgentHarness, type AgentSession, type AgentSpec, type HarnessSetup, type Json, type ModelRef, type TurnOptions,
  type TurnResult, type Usage,
} from './port.ts';

type Approval = Extract<Interruption, { kind: 'approval' }>;

export interface OpenWorkerOptions {
  /** Absolute directory for durable harness state. */
  stateDir: string;
}

export class OpenWorkerHarness implements AgentHarness {
  private readonly options: OpenWorkerOptions;
  private harness: Harness | undefined;
  private readonly agents = new Map<string, { spec: AgentSpec; handle: AgentHandle }>();
  private toolNames = new Set<string>();
  private providerNames = new Set<string>();

  constructor(options: OpenWorkerOptions) {
    this.options = options;
  }

  async start(setup: HarnessSetup): Promise<void> {
    this.toolNames = new Set(setup.tools.map((t) => t.name));
    this.providerNames = new Set(setup.providers.map((p) => p.name));
    const policy = setup.policy;
    this.harness = await Harness.start({
      stateDir: this.options.stateDir,
      // No OS sandbox exists for the SDK on macOS; platform tools are read-only application callbacks.
      sandbox: 'off',
      hooks: policy && setup.tools.length
        ? [hook.beforeTool({
            name: 'platform-policy',
            tools: [...this.toolNames],
            run: async (ctx) => {
              const decision = await policy({ sessionId: ctx.sessionId, tool: String(ctx.tool), arguments: ctx.arguments });
              return decision.allow
                ? { action: 'allow' }
                : { action: 'block', code: decision.code, ...(decision.feedback ? { feedbackToModel: decision.feedback } : {}) };
            },
          })]
        : [],
    });
    for (const p of setup.providers) {
      await this.harness.setModelProvider({
        name: p.name, api: p.api,
        ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
        ...(p.apiKeyEnv ? { credentials: { apiKeyEnv: p.apiKeyEnv, storage: 'memory' as const } } : {}),
      });
    }
    const byNamespace = new Map<string, HarnessSetup['tools']>();
    for (const tool of setup.tools) {
      const [namespace, name] = tool.name.split('.');
      if (!namespace || !name || tool.name.split('.').length !== 2)
        throw new HarnessError('unknown_tool', `Tool name must be namespace.tool: ${tool.name}`);
      byNamespace.set(namespace, [...(byNamespace.get(namespace) ?? []), tool]);
    }
    for (const [namespace, tools] of byNamespace) {
      await this.harness.registerTools({
        namespace,
        tools: Object.fromEntries(tools.map((t) => [t.name.split('.')[1]!, {
          description: t.description,
          inputSchema: t.inputSchema,
          execute: (args: Record<string, Json>, ctx: { sessionId: string; callId: string }) =>
            t.execute(args, { sessionId: ctx.sessionId, callId: ctx.callId }),
        }])),
      });
    }
  }

  async defineAgent(spec: AgentSpec): Promise<void> {
    const harness = this.require();
    const existing = this.agents.get(spec.name);
    if (existing) {
      if (JSON.stringify(existing.spec) !== JSON.stringify(spec))
        throw new HarnessError('definition_conflict', `Agent ${spec.name} already defined differently`);
      return;
    }
    for (const tool of spec.tools)
      if (!this.toolNames.has(tool)) throw new HarnessError('unknown_tool', `Agent ${spec.name} lists unregistered tool ${tool}`);
    this.requireProvider(spec.model.provider);
    const handle = harness.createAgent({
      name: spec.name,
      instructions: spec.instructions,
      defaultModel: { provider: spec.model.provider, name: spec.model.model },
      tools: spec.tools,
      approvals: spec.approvalRequired?.length ? { mode: 'only', tools: spec.approvalRequired } : { mode: 'never' },
      ...(spec.limits ? { limits: spec.limits } : {}),
      // Platform-owned planning, memory and scheduling; the engine's built-ins stay off.
      planning: false, memory: false, scheduling: false,
      builtinTools: { askUser: false, readHistory: false },
    });
    try {
      await handle.ready();
    } catch (e) {
      // The published SDK reports a persisted-definition conflict as a bare remote rejection.
      throw new HarnessError('definition_conflict',
        `Engine rejected agent ${spec.name}; a different definition may already be stored under this name (${(e as Error).message})`);
    }
    this.agents.set(spec.name, { spec: structuredClone(spec), handle });
  }

  async startSession(agent: string, options: { model?: ModelRef } = {}): Promise<AgentSession> {
    const entry = this.agent(agent);
    if (options.model) this.requireProvider(options.model.provider);
    const session = await entry.handle.newSession(
      options.model ? { model: { provider: options.model.provider, name: options.model.model } } : {});
    return new OpenWorkerSession(session, this.toolNames);
  }

  async resumeSession(agent: string, reference: string): Promise<AgentSession> {
    return new OpenWorkerSession(await this.agent(agent).handle.resumeSession(JSON.parse(reference)), this.toolNames);
  }

  async shutdown(): Promise<void> {
    await this.harness?.shutdown();
    this.harness = undefined;
    this.agents.clear();
  }

  private requireProvider(name: string): void {
    if (!this.providerNames.has(name))
      throw new HarnessError('unknown_provider', `Provider ${name} is not registered. Is its API key set?`);
  }

  private require(): Harness {
    if (!this.harness) throw new HarnessError('invalid_state', 'Harness not started');
    return this.harness;
  }

  private agent(name: string) {
    this.require();
    const entry = this.agents.get(name);
    if (!entry) throw new HarnessError('unknown_agent', `Unknown agent ${name}`);
    return entry;
  }
}

class OpenWorkerSession implements AgentSession {
  private readonly session: Session;
  private stream: RunStream | undefined;
  private usage: Usage = emptyUsage();
  private pending = new Map<string, Approval>();

  private readonly toolNames: Set<string>;

  constructor(session: Session, toolNames: Set<string>) {
    this.session = session;
    this.toolNames = toolNames;
  }

  private qualified(alias: string): string {
    for (const name of this.toolNames) if (name === alias || name.replace('.', '__') === alias) return name;
    return alias;
  }

  get id(): string {
    return this.session.reference().session_id;
  }

  reference(): string {
    return JSON.stringify(this.session.reference());
  }

  async run(input: string, options: TurnOptions = {}): Promise<TurnResult> {
    this.usage = emptyUsage();
    const run = await this.session.send(input, options.addendum ? { instructionAddendum: options.addendum } : {});
    return this.consume(run.events());
  }

  async respond(approvalId: string, decision: 'approve' | 'deny'): Promise<void> {
    const pending = this.pending.get(approvalId);
    if (!pending) throw new HarnessError('invalid_state', 'No such pending approval');
    // Every sensitive call is approved individually; session-wide grants are never issued.
    await this.session.respond(pending, { decision: decision === 'approve' ? 'once' : 'deny' });
    this.pending.delete(approvalId);
  }

  async resume(): Promise<TurnResult> {
    if (!this.stream) throw new HarnessError('invalid_state', 'No turn to resume');
    if (this.pending.size) throw new HarnessError('invalid_state', 'Approval not answered');
    return this.consume(await this.session.resumeStreamed(this.stream.checkpoint()));
  }

  async cancel(): Promise<void> {
    await this.session.cancel();
  }

  private async consume(stream: RunStream): Promise<TurnResult> {
    this.stream = stream;
    let attempts = 0;
    let reported = 0;
    for await (const item of stream) {
      if (item.summary?.type === 'model_attempt_finished' && item.summary.status === 'completed') attempts++;
      if (item.event.type === 'model_usage') {
        const data = item.event.data as { input_tokens?: number; output_tokens?: number };
        reported++;
        this.usage.inputTokens += data.input_tokens ?? 0;
        this.usage.outputTokens += data.output_tokens ?? 0;
      }
    }
    this.usage.modelCalls += Math.max(attempts, reported);
    if (reported < attempts) this.usage.complete = false;
    const result = await stream.result();
    const usage = { ...this.usage };
    if (result.status === 'interrupted') {
      const approvals = result.interruptions.filter((i): i is Approval => i.kind === 'approval');
      for (const a of approvals) this.pending.set(a.id, a);
      if (approvals.length !== result.interruptions.length)
        return { status: 'failed', output: null, approvals: [], failure: { category: 'unexpected_interruption', retryable: false }, usage };
      return {
        status: 'needs_approval', output: null, usage,
        // The published SDK reports the model-facing alias (`ns__tool`); the platform speaks qualified names.
        approvals: approvals.map((a) => ({ id: a.id, tool: this.qualified(a.tool), arguments: a.arguments })),
      };
    }
    if (result.status === 'completed') return { status: 'completed', output: result.finalOutput, approvals: [], usage };
    if (result.status === 'cancelled') return { status: 'cancelled', output: null, approvals: [], usage };
    return {
      status: 'failed', output: null, approvals: [], usage,
      failure: result.providerError
        ? { category: result.providerError.category, retryable: result.providerError.retryable }
        : { category: result.failure ?? 'unknown', retryable: false },
    };
  }
}
