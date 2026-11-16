// Claude Code adapter (Claude Agent SDK). For local, individual use on a
// personal Claude subscription only; hosted deployments use API-key providers
// through another adapter. The only file allowed to import the Agent SDK.
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  HarnessError, emptyUsage,
  type AgentHarness, type AgentSession, type AgentSpec, type ApprovalRequest, type HarnessSetup, type Json, type ModelRef,
  type PolicyCheck, type SessionOptions, type ToolSpec, type TurnOptions, type TurnResult, type Usage,
} from './port.ts';

const SERVER = 'platform';
const PREFIX = `mcp__${SERVER}__`;
/** `app.lookup` <-> `mcp__platform__app__lookup` */
const mcpName = (qualified: string) => PREFIX + qualified.replace('.', '__');
const localName = (qualified: string) => qualified.replace('.', '__');

// The slice of the Agent SDK this adapter uses, so tests can supply a scripted engine.
export interface EngineMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  tools?: string[];
  apiKeySource?: string;
  /** On assistant messages: `rate_limit`, `overloaded`, `server_error`, ... */
  error?: string;
  result?: string;
  num_turns?: number;
  api_error_status?: number | null;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
}
export type PermissionReply = { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string };
export interface EngineOptions {
  systemPrompt: string;
  model?: string;
  tools: string[];
  mcpServers: Record<string, unknown>;
  strictMcpConfig: boolean;
  settingSources: string[];
  permissionMode: 'default';
  resume?: string;
  maxTurns?: number;
  cwd?: string;
  abortController: AbortController;
  canUseTool(toolName: string, input: Record<string, unknown>, options: { signal: AbortSignal }): Promise<PermissionReply>;
  hooks: { PreToolUse: { hooks: ((input: { tool_name?: string; tool_input?: unknown }) => Promise<object>)[] }[] };
}
export type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>;
export interface ClaudeCodeEngine {
  query(args: { prompt: string; options: EngineOptions }): AsyncIterable<EngineMessage>;
  tool(name: string, description: string, shape: Record<string, unknown>, handler: ToolHandler): unknown;
  createSdkMcpServer(options: { name: string; version: string; tools: unknown[]; alwaysLoad: boolean }): unknown;
}

const sdkEngine: ClaudeCodeEngine = {
  query: (args) => query(args as unknown as Parameters<typeof query>[0]) as unknown as AsyncIterable<EngineMessage>,
  tool: (name, description, shape, handler) =>
    tool(name, description, shape as Parameters<typeof tool>[2], handler as unknown as Parameters<typeof tool>[3]),
  createSdkMcpServer: (options) => createSdkMcpServer(options as unknown as Parameters<typeof createSdkMcpServer>[0]),
};

/** Top-level JSON Schema object -> the Zod field map the Agent SDK expects. */
function zodShape(schema: Json): Record<string, unknown> {
  const s = schema as { properties?: Record<string, Json>; required?: string[] };
  return Object.fromEntries(Object.entries(s.properties ?? {}).map(([key, property]) => {
    const field = z.fromJSONSchema(property as Parameters<typeof z.fromJSONSchema>[0]);
    return [key, s.required?.includes(key) ? field : field.optional()];
  }));
}

export interface ClaudeCodeOptions {
  /** Working directory for the Claude Code process. Use an empty, dedicated folder. */
  cwd?: string;
  /** Test seam. Defaults to the real Agent SDK. */
  engine?: ClaudeCodeEngine;
}

export class ClaudeCodeHarness implements AgentHarness {
  private readonly options: ClaudeCodeOptions;
  private readonly engine: ClaudeCodeEngine;
  private readonly agents = new Map<string, AgentSpec>();
  private tools = new Map<string, ToolSpec>();
  private providers = new Set<string>();
  private policy: PolicyCheck | undefined;
  /** How the last session authenticated and what tools it was given; for local verification. */
  lastInit: { apiKeySource?: string; tools: string[] } | undefined;

  constructor(options: ClaudeCodeOptions = {}) {
    this.options = options;
    this.engine = options.engine ?? sdkEngine;
  }

  async start(setup: HarnessSetup): Promise<void> {
    for (const p of setup.providers)
      if (p.api !== 'claude-code') throw new HarnessError('unknown_provider', `Provider ${p.name} is not a claude-code provider`);
    this.providers = new Set(setup.providers.map((p) => p.name));
    this.tools = new Map(setup.tools.map((t) => [t.name, t]));
    this.policy = setup.policy;
  }

  async defineAgent(spec: AgentSpec): Promise<void> {
    const existing = this.agents.get(spec.name);
    // Claude Code keeps no definition store, so immutability is enforced here, per process.
    if (existing && JSON.stringify(existing) !== JSON.stringify(spec))
      throw new HarnessError('definition_conflict', `Agent ${spec.name} already defined differently`);
    for (const name of spec.tools)
      if (!this.tools.has(name)) throw new HarnessError('unknown_tool', `Agent ${spec.name} lists unregistered tool ${name}`);
    this.requireProvider(spec.model.provider);
    this.agents.set(spec.name, structuredClone(spec));
  }

