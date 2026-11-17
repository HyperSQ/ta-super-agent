import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DomainError } from '../../domain/model.ts';

export type MailSettings = {
  address: string; imapHost: string; imapPort: number; folder: string;
  smtpHost: string; smtpPort: number; smtpMode: 'tls' | 'starttls';
  prefix: string; enabled: boolean; revision: number; since: number;
};
export type MailCredentials = MailSettings & { password: string };
export type MailCursor = { validity?: number; last?: number };
export type ReceivedMail = {
  uid: number; messageId: string; from: string; subject: string; receivedAt: number;
  text: string; issue?: string; files: { name: string; content: string }[];
};
export type MailReply = { to: string; subject: string; text: string; parent: string; id: string };
export interface MailTransport {
  check(credentials: MailCredentials): Promise<void>;
  fetch(credentials: MailCredentials, cursor: MailCursor): Promise<{ cursor: MailCursor; messages: ReceivedMail[] }>;
  reply(credentials: MailCredentials, message: MailReply): Promise<void>;
}
const helper = fileURLToPath(new URL('./mail_client.py', import.meta.url));
export class PythonMailTransport implements MailTransport {
  private executable: string;
  constructor(executable = process.env.TA_MAIL_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')) {
    this.executable = executable;
  }
  async check(credentials: MailCredentials) { await this.call('check', credentials, {}); }
  fetch(credentials: MailCredentials, cursor: MailCursor) {
    return this.call<{ cursor: MailCursor; messages: ReceivedMail[] }>('fetch', credentials, { cursor });
  }
  async reply(credentials: MailCredentials, message: MailReply) { await this.call('reply', credentials, { message }); }
  private call<T>(operation: string, credentials: MailCredentials, args: object): Promise<T> {
    return new Promise((resolve, reject) => {
      // Secrets travel only over stdin. Python inherits no service API keys.
      const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PYTHONUTF8: '1' };
      const child = spawn(this.executable, ['-I', '-B', helper], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], timeout: 55_000 });
      const chunks: Buffer[] = [];
      let size = 0;
      const fail = (message: string) => reject(new DomainError('unavailable', message));
      child.on('error', () => fail('邮箱客户端无法启动。请检查服务器 Python 3 环境。'));
      child.stdin.on('error', () => {});
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 15_000_000) child.kill();
        else chunks.push(chunk);
      });
      child.on('close', status => {
        if (status !== 0) return fail('邮箱请求未完成。请检查服务端网络和邮箱配置。');
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: string; data: T };
          if (result.error) fail(result.error);
          else resolve(result.data);
        } catch { fail('邮箱客户端未返回有效结果。'); }
      });
      child.stdin.end(JSON.stringify({ operation, credentials, ...args }));
    });
  }
}
