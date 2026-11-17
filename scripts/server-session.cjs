// Operator deployment helper. Credentials arrive on stdin, never argv or files.
const { Client } = require('../desktop/node_modules/ssh2');
const path = require('node:path');
const net = require('node:net');
const { readFileSync } = require('node:fs');
let client;
const tunnels = [];
const emit = data => process.stdout.write(JSON.stringify(data) + '\n');
async function execute(command) {
  return new Promise((resolve, reject) => client.exec(command, (error, stream) => {
    if (error) return reject(error);
    let stdout = '', stderr = '';
    stream.on('data', data => { stdout += data; });
    stream.stderr.on('data', data => { stderr += data; });
    stream.on('close', code => resolve({ code, stdout, stderr }));
  }));
}
async function upload(files, remoteRoot) {
  const sftp = await new Promise((resolve, reject) => client.sftp((e, s) => e ? reject(e) : resolve(s)));
  try {
    for (const relative of files) {
      const local = path.resolve(__dirname, '..', relative);
      const root = path.resolve(__dirname, '..') + path.sep;
      if (!local.startsWith(root) || relative.includes('..') || relative === '.env') throw new Error('Invalid upload source');
      const remote = path.posix.join(remoteRoot, relative.replaceAll('\\', '/'));
      await new Promise((resolve, reject) => sftp.fastPut(local, remote, e => e ? reject(e) : resolve()));
    }
    return { uploaded: files.length };
  } finally { sftp.end(); }
}
async function configureDedicatedAuth(filename) {
  const token = readFileSync(filename, 'utf8').replace(/^\uFEFF/, '').trim();
  if (token.length < 16 || token.length > 8192 || /\s/.test(token)) throw new Error('Auth Token文件格式无效，需要单行Token');
  const code = [
    'import json, pathlib, os, tempfile, sys',
    'p=pathlib.Path("/opt/ta-llbot/bin/pmhq/pmhq_config.json")',
    'c=json.loads(p.read_text())',
    'assert c.get("qq_path","").startswith("/opt/ta-llbot/") and c.get("default_port")==13200, "Dedicated instance mismatch"',
    'token=json.load(sys.stdin)["token"]',
    'assert isinstance(token,str) and 16 <= len(token) <= 8192',
    'c["auth_token"]=token',
    'st=p.stat()',
    'fd,name=tempfile.mkstemp(prefix=".auth-",dir=str(p.parent))',
    'os.fchmod(fd,0o640)',
    'os.fchown(fd,st.st_uid,st.st_gid)',
    'with os.fdopen(fd,"w") as f: json.dump(c,f,ensure_ascii=False,indent=2)',
    'os.replace(name,p)',
    'print(json.dumps({"configured":True,"instance":"ta-llbot","tokenPrinted":False}))',
  ].join('\n');
  const quoted = "'" + code.replaceAll("'", "'\\''") + "'";
  return new Promise((resolve, reject) => client.exec('python3 -c ' + quoted, (error, stream) => {
    if (error) return reject(error);
    let stdout = '', stderr = '';
    stream.on('data', data => { stdout += data; });
    stream.stderr.on('data', data => { stderr += data; });
    stream.on('close', code => resolve({ code, stdout, stderr }));
    stream.end(JSON.stringify({ token }));
  }));
}
async function dispatch(request) {
  if (request.action === 'connect') {
    client = new Client();
    client.on('error', error => emit({ error: error.message }));
    let fingerprint;
    await new Promise((resolve, reject) => {
      client.once('ready', resolve); client.once('error', reject);
      client.connect({ host: request.host, port: 22, username: request.username, password: request.password, readyTimeout: 25000,
        keepaliveInterval: 15000, keepaliveCountMax: 3, hostHash: 'sha256',
        hostVerifier: hash => { fingerprint = 'SHA256:' + Buffer.from(hash, 'hex').toString('base64').replace(/=+$/, ''); return !request.fingerprint || fingerprint === request.fingerprint; },
      });
    });
    request.password = undefined; if (client.config) client.config.password = undefined;
    return { connected: true, fingerprint };
  }
  if (!client) throw new Error('Not connected');
  if (request.action === 'configure-dedicated-auth') return configureDedicatedAuth(request.filename);
  if (request.action === 'forward-llbot') {
    // This helper can expose only the assistant's dedicated loopback WebUI.
    const server = net.createServer(socket => {
      client.forwardOut('127.0.0.1', 0, '127.0.0.1', 13080, (error, channel) => {
        if (error) { socket.destroy(); return; }
        socket.on('error', () => channel.destroy());
        channel.on('error', () => socket.destroy());
        socket.pipe(channel).pipe(socket);
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
    });
    tunnels.push(server);
    client.once('close', () => server.close());
    return { url: 'http://127.0.0.1:' + server.address().port + '/', instance: 'ta-llbot', remotePort: 13080 };
  }
  if (request.action === 'exec') return execute(request.command);
  if (request.action === 'upload') return upload(request.files, request.remoteRoot);
  if (request.action === 'close') { for (const tunnel of tunnels) tunnel.close(); client.end(); setTimeout(() => process.exit(0), 100); return { closed: true }; }
  throw new Error('Unknown action');
}
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
let buffer = '', chain = Promise.resolve();
process.stdin.on('data', chunk => {
  if (chunk.includes('\x03')) { client?.end(); process.exit(0); }
  buffer += chunk;
  let newline;
  while ((newline = buffer.search(/[\r\n]/)) >= 0) {
    const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
    if (!line) continue;
    chain = chain.then(async () => {
      try { emit({ ok: true, data: await dispatch(JSON.parse(line)) }); }
      catch (error) { emit({ ok: false, error: error.message }); }
    });
  }
});
emit({ ready: true, credentialsOnStdin: true });
