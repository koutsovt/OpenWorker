// The only seam between the platform and an agent engine.
// Nothing outside src/harness/ may import an engine's SDK.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface ProviderSpec {
  name: string;
  /** `claude-code` is served by the Claude Code adapter and takes no key or URL. */
  api: 'responses' | 'chat-completions' | 'anthropic' | 'claude-code';
  baseUrl?: string;
  /** Name of the environment variable holding the key. The value never enters config. */
  apiKeyEnv?: string;
}

export interface ModelRef {
  provider: string;
  model: string;
}

export interface ToolCallContext {
  sessionId: string;
  callId: string;
  /** The tag given when the session was started; identifies the platform's agent instance. */
  tag: string;
}

export interface ToolSpec {
  /** Qualified name, `namespace.tool`. */
  name: string;
  description: string;
  inputSchema: Json;
  execute(args: Record<string, Json>, context: ToolCallContext): Promise<Json>;
}

export type PolicyDecision = { allow: true } | { allow: false; code: string; feedback?: string };

/** Must be pure and repeatable: engines may evaluate it more than once per call. */
export type PolicyCheck = (call: {
  sessionId: string;
  /** The tag given when the session was started. */
  tag: string;
  tool: string;
  arguments: Json;
}) => PolicyDecision | Promise<PolicyDecision>;

export interface AgentSpec {
  /** Immutable identity. A changed definition needs a new name. */
  name: string;
  instructions: string;
  model: ModelRef;
  /** Qualified tool names. A tool not listed is never offered to the model. */
  tools: string[];
  /** Subset of `tools` that pauses for a human decision on every call. */
  approvalRequired?: string[];
  limits?: { maxModelCalls: number; maxOutputTokens: number };
}

export interface Usage {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** False when any model call reported no usage. Unknown is not zero. */
  complete: boolean;
}

export interface ApprovalRequest {
  id: string;
  tool: string;
  arguments: Json;
}

export interface TurnFailure {
  category: string;
  retryable: boolean;
}

export interface TurnResult {
  status: 'completed' | 'needs_approval' | 'failed' | 'cancelled';
  output: string | null;
  approvals: ApprovalRequest[];
  failure?: TurnFailure;
  usage: Usage;
}

export interface TurnOptions {
  /** Application-owned instructions for this turn only. */
  addendum?: string;
}

export interface AgentSession {
  readonly id: string;
  /** Opaque string to persist; pass to `resumeSession` after a restart. */
  reference(): string;
  run(input: string, options?: TurnOptions): Promise<TurnResult>;
  respond(approvalId: string, decision: 'approve' | 'deny'): Promise<void>;
  /** Continue a turn after its approvals were answered. */
  resume(): Promise<TurnResult>;
  cancel(): Promise<void>;
}

export interface SessionOptions {
  model?: ModelRef;
  /** Opaque label passed back to the policy check and to tools for every call in this session. */
  tag?: string;
}

export interface HarnessSetup {
  providers: ProviderSpec[];
  tools: ToolSpec[];
  policy?: PolicyCheck;
}

export interface AgentHarness {
  start(setup: HarnessSetup): Promise<void>;
  defineAgent(spec: AgentSpec): Promise<void>;
  startSession(agent: string, options?: SessionOptions): Promise<AgentSession>;
  resumeSession(agent: string, reference: string, options?: { tag?: string }): Promise<AgentSession>;
  shutdown(): Promise<void>;
}

export const emptyUsage = (): Usage => ({ modelCalls: 0, inputTokens: 0, outputTokens: 0, complete: true });

export class HarnessError extends Error {
  readonly code: 'unknown_agent' | 'unknown_tool' | 'unknown_provider' | 'definition_conflict' | 'invalid_state';
  constructor(code: HarnessError['code'], message: string) {
    super(message);
    this.code = code;
  }
}