  async startSession(agent: string, options: SessionOptions = {}): Promise<AgentSession> {
    const spec = this.agent(agent);
    if (options.model) this.requireProvider(options.model.provider);
    return this.session(spec, options.model ?? spec.model, undefined, options.tag ?? '');
  }

  async resumeSession(agent: string, reference: string, options: { tag?: string } = {}): Promise<AgentSession> {
    const spec = this.agent(agent);
    const saved = JSON.parse(reference) as { sessionId: string; model: ModelRef };
    return this.session(spec, saved.model, saved.sessionId, options.tag ?? '');
  }

  async shutdown(): Promise<void> {}

  private session(spec: AgentSpec, model: ModelRef, sessionId: string | undefined, tag: string): ClaudeCodeSession {
    return new ClaudeCodeSession({
      engine: this.engine, spec, model, sessionId, tag, policy: this.policy, cwd: this.options.cwd,
      tools: spec.tools.map((name) => this.tools.get(name)!),
      onInit: (init) => { this.lastInit = init; },
    });
  }

  private requireProvider(name: string): void {
    if (!this.providers.has(name)) throw new HarnessError('unknown_provider', `Provider ${name} is not registered`);
  }

  private agent(name: string): AgentSpec {
    const spec = this.agents.get(name);
    if (!spec) throw new HarnessError('unknown_agent', `Unknown agent ${name}`);
    return spec;
  }
}

interface SessionDeps {
  engine: ClaudeCodeEngine;
  spec: AgentSpec;
  model: ModelRef;
  sessionId: string | undefined;
  tag: string;
  policy: PolicyCheck | undefined;
  cwd: string | undefined;
  tools: ToolSpec[];
  onInit(init: { apiKeySource?: string; tools: string[] }): void;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

class ClaudeCodeSession implements AgentSession {
  private readonly deps: SessionDeps;
  private sessionId: string | undefined;
  private signal = deferred<TurnResult>();
  private pending: { request: ApprovalRequest; decide(decision: 'approve' | 'deny'): void; answered: boolean } | undefined;
  private abort: AbortController | undefined;
  private running = false;
  /** How the current turn ended, once the engine has stopped. Lets `resume` answer after a cancel during an approval. */
  private ended: TurnResult | undefined;

  constructor(deps: SessionDeps) {
    this.deps = deps;
    this.sessionId = deps.sessionId;
  }

  get id(): string {
    if (!this.sessionId) throw new HarnessError('invalid_state', 'Session has no id until its first turn starts');
    return this.sessionId;
  }

  reference(): string {
    return JSON.stringify({ sessionId: this.id, model: this.deps.model });
  }

  async run(input: string, options: TurnOptions = {}): Promise<TurnResult> {
    if (this.running) throw new HarnessError('invalid_state', 'A turn is already running');
    this.running = true;
    this.ended = undefined;
    this.signal = deferred<TurnResult>();
    this.abort = new AbortController();
    // The addendum is application-owned text; it is labelled so it cannot be mistaken for the task.
    const prompt = options.addendum ? `[Application instructions for this turn]\n${options.addendum}\n\n[Task]\n${input}` : input;
    void this.pump(prompt);
    return this.signal.promise;
  }

  async respond(approvalId: string, decision: 'approve' | 'deny'): Promise<void> {
    if (!this.pending || this.pending.request.id !== approvalId || this.pending.answered)
      throw new HarnessError('invalid_state', 'No such pending approval');
    this.pending.answered = true;
    this.pendingDecision = decision;
  }
  private pendingDecision: 'approve' | 'deny' | undefined;

  async resume(): Promise<TurnResult> {
    const pending = this.pending;
    if (!pending || !pending.answered || !this.pendingDecision) throw new HarnessError('invalid_state', 'Approval not answered');
    this.signal = deferred<TurnResult>();
    this.pending = undefined;
    pending.decide(this.pendingDecision);
    this.pendingDecision = undefined;
    // The engine may already have stopped (cancelled or failed while the approval waited); nothing else would answer.
    if (this.ended) this.signal.resolve(this.ended);
    return this.signal.promise;
  }

  async cancel(): Promise<void> {
    this.abort?.abort();
  }

  /** One decision function for both enforcement points, so they cannot disagree. */
  private async verdict(toolName: string, input: unknown): Promise<{ allow: true; qualified: string } | { allow: false; message: string }> {
    const spec = this.deps.spec;
    const qualified = spec.tools.find((name) => mcpName(name) === toolName);
    if (!qualified) return { allow: false, message: `Tool ${toolName} is not available to this agent.` };
    const decision = this.deps.policy
      ? await this.deps.policy({ sessionId: this.sessionId ?? '', tag: this.deps.tag, tool: qualified, arguments: input as Json })
      : ({ allow: true } as const);
    if (!decision.allow) return { allow: false, message: decision.feedback ?? `Denied by policy (${decision.code}).` };
    return { allow: true, qualified };
  }

