const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const { generateKeyPairSync, createHash } = require('node:crypto');
const { Server, utils: { sftp: { STATUS_CODE } } } = require('ssh2');
const { SSHSession, validateProfile, adminTokenFromEnv, allowRequest, kernelPortFromEnv, verifiedQrImage, llbotInstanceFromEnv } = require('../lib/ssh-session.cjs');
const { DemoSession } = require('../lib/demo.cjs');

test('连接配置只保留非敏感字段；令牌解析不执行env内容', () => {
  const profile = validateProfile({ host: '127.0.0.1', username: 'teacher', password: 'private', remoteDir: '/opt/ta-super-agent' });
  assert.equal(profile.password, undefined); assert.equal(profile.port, 22);
  assert.equal(adminTokenFromEnv('OTHER=anything\nADMIN_TOKEN="server-token-123456789" # note'), 'server-token-123456789');
  assert.throws(() => validateProfile({ host: 'http://bad', username: 'x' }), /IP/);
  assert.throws(() => adminTokenFromEnv('ADMIN_TOKEN=short'), /无效/);
  assert.equal(allowRequest('GET', '/v1/courses'), true);
  assert.equal(allowRequest('GET', '/v1/courses/math/conversation'), true);
  assert.equal(allowRequest('POST', '/v1/courses/math/conversation'), true);
  assert.equal(allowRequest('DELETE', '/v1/courses/math/conversation'), false);
  assert.equal(allowRequest('POST', '/hooks/qq'), false);
  assert.equal(allowRequest('GET', 'http://attacker/'), false);
  assert.equal(allowRequest('GET', '/v1/courses/math/memories'), true);
  assert.equal(allowRequest('PUT', '/v1/memories/m1'), true);
  assert.equal(allowRequest('POST', '/v1/memory-jobs/j1/retry'), true);
  assert.equal(allowRequest('POST', '/v1/memories/m1'), false);
  assert.equal(allowRequest('GET', '/v1/courses/math/inbox'), true);
  assert.equal(allowRequest('GET', '/v1/courses/math/inbox?limit=10'), false);
  assert.equal(allowRequest('POST', '/v1/courses/math/inbox'), false);
  assert.equal(allowRequest('GET', '/v1/courses/math/alerts'), true);
  assert.equal(kernelPortFromEnv('PORT=18787\n', 8787), 18787);
  assert.throws(() => verifiedQrImage(Buffer.from('<html>not QR</html>').toString('base64')), /格式无效/);
  const absent = llbotInstanceFromEnv('ADMIN_TOKEN=valid-token-value-but-no-instance');
  assert.equal(absent.llbotConfigured, false); assert.equal(absent.llbotPort, 13080);  assert.equal(absent.llbotDataDir, '/var/lib/ta-llbot/data');
});

