import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { createInterface } from 'node:readline';

const socketPath = '/runner/bridge.sock';
function relay(path, method, body, done) {
  const req = request({ socketPath, path, method,
    headers: { 'content-type': 'application/json', 'content-length': body.length } }, done);
  req.end(body);
  return req;
}

if (process.argv[2] === 'mcp') {
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  for await (const line of createInterface({ input: process.stdin })) {
    let message; try { message = JSON.parse(line); } catch { continue; }
    const { id, method, params } = message;
    if (id === undefined) continue;
    const respond = result => send({ jsonrpc: '2.0', id, result });
    if (method === 'initialize') {
      respond({ protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'ta-course', version: '1.0.0' } });
    } else if (method === 'ping') respond({});
    else if (method === 'tools/list' || method === 'tools/call') {
      const body = Buffer.from(JSON.stringify(method === 'tools/list' ? {} : { name: params.name, args: params.arguments }));
      const req = relay('/tools', 'POST', body, async response => {
        try {
          const bytes = [];
          for await (const chunk of response) bytes.push(chunk);
          respond(JSON.parse(Buffer.concat(bytes).toString()));
        } catch { send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Course tool response unavailable' } }); }
      });
      req.on('error', () => send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Course bridge unavailable' } }));
    } else send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported method' } });
  }
} else {
  const model = process.argv[3], session = process.argv[4];
  const overlay = [
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model } },
    { insert: [{ id: 'ta-course-tools', name: '@deepseek-ai/dsh-mcp-client', config: {
      serverName: 'ta', transport: 'stdio', command: process.execPath, args: ['/runner/entry.mjs', 'mcp'],
      failOnStartupError: true, reconnect: { enabled: false },
    } }] },
  ];
  await writeFile('/tmp/ta-profile.yml', JSON.stringify(overlay));
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/anthropic/v1/messages') { res.writeHead(404).end(); return; }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const upstream = relay(req.url, 'POST', Buffer.concat(chunks), reply => {
        res.writeHead(reply.statusCode, { 'content-type': reply.headers['content-type'] ?? 'application/json' });
        reply.pipe(res);
      });
      upstream.on('error', () => res.writeHead(502).end());
    } catch { res.writeHead(502).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const args = ['--profile', 'headless', '--patch', '/tmp/ta-profile.yml',
    '--permission-mode', 'danger-full-access', '--approval-policy', 'never', '--json'];
  if (session) args.push('--session-id', session);
  const child = spawn('/opt/ta-dsh/runtime/node_modules/.bin/dsh', args, { stdio: 'inherit',
    env: { ...process.env, DSH_HOME: '/work/.dsh', DEEPSEEK_API_KEY: 'local-model-bridge',
      DEEPSEEK_BASE_URL: 'http://127.0.0.1:' + server.address().port + '/anthropic' } });
  const exit = await new Promise(resolve => { child.once('error', () => resolve(1)); child.once('close', resolve); });
  server.closeAllConnections();
  server.close();
  process.exitCode = exit ?? 1;
}
