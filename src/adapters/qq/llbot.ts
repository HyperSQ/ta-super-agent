import { createHash, randomUUID } from 'node:crypto';
import { DomainError, channelKey } from '../../domain/model.ts';
import type { Delivery, Event } from '../../domain/model.ts';
import type { Sender, SendReceipt } from '../../application/delivery-outbox.ts';
import { TaskEngine } from '../../application/task-engine.ts';
import type { QQSendGuard } from '../../ports/qq-access.ts';
import { hasFormula, mathImage } from './math-image.ts';
import { qqAttachments } from './attachments.ts';

type Segment = { type: string; data: Record<string, unknown> };
export type QQMessage = {
  post_type?: string; message_type: 'group' | 'private'; self_id: number | string;
  user_id: number | string; group_id?: number | string; message_id: number | string;
  message: Segment[]; raw_message?: string;
};

/** Accept only structured OneBot events over the authenticated LLBot endpoint. */
export function validateQQ(raw: QQMessage): void {
  if (!raw || !['group', 'private'].includes(raw.message_type) || !Array.isArray(raw.message) || !/^\d+$/.test(String(raw.user_id)) || !/^\d+$/.test(String(raw.self_id)) || !/^-?\d+$/.test(String(raw.message_id))) throw new DomainError('invalid', 'QQ事件格式错误，需要结构化消息数组');
  if (raw.message.some(s => !s || typeof s.type !== 'string' || !s.data || typeof s.data !== 'object')) throw new DomainError('invalid', 'QQ消息段无效');
}
export function receiveQQ(engine: TaskEngine, raw: QQMessage) {
  validateQQ(raw);
  if (String(raw.user_id) === String(raw.self_id)) return { ignored: true };
  if (raw.message_type !== 'group') throw new DomainError('forbidden', '私聊必须经过课程群成员资格校验');
  const course = engine.store.courseForGroup(String(raw.group_id));
  if (!course) throw new DomainError('forbidden', '群未配置课程');
  const channel = { kind: 'qq-group' as const, target: String(raw.group_id) };
  const quote = raw.message.find(s => s.type === 'reply')?.data.id;
  const linked = quote !== undefined ? engine.store.threadForReply(channelKey(channel), String(quote)) : undefined;
  const addressed = raw.message.some(s => s.type === 'at' && String(s.data.qq) === String(raw.self_id));
  const target = !linked && addressed && quote !== undefined ? engine.store.eventByKey(`qq:${channelKey(channel)}:${quote}`) : undefined;
  const quotedMedia = target?.courseId === course.id && !!target.attachments?.length;
  const text = raw.message.filter(s => s.type === 'text').map(s => String(s.data.text ?? '')).join('').trim();
  const attachments = qqAttachments(raw.message);
  if (!text && !attachments.length) return { ignored: true };
  if (!text && !addressed && !linked && attachments.length === 1 && attachments[0].kind === 'file')
    return receiveGroupUpload(engine, { group_id: raw.group_id, user_id: raw.user_id, self_id: raw.self_id,
      file: { id: attachments[0].fileId, name: attachments[0].name, size: attachments[0].size } });
  return engine.receive({ sourceKey: `qq:${channelKey(channel)}:${raw.message_id}`, courseId: course.id,
    threadId: linked ?? (quotedMedia ? target?.threadId : undefined) ?? randomUUID(), actorId: `qq:${raw.user_id}`, text: text || '[QQ 附件]', quoted: !!linked || quotedMedia,
    ...(attachments.length ? { attachments } : {}),
    quotedExternalId: linked || quotedMedia ? String(quote) : undefined,
    channel, externalId: String(raw.message_id), receivedAt: Date.now() }, !addressed && !linked);
}