async function mockServer() {
  const token = 'test-admin-token-1234567', clients = new Set();
  const llbotToken = 'llbot-test-token', png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lX8AAAAASUVORK5CYII=';
  let online = true, qrRequests = 0, setupState = 'ready';
  const kernel = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/api/')) {
      if (req.headers['x-webui-token'] !== createHash('sha256').update(llbotToken).digest('hex')) { res.statusCode = 401; res.end('{"success":false}'); return; }
      if (req.url === '/api/login-info') res.end(JSON.stringify({ success: true, data: { online, uin: 'test-qq' } }));
      else { qrRequests++; res.end(JSON.stringify({ success: true, data: { pngBase64QrcodeData: png } })); }
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) { res.statusCode = 401; res.end('{"message":"未授权"}'); return; }
    if (req.url === '/health') res.end('{"status":"ok"}');
    else res.end(JSON.stringify([{ id: 'math', title: '数学分析' }]));
  });
  kernel.listen(0, '127.0.0.1'); await once(kernel, 'listening');
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const server = new Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('close', () => clients.delete(client)); client.on('error', () => {});
    client.on('authentication', context => context.method === 'password' && context.username === 'teacher' && context.password === 'test-password' ? context.accept() : context.reject());
    client.on('ready', () => {
      client.on('session', accept => accept().on('sftp', acceptSftp => {
        const stream = acceptSftp();
        const files = new Map([['/opt/ta-super-agent/.env', Buffer.from(`ADMIN_TOKEN=${token}\nMODEL_API_KEY=must-not-reach-renderer\nPORT=${kernel.address().port}\nLLBOT_INSTANCE_ID=ta-llbot\nLLBOT_WEBUI_PORT=${kernel.address().port}\nLLBOT_DATA_DIR=/var/lib/ta-llbot/data\nLLBOT_SETUP_STATE=${setupState}\n`)], ['/var/lib/ta-llbot/data/webui_token.txt', Buffer.from(llbotToken)]]);
        const attrs = filename => ({ size: files.get(filename).length, mode: 0o100600, uid: 0, gid: 0, atime: 1, mtime: 1 });
        stream.on('STAT', (id, filename) => files.has(filename) ? stream.attrs(id, attrs(filename)) : stream.status(id, STATUS_CODE.NO_SUCH_FILE));
        stream.on('OPEN', (id, filename) => stream.handle(id, Buffer.from(filename)));
        stream.on('FSTAT', (id, handle) => stream.attrs(id, attrs(handle.toString())));
        stream.on('READ', (id, handle, offset, length) => { const contents = files.get(handle.toString()); offset >= contents.length ? stream.status(id, STATUS_CODE.EOF) : stream.data(id, contents.subarray(offset, offset + length)); });
        stream.on('CLOSE', id => stream.status(id, STATUS_CODE.OK));
      }));
      client.on('tcpip', (accept, reject, info) => {
        if (info.destIP !== '127.0.0.1' || info.destPort !== kernel.address().port) { reject(); return; }
        const socket = net.connect(info.destPort, '127.0.0.1');
        socket.once('connect', () => { const channel = accept(); channel.pipe(socket).pipe(channel); channel.on('close', () => socket.destroy()); });
        socket.on('error', () => reject());
      });
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { input: { host: '127.0.0.1', port: server.address().port, username: 'teacher', password: 'test-password', apiPort: 1, llbotPort: kernel.address().port, remoteDir: '/opt/ta-super-agent' },
    setOnline: value => { online = value; }, setSetupState: value => { setupState = value; }, qrRequests: () => qrRequests,
    close: async () => { for (const c of clients) c.end(); await new Promise(r => server.close(r)); await new Promise(r => kernel.close(r)); },
  };
}

test('真实SSH密码认证、SFTP读取管理令牌、加密通道访问内核', async () => {
  const server = await mockServer(); let fingerprint, saved;
  const session = new SSHSession({ verifyHost: (_p, f) => { fingerprint = f; return true; }, onVerified: p => { saved = p; } });
  try {
    const profile = await session.connect({ ...server.input, llbotPort: 3080, llbotDataDir: '/home/qqbot/LLBot/bin/llbot/data' });
    assert.match(fingerprint, /^SHA256:/);
    assert.equal(profile.password, undefined); assert.equal(saved.password, undefined);
    assert.equal(profile.llbotInstance, 'ta-llbot'); assert.equal(profile.llbotDataDir, '/var/lib/ta-llbot/data');
    assert.notEqual(profile.llbotPort, 3080);
    assert.deepEqual(await session.request('GET', '/v1/courses'), [{ id: 'math', title: '数学分析' }]);
    await assert.rejects(session.request('GET', '/forbidden'), /允许范围/);
    session.disconnect();
    assert.equal(session.token, ''); await assert.rejects(session.request('GET', '/v1/courses'), /先连接/);
  } finally { session.disconnect(); await server.close(); }
});

test('LLBot在线不取二维码，离线可刷新，上线后停止返回二维码', async () => {
  const server = await mockServer(), session = new SSHSession({ verifyHost: () => true });
  try {
    await session.connect(server.input);
    assert.equal((await session.qqStatus()).online, true);
    assert.equal((await session.qqQr()).imageDataUrl, null);
    assert.equal(server.qrRequests(), 0);
    server.setOnline(false);
    const first = await session.qqQr();
    assert.match(first.imageDataUrl, /^data:image\/png;base64,/);
    await session.qqQr(); assert.equal(server.qrRequests(), 2);
    server.setOnline(true);
    assert.equal((await session.qqQr()).imageDataUrl, null);
    assert.equal(server.qrRequests(), 2);
  } finally { session.disconnect(); await server.close(); }
});

test('专属实例待授权时不调用二维码接口，也不借用旧实例', async () => {
  const server = await mockServer(), session = new SSHSession({ verifyHost: () => true });
  try {
    server.setOnline(false); server.setSetupState('awaiting-auth');
    await session.connect(server.input);
    assert.equal((await session.qqStatus()).setupRequired, 'auth-token');
    await assert.rejects(session.qqQr(), /待配置官方Auth Token/);
    assert.equal(server.qrRequests(), 0);
  } finally { session.disconnect(); await server.close(); }
});

test('服务器未声明专属实例时拒绝LLBot访问，不回退旧端口', async () => {
  const session = new SSHSession();
  session.client = {}; session.token = 'synthetic-token';
  session.profile = llbotInstanceFromEnv('');
  await assert.rejects(session.llbotJSON('/api/login-info'), /不会连接原聊天机器人/);
});

test('拒绝未经信任的SSH主机；错误密码不能连接', async () => {
  const server = await mockServer();
  const rejected = new SSHSession({ verifyHost: () => false });
  const wrong = new SSHSession({ verifyHost: () => true });
  try {
    await assert.rejects(rejected.connect(server.input));
    await assert.rejects(wrong.connect({ ...server.input, password: 'wrong' }));
    assert.equal(wrong.token, '');
  } finally { rejected.disconnect(); wrong.disconnect(); await server.close(); }
});

test('演示环境的登记仅更新内存，重新打开恢复样例', () => {
  const session = new DemoSession();
  session.request('POST', '/v1/assignments/assignment-demo/offline', { students: [{ name: '周明澈', revision: 0, score: 0 }] });
  assert.equal(session.request('GET', '/v1/assignments/assignment-demo/offline').length, 6);
  assert.equal(new DemoSession().request('GET', '/v1/assignments/assignment-demo/offline').length, 5);
});
