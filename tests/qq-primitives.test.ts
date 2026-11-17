import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.ts';
import { QQAccess } from '../src/application/services/qq-access.ts';
import { DSH } from '../src/application/services/dsh.ts';
import { receiveGroupUpload } from '../src/adapters/qq/llbot.ts';
import { qqAttachmentReader } from '../src/adapters/qq/attachments.ts';
import { QATools } from '../src/agents/qa-tools.ts';

const png = Buffer.from('89504e470d0a1a0a', 'hex');

test('QQ 图片可按原消息读取，群文件通知去重，学生私信附件不进入教师工具', async t => {
  const f = fixture();
  t.after(() => f.store.close());
  const qq = new QQAccess(f.engine, { async isMember() { return true; } });
  const common = { user_id: '1', self_id: '999' };
  const image = { type: 'image', data: { file: 'image-id.png', url: 'https://invalid.test/should-not-be-used' } };
  const result = await qq.receive({ ...common, message_id: '11', group_id: '100', message_type: 'group', message: [image] });
  assert('event' in result && result.event);
  assert.equal(f.store.pendingEvents().length, 0);
  const quoted = await qq.receive({ ...common, message_id: '12', group_id: '100', message_type: 'group', message: [
    { type: 'reply', data: { id: '11' } }, { type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: '看图' } },
  ] });
  assert('event' in quoted && quoted.event);
  assert.equal(quoted.event.quotedExternalId, '11');
  const read = async () => png;
  const task = f.engine.createTask(quoted.event.id, 'qa', '看图');
  const run = f.engine.claim(task.id)!;
  const answer = await new QATools(f.engine, undefined, undefined, undefined, read).call(run, 'read_qq_image', '{"source":"quoted"}', AbortSignal.timeout(1000), true);
  assert(Array.isArray(answer));
  assert.equal(answer[1].type, 'image_url');
  const dsh = new DSH(f.engine, 'test-token', read);
  const view = dsh.messages('math', { teacher: false }).messages.find(x => x.eventId === result.event!.id)!;
  assert.equal(view.attachments?.[0].index, 1);
  assert(!JSON.stringify(view).includes('image-id.png'));
  assert.equal((await dsh.attachment('math', result.event.id, 1)).mediaType, 'image/png');
  const p = await qq.receive({ ...common, message_id: '13', message_type: 'private', message: [image] });
  assert('event' in p && p.event);
  await assert.rejects(dsh.attachment('math', p.event.id, 1), /可见消息/);
  f.engine.createCourse('web:admin', { id: 'other', title: 'Other', instructions: '' });
  await assert.rejects(dsh.attachment('other', result.event.id, 1), /可见消息/);
  const notice = { ...common, group_id: '100', file: { id: 'file-id', name: '实验要求.pdf', size: '8' } };
  const a = receiveGroupUpload(f.engine, notice);
  const b = await qq.receive({ ...common, message_id: '14', group_id: '100', message_type: 'group',
    message: [{ type: 'file', data: { file_id: 'file-id', file: '实验要求.pdf', file_size: '8' } }] });
  assert('event' in a && 'event' in b);
  assert.equal(a.event?.id, b.event?.id);
});

test('附件下载只用已记录引用，校验 QQ 来源并隔离 LLBot 凭据', async () => {
  let destination = 'https://multimedia.nt.qq.com.cn/download';
  const calls: string[] = [];
  const request: typeof fetch = async (url, options) => {
    calls.push(String(url));
    if (String(url).startsWith('http://127.0.0.1')) {
      assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer private-token');
      assert.equal(String(url).split('/').at(-1), 'get_group_file_url');
      assert.deepEqual(JSON.parse(String(options?.body)), { group_id: '100', file_id: 'fileId' });
      return Response.json({ retcode: 0, data: { url: destination } });
    }
    assert.equal(new Headers(options?.headers).get('authorization'), null);
    assert.equal(options?.redirect, 'error');
    return new Response('worksheet');
  };
  const read = qqAttachmentReader('http://127.0.0.1:1000', 'private-token', request);
  const channel = { kind: 'qq-group' as const, target: '100' };
  const file = { kind: 'file' as const, fileId: 'fileId', name: 'worksheet.txt' };
  assert.equal((await read(channel, file)).toString(), 'worksheet');
  destination = 'https://qq.com.invalid.test/download';
  await assert.rejects(read(channel, file), /无法下载/);
  assert.equal(calls.length, 3);
});

test('教师询问通过私信队列发送，一次询问通过引用绑定回复与课程', async t => {
  const f = fixture();
  t.after(() => f.store.close());
  const dsh = new DSH(f.engine, 'test-token');
  const qq = new QQAccess(f.engine, { async isMember() { return true; } });
  const id = 'a'.repeat(64);
  const text = '这周实验范围是什么？';
  assert.throws(() => dsh.ask('math', text, id), /唯一/);
  f.store.saveCourse({ ...f.store.course('math')!, weeklyLesson: { weekday: 1, time: '09:00', teacherQQ: '900', enabledAt: 1 } });
  f.engine.createCourse('web:admin', { id: 'other', title: 'Other', instructions: '' });
  const first = dsh.ask('math', text, id);
  assert.equal(dsh.ask('math', text, id).eventId, first.eventId);
  assert.throws(() => dsh.ask('math', '不同问题', id), /另一条询问/);
  const delivery = f.store.deliveries()[0];
  assert.equal(delivery.channel.target, '900');
  assert.equal(delivery.announcement, true);
  assert.equal(delivery.format, 'text');
  await qq.authorizeDelivery(delivery, f.store.event(first.eventId)!);
  f.engine.claimDelivery(delivery.id);
  f.engine.settleDelivery(delivery.id, { externalId: '333' });
  assert.equal(dsh.status(first.eventId).status, 'sent');
  const reply = { message_type: 'private' as const, user_id: '900', self_id: '999', message_id: '334',
    message: [{ type: 'reply', data: { id: '333' } }, { type: 'text', data: { text: '实验范围是 17.2' } }] };
  await assert.rejects(qq.receive(reply, 'other'), /不属于/);
  await qq.receive({ ...reply, user_id: '1', message_id: '335' }, 'math');
  assert.equal(dsh.status(first.eventId).status, 'sent');
  await qq.receive(reply);
  const done = dsh.status(first.eventId);
  assert.equal(done.status, 'answered');
  assert.equal(done.answer?.text, '实验范围是 17.2');
});
