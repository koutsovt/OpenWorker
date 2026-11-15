// One script drives both the fake adapter and the mock HTTP provider, so the
// same contract tests exercise every harness adapter.
import type { Json } from '../../src/harness/port.ts';

export type Step =
  | { text: string }
  | { tool: string; args: Record<string, Json> }
  | { error: 'rate_limit' };

/** `toolResults` is the number of tool results already in the conversation. */
export function scenario(model: string, toolResults: number): Step {
  switch (model) {
    case 'mock-tools':
      if (toolResults === 0) return { tool: 'app.lookup', args: { q: 'PRIME integration' } };
      if (toolResults === 1) return { tool: 'app.forbidden', args: { target: 'prod' } };
      if (toolResults === 2) return { tool: 'app.submit_result', args: { verdict: 'pass', findings: ['ok'] } };
      return { text: 'Done after tools.' };
    case 'mock-unlisted':
      if (toolResults === 0) return { tool: 'app.forbidden', args: { target: 'prod' } };
      return { text: 'Tried an unlisted tool.' };
    case 'mock-sensitive':
      if (toolResults === 0) return { tool: 'app.sensitive', args: { action: 'write' } };
      return { text: 'Sensitive step handled.' };
    case 'mock-429':
      return { error: 'rate_limit' };
    default:
      return { text: `Hello from ${model}.` };
  }
}