export function receiveGroupUpload(engine: TaskEngine, data: Record<string, unknown>) {
  const group = String(data.group_id), user = String(data.user_id), self = String(data.self_id);
  if (!/^\d+$/.test(group) || !/^\d+$/.test(user) || !/^\d+$/.test(self) || user === self ||
    !data.file || typeof data.file !== 'object') return { ignored: true };
  const course = engine.store.courseForGroup(group);
  if (!course) return { ignored: true };
  const { id, name, size } = data.file as Record<string, unknown>;
  const attachments = qqAttachments([{ type: 'file', data: { file_id: id, file_name: name, file_size: size } }]);
  if (!attachments.length) return { ignored: true };
  const key = createHash('sha256').update(attachments[0].fileId).digest('hex');
  return engine.receive({ sourceKey: `qq:group-file:${group}:${key}`, courseId: course.id, threadId: randomUUID(),
    actorId: 'qq:' + user, text: '[QQ 群文件]', attachments, channel: { kind: 'qq-group', target: group },
    externalId: 'file:' + key, receivedAt: engine.now() }, true);
}

export class LLBotSender implements Sender {
  url: string; token: string; guard: QQSendGuard; mathSocket?: string;
  private readonly loadImage?: (course: string, id: string) => Buffer | undefined;
  loadFile?: (course: string, id: string) => { name: string; content: Buffer } | undefined;
  constructor(url: string, token: string, guard: QQSendGuard, mathSocket?: string, loadImage?: (course: string, id: string) => Buffer | undefined) {
    this.url = url; this.token = token; this.guard = guard; this.mathSocket = mathSocket; this.loadImage = loadImage;
  }
  async send(d: Delivery, event: Event): Promise<SendReceipt> {
    if (d.channel.kind === 'management') throw new DomainError('forbidden', '管理渠道不能通过QQ外发');
    await this.guard.authorizeDelivery(d, event);
    if (d.fileId) {
      if (d.channel.kind !== 'qq-group') throw new DomainError('forbidden', '文件只能发送到课程群');
      const file = this.loadFile?.(event.courseId, d.fileId);
      if (!file) throw new DomainError('not_found', '讲义文件不存在');
      this.guard.assertDeliveryTarget(d, event);
      const response = await fetch(this.url.replace(/\/$/, '') + '/upload_group_file', {
        method: 'POST', signal: AbortSignal.timeout(90_000),
        headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify({ group_id: d.channel.target, name: file.name, file: 'base64://' + file.content.toString('base64') }),
      });
      if (!response.ok) throw new Error(`LLBot 群文件上传 HTTP ${response.status}，请核对群文件`);
      const result = await response.json() as { status?: string; retcode?: number; data?: { file_id?: string } };
      if (result.status !== 'ok' || result.retcode !== 0) throw new Error('LLBot 未确认文件上传成功，请核对群文件');
      return { fileUploaded: true, externalFileId: result.data?.file_id };
    }
    let content: Segment = { type: 'text', data: { text: d.text } };
    let png: Buffer | undefined;
    if (d.imageId || d.format === 'latex' || (this.mathSocket && d.format === undefined && hasFormula(d.text))) {
      try {
        png = d.imageId ? this.loadImage?.(event.courseId, d.imageId) : this.mathSocket ? await mathImage(this.mathSocket, d.text) : undefined;
        if (!png) throw new Error('公式图片不可用');
        content = { type: 'image', data: { file: 'base64://' + png.toString('base64') } };
      } catch {
        this.guard.assertDeliveryTarget(d, event);
        if (d.imageId || d.format === 'latex') throw new DomainError('render_failed', '公式图片未渲染成功，未发送');
        console.warn('公式图片渲染失败，使用文本答复');
      }
      if (d.channel.kind === 'qq-private') await this.guard.authorizeDelivery(d, event);
    }
    this.guard.assertDeliveryTarget(d, event);
    const group = d.channel.kind === 'qq-group';
    const response = await fetch(`${this.url.replace(/\/$/, '')}/${group ? 'send_group_msg' : 'send_private_msg'}`, {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ [group ? 'group_id' : 'user_id']: d.channel.target,
        message: d.announcement ? [content] : [{ type: 'reply', data: { id: event.externalId } }, content] }),
    });
    if (!response.ok) throw new Error(`LLBot HTTP ${response.status}，需核对发送结果`);
    const result = await response.json() as { status?: string; retcode?: number; data?: { message_id?: unknown } };
    if (result.status !== 'ok' || result.retcode !== 0 || result.data?.message_id === undefined) throw new Error('LLBot未返回成功消息ID，需核对发送结果');
    return { externalId: String(result.data.message_id), ...(png ? { png } : {}) };
  }
}
