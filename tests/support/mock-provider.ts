// OpenAI-compatible Chat Completions mock (streaming), driven by the shared scenario script.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { scenario, type Step } from './scenarios.ts';

/** `input` is the text of the user messages in the request. */
export type ProviderScript = (model: string, toolResults: number, input: string) => Step;

export interface MockProvider {
  url: string;
  requests: { model: string; tools: string[] }[];
  close(): void;
}

export function startMockProvider(script: ProviderScript = scenario): Promise<MockProvider> {
  const requests: MockProvider['requests'] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const r = JSON.parse(body || '{}') as {
        model: string; messages?: { role: string; content?: unknown }[]; tools?: { function?: { name: string } }[];
        stream_options?: { include_usage?: boolean };
      };
      requests.push({ model: r.model, tools: (r.tools ?? []).map((t) => t.function?.name ?? '') });
      const input = (r.messages ?? []).filter((m) => m.role === 'user')
        .map((m) => (typeof m.content === 'string' ? m.content : ((m.content ?? []) as { text?: string }[]).map((part) => part.text ?? '').join('')))
        .join('\n');
      const step = script(r.model, (r.messages ?? []).filter((m) => m.role === 'tool').length, input);
      if ('error' in step) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'slow down', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta: object, finish: string | null = null) =>
        res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: r.model,
          choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      if ('text' in step) {
        send({ role: 'assistant', content: step.text });
        send({}, 'stop');
      } else {
        send({ role: 'assistant', content: null, tool_calls: [
          { index: 0, id: `call_${requests.length}`, type: 'function', function: { name: step.tool.replace('.', '__'), arguments: '' } }] });
        send({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(step.args) } }] });
        send({}, 'tool_calls');
      }
      if (r.stream_options?.include_usage)
        res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: r.model, choices: [],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests, close: () => server.close(),
  })));
}