  private async pump(prompt: string): Promise<void> {
    const { engine, spec, model } = this.deps;
    const server = engine.createSdkMcpServer({
      name: SERVER, version: '1.0.0', alwaysLoad: true,
      tools: this.deps.tools.map((t) => engine.tool(localName(t.name), t.description, zodShape(t.inputSchema), async (args) => {
        const result = await t.execute(args as Record<string, Json>, { sessionId: this.sessionId ?? '', callId: '', tag: this.deps.tag });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      })),
    });
    const usage: Usage = emptyUsage();
    let lastError: string | undefined;
    let finished = false;
    const finish = (result: TurnResult) => {
      if (finished) return;
      finished = true;
      this.running = false;
      this.ended = result;
      this.signal.resolve(result);
    };
    const options: EngineOptions = {
      systemPrompt: spec.instructions,
      ...(model.model !== 'default' ? { model: model.model } : {}),
      // No built-in tools at all: no shell, no file access, no web. Only the agent's platform tools.
      tools: [],
      mcpServers: { [SERVER]: server },
      strictMcpConfig: true,
      // Ignore user, project and local Claude Code settings so nothing outside this platform grants access.
      settingSources: [],
      permissionMode: 'default',
      ...(this.sessionId ? { resume: this.sessionId } : {}),
      ...(spec.limits ? { maxTurns: spec.limits.maxModelCalls } : {}),
      ...(this.deps.cwd ? { cwd: this.deps.cwd } : {}),
      abortController: this.abort!,
      hooks: { PreToolUse: [{ hooks: [async (input) => {
        const verdict = await this.verdict(String(input.tool_name), input.tool_input);
        return verdict.allow ? {} : { hookSpecificOutput: {
          hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.message } };
      }] }] },
      canUseTool: async (toolName, input) => {
        const verdict = await this.verdict(toolName, input);
        if (!verdict.allow) return { behavior: 'deny', message: verdict.message };
        if (spec.approvalRequired?.includes(verdict.qualified)) {
          const decision = deferred<'approve' | 'deny'>();
          const request = { id: crypto.randomUUID(), tool: verdict.qualified, arguments: input as Json };
          this.pending = { request, decide: decision.resolve, answered: false };
          this.signal.resolve({ status: 'needs_approval', output: null, approvals: [request], usage: { ...usage } });
          // A cancel while waiting counts as a denial, so the engine is not left suspended.
          const aborted = new Promise<'deny'>((ok) => this.abort?.signal.addEventListener('abort', () => ok('deny'), { once: true }));
          if ((await Promise.race([decision.promise, aborted])) === 'deny') return { behavior: 'deny', message: 'A human reviewer denied this action. Do not retry it.' };
        }
        return { behavior: 'allow', updatedInput: input };
      },
    };
    try {
      for await (const message of engine.query({ prompt, options })) {
        if (message.session_id) this.sessionId = message.session_id;
        if (message.type === 'system' && message.subtype === 'init')
          this.deps.onInit({ ...(message.apiKeySource ? { apiKeySource: message.apiKeySource } : {}), tools: message.tools ?? [] });
        if (message.type === 'assistant' && message.error) lastError = message.error;
        if (message.type !== 'result') continue;
        const u = message.usage ?? {};
        usage.modelCalls = message.num_turns ?? 0;
        usage.inputTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        usage.outputTokens = u.output_tokens ?? 0;
        usage.complete = message.usage !== undefined;
        if (message.subtype === 'success') finish({ status: 'completed', output: message.result ?? '', approvals: [], usage });
        else if (message.subtype === 'error_max_turns')
          finish({ status: 'failed', output: null, approvals: [], failure: { category: 'limit', retryable: false }, usage });
        else finish({ status: 'failed', output: null, approvals: [], usage, failure: failureOf(lastError, message.api_error_status) });
      }
      finish({ status: 'failed', output: null, approvals: [], usage, failure: failureOf(lastError, undefined) });
    } catch {
      // A single-shot query throws after an error result, and on abort.
      finish(this.abort?.signal.aborted
        ? { status: 'cancelled', output: null, approvals: [], usage }
        : { status: 'failed', output: null, approvals: [], usage, failure: failureOf(lastError, undefined) });
    }
  }
}

function failureOf(error: string | undefined, status: number | null | undefined): { category: string; retryable: boolean } {
  const retryable = ['rate_limit', 'overloaded', 'server_error'].includes(error ?? '') || status === 429 || (status ?? 0) >= 500;
  return { category: error ?? (status ? `http_${status}` : 'unknown'), retryable };
}
