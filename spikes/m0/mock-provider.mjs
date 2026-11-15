// Minimal OpenAI-compatible Chat Completions mock (streaming). Test infrastructure only.
import http from 'node:http';

const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const chunk = (model, delta, finish = null) => ({
  id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 0, model,
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const toolCall = (res, model, id, name, args) => {
  sse(res, chunk(model, { role: 'assistant', content: null, tool_calls: [
    { index: 0, id, type: 'function', function: { name, arguments: '' } }] }));
  sse(res, chunk(model, { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }));
  sse(res, chunk(model, {}, 'tool_calls'));
};
const text = (res, model, t) => {
  sse(res, chunk(model, { role: 'assistant', content: t }));
  sse(res, chunk(model, {}, 'stop'));
};

export function startMock() {
  const seen = []; // one record per request
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      const r = JSON.parse(body || '{}');
      const model = r.model;
      const toolMsgs = (r.messages ?? []).filter((m) => m.role === 'tool').length;
      seen.push({ model, toolMsgs, tools: (r.tools ?? []).map((t) => t.function?.name), at: Date.now(),
        auth: req.headers.authorization ?? null, usageRequested: r.stream_options?.include_usage === true });
      if (model === 'mock-429') {
        res.writeHead(429, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'slow down', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (model === 'mock-slow') await new Promise((ok) => setTimeout(ok, 1500));
      if (model === 'mock-tools') {
        if (toolMsgs === 0) toolCall(res, model, 'call_1', 'app__lookup', { q: 'PRIME integration' });
        else if (toolMsgs === 1) toolCall(res, model, 'call_2', 'app__forbidden', { target: 'prod' });
        else if (toolMsgs === 2) toolCall(res, model, 'call_3', 'app__submit_result', { verdict: 'pass', findings: ['ok'] });
        else text(res, model, 'Done after tools.');
      } else if (model === 'mock-bad-submit') {
        if (toolMsgs === 0) toolCall(res, model, 'call_1', 'app__submit_result', { verdict: 42 });
        else text(res, model, 'Gave up.');
      } else if (model === 'mock-sensitive') {
        if (toolMsgs === 0) toolCall(res, model, 'call_1', 'app__sensitive', { action: 'write' });
        else text(res, model, 'Sensitive step handled.');
      } else text(res, model, `Hello from ${model}.`);
      if (r.stream_options?.include_usage)
        sse(res, { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 0, model, choices: [],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () =>
    ok({ url: `http://127.0.0.1:${server.address().port}/v1`, seen, close: () => server.close() })));
}
