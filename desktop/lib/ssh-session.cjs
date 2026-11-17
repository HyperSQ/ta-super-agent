const { Client } = require('ssh2');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const path = require('node:path').posix;
const { createHash } = require('node:crypto');

function validateProfile(input) {
  if (!input || typeof input.host !== 'string' || !/^[a-zA-Z0-9:.\-]{1,253}$/.test(input.host.trim())) throw new Error('请输入服务器IP或主机名');
  const number = (value, fallback) => { const n = Number(value || fallback); if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('端口范围应为1—65535'); return n; };
  const username = String(input.username || '').trim();
  if (!username || username.length > 100 || /[\r\n\0]/.test(username)) throw new Error('请输入SSH用户名');
  const remoteDir = String(input.remoteDir || '/opt/ta-super-agent').trim();
  if (!remoteDir.startsWith('/') || remoteDir.length > 1000 || /[\r\n\0]/.test(remoteDir)) throw new Error('内核目录须为服务器绝对路径');
  const llbotDataDir = String(input.llbotDataDir || '/var/lib/ta-llbot/data').trim();
  if (!llbotDataDir.startsWith('/') || /[\r\n\0]/.test(llbotDataDir) || llbotDataDir.length > 1000) throw new Error('LLBot数据目录须为服务器绝对路径');
  return { host: input.host.trim(), port: number(input.port, 22), username, apiPort: number(input.apiPort, 8787), remoteDir: path.normalize(remoteDir), llbotPort: number(input.llbotPort, 13080), llbotDataDir: path.normalize(llbotDataDir) };
}
function adminTokenFromEnv(text) {
  const match = /^\s*(?:export\s+)?ADMIN_TOKEN\s*=\s*(.*?)\s*$/m.exec(text);
  if (!match) throw new Error('服务器配置中没有ADMIN_TOKEN，请先配置内核');
  let token = match[1];
  if (/^["']/.test(token)) {
    const quote = token[0], end = token.indexOf(quote, 1);
    if (end < 0) throw new Error('服务器ADMIN_TOKEN引号不完整');
    token = token.slice(1, end);
  } else token = token.split(/\s+#/)[0].trim();
  if (token.length < 16 || /[\r\n\0]/.test(token)) throw new Error('服务器ADMIN_TOKEN无效');
  return token;
}
function allowRequest(method, route) {
  if (typeof route !== 'string' || route.length > 1000 || /[\r\n]/.test(route)) return false;
  if (method === 'GET' && /^\/v1\/courses\/[^/?]+\/conversation(?:\/[0-9a-f-]{36})?$/.test(route)) return true;
  if (method === 'POST' && /^\/v1\/courses\/[^/?]+\/conversation$/.test(route)) return true;
  const mail = {
    GET: /^\/v1\/courses\/[^/]+\/mail(?:\/messages\/[a-f0-9-]{36}(?:\/files\/[1-3])?)?$/,
    PUT: /^\/v1\/courses\/[^/]+\/mail$/,
    POST: /^\/v1\/courses\/[^/]+\/mail\/(?:check|sync|messages\/[a-f0-9-]{36}\/(?:review|reply|grade))$/,
  };
  if (Object.hasOwn(mail, method) && mail[method].test(route)) return true;
  if (method === 'GET' && /^\/v1\/courses\/[^/?]+\/activities(?:\/\d+|\?(?:event=[\w-]+&)?before=\d+|\?event=[\w-]+)?$/.test(route)) return true;
  if (method === 'GET' && /^\/v1\/courses\/[^/?]+\/inbox$/.test(route)) return true;
  if (method === 'GET' && /^\/v1\/courses\/[^/?]+\/grading-batches$/.test(route)) return true;
  if (method === 'POST' && /^\/v1\/courses\/[^/]+\/grading-batches\/[a-f0-9-]{36}\/(?:approve|reject)$/.test(route)) return true;
  if (method === 'GET' && /^\/v1\/courses\/[^/?]+\/alerts$/.test(route)) return true;
  if (method === 'GET' && /^\/v1\/dsh\/requests\/[\w-]+$/.test(route)) return true;
  if (route.includes('?')) return false;
  if (method === 'GET' && /^\/v1\/assignments\/[^/]+\/extensions$/.test(route)) return true;
  if (method === 'PUT' && /^\/v1\/assignments\/[^/]+\/extensions\/[^/]+$/.test(route)) return true;
  const routes = {
    GET: [/^\/health$/, /^\/v1\/(courses|tasks|deliveries)$/, /^\/v1\/courses\/[^/]+\/(assignments|memories|memory-jobs|schedules|coursework)$/, /^\/v1\/memories\/[^/]+$/, /^\/v1\/assignments\/[^/]+(?:\/offline)?$/, /^\/v1\/tasks\/[^/]+\/artifacts\/[a-f0-9]{64}$/, /^\/v1\/courses\/[^/]+\/coursework\/[^/]+\/files\/[1-3]$/],
    POST: [/^\/v1\/(courses|tasks)$/, /^\/v1\/courses\/[^/]+\/assignments$/, /^\/v1\/assignments\/[^/]+\/offline$/, /^\/v1\/tasks\/[^/]+\/control$/, /^\/v1\/memories\/[^/]+\/retire$/, /^\/v1\/memory-jobs\/[^/]+\/retry$/, /^\/v1\/courses\/[^/]+\/schedules\/[^/]+\/run$/, /^\/v1\/courses\/[^/]+\/coursework\/[^/]+\/review$/],
    PUT: [/^\/v1\/(courses|assignments|memories)\/[^/]+$/, /^\/v1\/courses\/[^/]+\/schedules$/],
    DELETE: [/^\/v1\/assignments\/[^/]+\/offline\/[^/]+$/],
  };
  return (routes[method] || []).some(regex => regex.test(route));
}
function kernelPortFromEnv(text, fallback) {
  const match = /^\s*PORT\s*=\s*['"]?(\d+)['"]?\s*(?:#.*)?$/m.exec(text);
  if (!match) return fallback;
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('服务器PORT配置无效');
  return port;
}
function verifiedQrImage(encoded) {
  if (typeof encoded !== 'string' || encoded.length > 2800000) throw new Error('LLBot未返回有效二维码');
  const bytes = Buffer.from(encoded.replace(/^data:image\/png;base64,/, ''), 'base64');
  if (bytes.length > 2000000 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('LLBot二维码格式无效');
  return 'data:image/png;base64,' + bytes.toString('base64');
}
function llbotInstanceFromEnv(text) {
  const field = key => {
    const match = new RegExp('^\\s*' + key + '\\s*=\\s*([^\\r\\n]*)$', 'm').exec(text);
    return (match?.[1] || '').trim().replace(/^['"]|['"]$/g, '');
  };
  // Never inherit an old desktop profile's original-bot address or data directory.
  const configured = field('LLBOT_INSTANCE_ID') === 'ta-llbot';
  const port = configured ? Number(field('LLBOT_WEBUI_PORT')) : 13080;
  const directory = configured ? field('LLBOT_DATA_DIR') : '/var/lib/ta-llbot/data';
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !directory.startsWith('/') || /[\r\n\0]/.test(directory)) throw new Error('助教专属LLBot实例配置无效');
  return { llbotInstance: 'ta-llbot', llbotConfigured: configured, llbotPort: port, llbotDataDir: path.normalize(directory), llbotSetupState: field('LLBOT_SETUP_STATE') || 'ready' };
}

class SSHSession extends EventEmitter {
  constructor(options = {}) { super(); this.client = undefined; this.token = ''; this.profile = undefined; this.options = options; this.connecting = false; }
  async connect(input) {
    if (this.connecting) throw new Error('连接正在进行，请稍候');
    const profile = validateProfile(input);
    if (typeof input.password !== 'string' || !input.password) throw new Error('请输入SSH密码');
    this.disconnect(); this.connecting = true;
    const client = new Client(); this.client = client; this.profile = profile;
    let verifiedFingerprint;
    try {
      await new Promise((resolve, reject) => {
        client.once('ready', resolve);
        client.once('close', () => reject(new Error('SSH连接已关闭')));
        client.on('error', error => { reject(error); this.emit('connection-error', 'SSH连接失败或已中断'); });
        client.on('close', () => { if (this.client === client) { this.token = ''; this.emit('disconnected'); } });
        client.connect({ host: profile.host, port: profile.port, username: profile.username, password: input.password,
          readyTimeout: 20000, keepaliveInterval: 15000, keepaliveCountMax: 3, hostHash: 'sha256',
          hostVerifier: (hash, callback) => {
            const fingerprint = `SHA256:${Buffer.from(hash, 'hex').toString('base64').replace(/=+$/, '')}`;
            Promise.resolve(this.options.verifyHost?.(profile, fingerprint) ?? false).then(ok => { if (ok) verifiedFingerprint = fingerprint; callback(!!ok); }, () => callback(false));
          },
        });
      });
      if (client.config) client.config.password = undefined;
      const envText = await this.readEnv(client, path.join(profile.remoteDir, '.env'));
      this.token = adminTokenFromEnv(envText);
      profile.apiPort = kernelPortFromEnv(envText, profile.apiPort);
      Object.assign(profile, llbotInstanceFromEnv(envText));
      this.agent = new http.Agent({ keepAlive: false });
      this.agent.createConnection = (_options, callback) => { client.forwardOut('127.0.0.1', 0, '127.0.0.1', profile.apiPort, callback); return undefined; };
      await this.request('GET', '/health');
      await this.request('GET', '/v1/courses');
      await this.options.onVerified?.(profile, verifiedFingerprint);
      return profile;
    } catch (error) {
      this.disconnect();
      throw new Error(error.code === 'ENOENT' || error.code === 2 ? '未找到服务器内核配置文件，请检查高级设置中的内核目录' : error.message || '连接失败');
    } finally { this.connecting = false; }
  }
  async readEnv(client, filename) {
    return new Promise((resolve, reject) => client.sftp((error, sftp) => {
      if (error) return reject(error);
      sftp.stat(filename, (error, stat) => {
        if (error) { sftp.end(); reject(error); return; }
        if (stat.size > 65536) { sftp.end(); reject(new Error('服务器配置文件过大')); return; }
        sftp.readFile(filename, 'utf8', (error, data) => { sftp.end(); error ? reject(error) : resolve(data); });
      });
    }));
  }
  async request(method, route, data) {
    if (!allowRequest(method, route)) throw new Error('该操作不在桌面端允许范围内');
    if (!this.client || !this.token || !this.agent) throw new Error('请先连接服务器');
    const payload = data === undefined ? undefined : JSON.stringify(data);
    const savesAssignment = method === 'POST' && /^\/v1\/courses\/[^/]+\/assignments$/.test(route)
      || method === 'PUT' && /^\/v1\/assignments\/[^/]+$/.test(route);
    const savesSchedules = method === 'PUT' && /^\/v1\/courses\/[^/]+\/schedules$/.test(route);
    if (payload && Buffer.byteLength(payload) > (savesAssignment ? 4 * 1024 * 1024 : savesSchedules ? 280000 : 65536)) throw new Error('内容过大，请精简后提交');
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: this.profile.apiPort, path: route, method, agent: this.agent,
        headers: { authorization: `Bearer ${this.token}`, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) },
      }, res => {
        const chunks = []; let size = 0;
        const maximum = /\/(artifacts|files)\//.test(route) ? 14 * 1024 * 1024 : 4 * 1024 * 1024;
        res.on('data', chunk => { size += chunk.length; if (size > maximum) res.destroy(new Error('服务器返回内容过大')); else chunks.push(chunk); });
        res.on('error', reject);
        res.on('end', () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (res.statusCode < 200 || res.statusCode >= 300) {
              const error = new Error(result.message || (res.statusCode === 401 ? '服务器管理凭据无效，请重新连接' : `服务器返回${res.statusCode}`));
              error.status = res.statusCode; reject(error);
            } else resolve(result);
          } catch { reject(new Error('服务器未返回有效的管理API响应')); }
        });
      });
      // SSH channels are duplex streams, not net.Socket; use a request deadline.
      const mailOperation = method === 'POST' && /\/mail\/(?:check|sync|messages\/[a-f0-9-]{36}\/reply)$/.test(route);
      const batchOperation = method === 'POST' && /\/grading-batches\/[a-f0-9-]{36}\/(?:approve|reject)$/.test(route);
      const deadline = setTimeout(() => req.destroy(new Error('服务器请求超时，请检查内核状态')), mailOperation || batchOperation ? 65000 : 20000);
      req.once('close', () => clearTimeout(deadline));
      req.on('error', reject); req.end(payload);
    });
  }
  async llbotJSON(route) {
    if (!this.client || !this.token) throw new Error('请先通过SSH连接服务器');
    if (!this.profile.llbotConfigured) throw new Error('助教专属LLBot尚未配置，不会连接原聊天机器人');
    if (!['/api/login-info', '/api/login-qrcode'].includes(route)) throw new Error('不允许的LLBot操作');
    if (!this.llbotToken) {
      const value = (await this.readEnv(this.client, path.join(this.profile.llbotDataDir, 'webui_token.txt'))).trim();
      if (!value || value.length > 1000) throw new Error('LLBot管理凭据无效');
      this.llbotToken = createHash('sha256').update(value).digest('hex');
    }
    const client = this.client, port = this.profile.llbotPort;
    const agent = new http.Agent({ keepAlive: false });
    agent.createConnection = (_options, callback) => { client.forwardOut('127.0.0.1', 0, '127.0.0.1', port, callback); return undefined; };
    try {
      return await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: route, method: 'GET', agent, headers: { 'X-Webui-Token': this.llbotToken } }, res => {
          const chunks = []; let size = 0;
          res.on('data', chunk => { size += chunk.length; if (size > 3000000) res.destroy(new Error('LLBot返回内容过大')); else chunks.push(chunk); });
          res.on('error', reject);
          res.on('end', () => {
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (res.statusCode !== 200 || value.success !== true) reject(new Error('LLBot接口暂不可用，请检查服务状态'));
              else resolve(value.data);
            } catch { reject(new Error('LLBot接口响应格式无效')); }
          });
        });
        const deadline = setTimeout(() => req.destroy(new Error('LLBot请求超时')), 10000);
        req.once('close', () => clearTimeout(deadline)); req.on('error', reject); req.end();
      });
    } finally { agent.destroy(); }
  }
  async qqStatus() {
    try {
      const data = await this.llbotJSON('/api/login-info');
      if (typeof data.online !== 'boolean') throw new Error('LLBot没有返回明确的在线状态');
      return { available: true, online: data.online, instance: this.profile.llbotInstance, setupRequired: this.profile.llbotSetupState === 'awaiting-auth' ? 'auth-token' : null, account: String(data.uin || ''), nickname: String(data.nick || data.nickname || ''), checkedAt: new Date().toISOString() };
    } catch (error) { return { available: false, online: null, error: error.message, checkedAt: new Date().toISOString() }; }
  }
  async qqQr() {
    const status = await this.qqStatus();
    if (!status.available) throw new Error(status.error);
    if (status.setupRequired === 'auth-token') throw new Error('助教专属LLBot待配置官方Auth Token，尚不能生成QQ登录二维码');
    if (status.online) return { ...status, imageDataUrl: null };
    const data = await this.llbotJSON('/api/login-qrcode');
    return { ...status, imageDataUrl: verifiedQrImage(data?.pngBase64QrcodeData), fetchedAt: new Date().toISOString() };
  }
  disconnect() {
    this.token = ''; this.llbotToken = ''; this.agent?.destroy(); this.agent = undefined;
    const client = this.client; this.client = undefined; client?.end();
    this.emit('disconnected');
  }
}
module.exports = { SSHSession, validateProfile, adminTokenFromEnv, allowRequest, kernelPortFromEnv, verifiedQrImage, llbotInstanceFromEnv };
