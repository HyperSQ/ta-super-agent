import { DomainError } from '../../domain/model.ts';
import type { Event, QQAttachment } from '../../domain/model.ts';

const maxBytes = 3 * 1024 * 1024;
export type QQAttachmentReader = (channel: Event['channel'], file: QQAttachment, signal?: AbortSignal) => Promise<Buffer>;
export function qqAttachments(segments: { type: string; data: Record<string, unknown> }[]): QQAttachment[] {
  return segments.flatMap(({ type, data }, i): QQAttachment[] => {
    if (type !== 'image' && type !== 'file') return [];
    const id = type === 'image' ? data.file_id ?? data.resource_id ?? data.file : data.file_id;
    if (typeof id !== 'string' || !id || id.length > 1000 || /[\u0000-\u0020:\\]/.test(id)) return [];
    const raw = data.file_name ?? (type === 'file' ? data.file : undefined);
    const clean = typeof raw === 'string' ? raw.split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f:<>"|?*]/g, '_').slice(0, 160).replace(/[.\s]+$/, '') : '';
    const name = clean || (type === 'image' ? '图片' : '附件') + (i + 1);
    const size = Number(data.file_size);
    return [{ kind: type, fileId: id, name, ...(Number.isSafeInteger(size) && size > 0 ? { size } : {}) }];
  }).slice(0, 10);
}

export function describeAttachments(event: Pick<Event, 'attachments'>) {
  return event.attachments?.map(({ kind, name, size }, index) => ({ index: index + 1, kind, name, size })) ?? [];
}

export function qqImageType(content: Buffer) {
  if (content.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
  if (content.subarray(0, 3).toString('hex') === 'ffd8ff') return 'image/jpeg';
  if (content.toString('ascii', 0, 4) === 'RIFF' && content.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (['GIF87a', 'GIF89a'].includes(content.toString('ascii', 0, 6))) return 'image/gif';
}

export function qqAttachmentReader(llbotUrl: string, token: string, request: typeof fetch = fetch, limit = maxBytes): QQAttachmentReader {
  return async (channel, file, cancel) => {
    if (channel.kind === 'management') throw new DomainError('forbidden', '仅支持 QQ 消息附件');
    const cap = Math.round(limit / 1024 / 1024) + ' MiB';
    if (file.size && file.size > limit) throw new DomainError('invalid', `目前可读取 ${cap} 以内的 QQ 附件`);
    const signal = cancel ? AbortSignal.any([cancel, AbortSignal.timeout(18000)]) : AbortSignal.timeout(18000);
    const action = file.kind === 'image' ? 'get_image' : channel.kind === 'qq-group' ? 'get_group_file_url' : 'get_private_file_url';
    const args = file.kind === 'image' ? { file: file.fileId, download: false }
      : { file_id: file.fileId, ...(channel.kind === 'qq-group' ? { group_id: channel.target } : {}) };
    try {
      const result = await request(llbotUrl.replace(/\/$/, '') + '/' + action, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify(args), signal, redirect: 'error',
      });
      if (!result.ok) throw Error('lookup failed');
      const response = await result.json() as { retcode?: number; data?: { url?: string } };
      if (response.retcode !== 0 || !response.data?.url) throw Error('missing media URL');
      const url = new URL(response.data.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.port ||
          !/(^|\.)(qq\.com|qq\.com\.cn|qpic\.cn|weiyun\.com)$/i.test(url.hostname)) throw Error('invalid media URL');
      const download = await request(url, { signal, redirect: 'error' });
      if (!download.ok || !download.body) throw Error('download failed');
      const stream = download.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const chunk = await stream.read();
          if (chunk.done) break;
          length += chunk.value.length;
          if (length > limit) throw new DomainError('invalid', `目前可读取 ${cap} 以内的 QQ 附件`);
          chunks.push(chunk.value);
        }
      } finally { await stream.cancel().catch(() => undefined); }
      if (!length) throw Error('empty attachment');
      return Buffer.concat(chunks, length);
    } catch (error) {
      cancel?.throwIfAborted();
      if (error instanceof DomainError) throw error;
      throw new DomainError('unavailable', 'QQ 附件已失效或暂时无法下载，请重新发送');
    }
  };
}
