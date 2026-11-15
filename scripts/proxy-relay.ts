// Local relay for networks that require an outbound HTTP proxy.
// The OpenWorker engine's model client ignores proxy settings, so behind a proxy
// it cannot reach a provider directly. This relay listens on loopback and
// forwards to one upstream host through the proxy that Node is configured to use.
//
//   NODE_USE_ENV_PROXY=1 node scripts/proxy-relay.ts https://api.deepseek.com 8787
//
// Then use http://127.0.0.1:8787/v1 as the provider base URL. Development use only.
import http from 'node:http';
import { Readable } from 'node:stream';

const [upstream, port = '8787'] = process.argv.slice(2);
if (!upstream?.startsWith('https://')) {
  console.error('Usage: NODE_USE_ENV_PROXY=1 node scripts/proxy-relay.ts https://<provider-host> [port]');
  process.exit(2);
}

http.createServer(async (req, res) => {
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers))
      if (typeof value === 'string' && !['host', 'connection', 'content-length'].includes(name)) headers.set(name, value);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const response = await fetch(new URL(req.url ?? '/', upstream), {
      method: req.method, headers,
      ...(hasBody ? { body: Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
    } as RequestInit);
    const out: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(name)) out[name] = value;
    });
    res.writeHead(response.status, out);
    if (response.body) Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream).pipe(res);
    else res.end();
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `relay: ${(e as Error).message}` } }));
  }
}).listen(Number(port), '127.0.0.1', () => console.error(`Relaying http://127.0.0.1:${port} -> ${upstream}`));
