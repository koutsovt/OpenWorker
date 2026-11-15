// Scripted stand-in for the Claude Agent SDK, driven by the shared scenarios.
// It follows the SDK's documented order: PreToolUse hooks, then canUseTool, then the tool handler.
import { randomUUID } from 'node:crypto';
import type { ClaudeCodeEngine, EngineMessage, ToolHandler } from '../../src/harness/claude-code.ts';
import { scenario, type Step } from './scenarios.ts';

interface FakeTool { name: string; handler: ToolHandler }

export function fakeClaudeEngine(script: (model: string, toolResults: number, input: string) => Step = scenario): ClaudeCodeEngine {
  return {
    tool: (name, _description, _shape, handler) => ({ name, handler }),
    createSdkMcpServer: (options) => ({ name: options.name, tools: options.tools }),
    async *query({ prompt, options }): AsyncIterable<EngineMessage> {
      const sessionId = options.resume ?? randomUUID();
      const tools = new Map<string, FakeTool>(Object.entries(options.mcpServers).flatMap(([server, value]) =>
        ((value as { tools: FakeTool[] }).tools).map((t) => [`mcp__${server}__${t.name}`, t] as const)));
      yield { type: 'system', subtype: 'init', session_id: sessionId, tools: [...options.tools, ...tools.keys()], apiKeySource: 'oauth' };
      let toolResults = 0;
      let turns = 0;
      const usage = () => ({ input_tokens: 100 * turns, output_tokens: 20 * turns });
      while (true) {
        if (options.abortController.signal.aborted) throw new Error('aborted');
        const step = script(options.model ?? 'default', toolResults, prompt);
        turns++;
        if ('error' in step) {
          yield { type: 'assistant', session_id: sessionId, error: step.error };
          yield { type: 'result', subtype: 'error_during_execution', session_id: sessionId, num_turns: turns, api_error_status: 429 };
          throw new Error('Claude Code returned an error result');
        }
        if ('text' in step) {
          yield { type: 'result', subtype: 'success', session_id: sessionId, result: step.text, num_turns: turns, usage: usage() };
          return;
        }
        const name = `mcp__platform__${step.tool.replace('.', '__')}`;
        const found = tools.get(name);
        if (found) {
          const hookOutputs = await Promise.all(options.hooks.PreToolUse.flatMap((m) => m.hooks).map((h) => h({ tool_name: name, tool_input: step.args })));
          const denied = hookOutputs.some((o) => (o as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision === 'deny');
          if (!denied) {
            const reply = await options.canUseTool(name, step.args, { signal: options.abortController.signal });
            if (reply.behavior === 'allow') await found.handler(reply.updatedInput);
          }
        }
        toolResults++;
      }
    },
  };
}
