import { Client } from 'ssh2';
import { request } from 'node:http';
import { posix } from 'node:path';

function field(env, key) {
  const value = new RegExp('^\\s*(?:export\\s+)?' + key + '\\s*=\\s*([^\\r\\n]*)', 'm').exec(env)?.[1]?.trim() ?? '';
  if (value.startsWith('"') || value.startsWith("'")) return value.slice(1, value.indexOf(value[0], 1));
  return value.split(/\s+#/)[0].trim();
}

export async function withBridge(config, signal, operation) {
  const { host, port, username, password, fingerprint, remoteDir } = config;
  if (!/^[\w.:-]{1,253}$/.test(host) || !username || !password || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint) || !/^\/[^\r\n\0]+$/.test(remoteDir)) {
    throw new Error('请在 DSH 插件设置填写助教服务器、SSH 用户名、密码和已核对的主机指纹。');
  }
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(40_000)]);
  lifetime.throwIfAborted();
  const client = new Client();
  const abort = () => client.destroy();
  lifetime.addEventListener('abort', abort, { once: true });
  try {
    await new Promise((resolve, reject) => {
      client.once('ready', resolve);
      client.once('close', () => reject(new Error('助教 SSH 连接已关闭')));
      client.on('error', reject);
      client.connect({ host, port, username, password, readyTimeout: 15000, hostHash: 'sha256',
        hostVerifier: hash => fingerprint === 'SHA256:' + Buffer.from(hash, 'hex').toString('base64').replace(/=+$/, '') });
    });
    if (client.config) client.config.password = undefined;
    const env = await new Promise((resolve, reject) => client.sftp((error, sftp) => {
      if (error) return reject(error);
      const filename = posix.join(remoteDir, '.env');
      const stream = sftp.createReadStream(filename);
      const chunks = [];
      let size = 0;
      stream.on('data', chunk => {
        size += chunk.length;
        if (size > 65_536) stream.destroy(new Error('服务器配置过大'));
        else chunks.push(chunk);
      });
      stream.once('error', reject);
      stream.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.once('close', () => sftp.end());
    }));
    lifetime.throwIfAborted();
    const token = field(env, 'ADMIN_TOKEN');
    const apiPort = Number(field(env, 'PORT') || config.apiPort);
    if (token.length < 16 || !Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) throw new Error('助教内核的管理凭据或端口无效。');
    const api = (method, route, body) => {
      lifetime.throwIfAborted();
      if (!/^\/v1\/dsh\/(?:courses(?:\/[^/?]+\/(?:scores|brief|render|group-file|textbook|teacher-question|task-memory|task-revision|conversation(?:\/[0-9a-f-]{36})?|coursework(?:\/[\w-]+\/(?:review|files\/[1-3]))?|assignments\/[\w-]+\/extensions|roster(?:\/(?:add|import|prepare|confirm))?|images\/[\w-]+|attachments\/[\w-]+\?index=\d+|(?:assignments|messages|class-context)(?:\?[\w%+&=.-]+)?))?|requests(?:\/[\w-]+)?|announcement\/(?:preview|message-preview|confirm))$/.test(route)) {
        throw new Error('不支持的助教接口');
      }
      return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const req = request({ path: route, method, signal: lifetime,
          createConnection: (_opts, callback) => { client.forwardOut('127.0.0.1', 0, '127.0.0.1', apiPort, callback); },
          headers: { authorization: 'Bearer ' + token, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) },
        }, res => {
          const chunks = [];
          let size = 0;
          res.on('data', chunk => {
            size += chunk.length;
            if (size > 4_300_000) res.destroy(new Error('助教返回的数据过大'));
            else chunks.push(chunk);
          });
          res.once('error', reject);
          res.once('end', () => {
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (res.statusCode >= 200 && res.statusCode < 300) resolve(value);
              else reject(new Error(value?.message || '助教 API HTTP ' + res.statusCode));
            } catch { reject(new Error('助教 API 未返回有效 JSON')); }
          });
        });
        req.once('error', reject);
        req.end(payload);
      });
    };
    return await operation(api);
  } catch (error) {
    lifetime.throwIfAborted();
    throw error;
  } finally {
    lifetime.removeEventListener('abort', abort);
    client.destroy();
  }
}
