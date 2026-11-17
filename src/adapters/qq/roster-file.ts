import { DomainError } from '../../domain/model.ts';
import { rosterFileLimit } from '../../application/services/roster.ts';

export function qqRosterFile(llbotUrl: string, token: string) {
  return async (fileId: string): Promise<Buffer> => {
    const signal = AbortSignal.timeout(20_000);
    const reply = await fetch(llbotUrl.replace(/\/$/, '') + '/get_private_file_url', {
      method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify({ file_id: fileId }), signal,
    });
    if (!reply.ok) throw new DomainError('unavailable', '助教无法获取 QQ 附件下载地址');
    const data = await reply.json() as { retcode?: number; data?: { url?: string } };
    if (data.retcode !== 0 || !data.data?.url) throw new DomainError('unavailable', 'QQ 暂未返回附件地址，请重新发送');
    const url = new URL(data.data.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !/(^|\.)(qq\.com|qpic\.cn|weiyun\.com)$/i.test(url.hostname)) throw new DomainError('unavailable', 'QQ 附件地址不可用');
    const response = await fetch(url, { signal, redirect: 'error' });
    if (!response.ok || !response.body) throw new DomainError('unavailable', 'QQ 附件下载失败，请重新发送');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.length;
        if (size > rosterFileLimit) throw new DomainError('invalid', '名单文件须在 2 MiB 以内');
        chunks.push(result.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    return Buffer.concat(chunks, size);
  };
}
