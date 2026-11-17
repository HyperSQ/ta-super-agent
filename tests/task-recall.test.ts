import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.ts';
import { QATools } from '../src/agents/qa-tools.ts';
import { ContextBuilder } from '../src/agents/context-builder.ts';
import { MemoryService } from '../src/application/services/memory.ts';
import { channelKey } from '../src/domain/model.ts';
import type { Channel, Event } from '../src/domain/model.ts';

const signal = new AbortController().signal;
const group: Channel = { kind: 'qq-group', target: '100' };
const privateChannel: Channel = { kind: 'qq-private', target: '2' };

type F = ReturnType<typeof fixture>;
function say(f: F, text: string, options: {
  threadId: string; ext?: string; quote?: string; actor?: string; channel?: Channel; courseId?: string;
}): Event {
  const channel = options.channel ?? group;
  const ext = options.ext ?? randomUUID();
  return f.engine.receive({
    sourceKey: `qq:${channelKey(channel)}:${ext}`, externalId: ext, threadId: options.threadId,
    courseId: options.courseId ?? 'math', actorId: options.actor ?? 'qq:1', text,
    quotedExternalId: options.quote, receivedAt: Date.now(), channel,
  }).event;
}
const call = (f: F, run: Parameters<QATools['call']>[0], name: string, args: object) =>
  new QATools(f.engine).call(run, name, JSON.stringify(args), signal, false) as Promise<string>;

test('引用链两跳可读，跨课与他人私聊不可读，线程纠正后权限随之变化', () => {
  const f = fixture();
  f.engine.createCourse('web:admin', { id: 'other', title: '其他课程', groupId: '200', instructions: '' });
  const a = say(f, '第3题怎么证', { threadId: 'T', ext: 'a' });
  const b = say(f, '同线程追问', { threadId: 'T', ext: 'b', quote: 'a' });
  const d = say(f, '另一个线程的原话', { threadId: 'U', ext: 'd' });
  const e = say(f, '引用另一个线程', { threadId: 'T', ext: 'e', quote: 'd' });
  const g = say(f, '第二跳原文', { threadId: 'W', ext: 'g' });
  const h = say(f, '第三跳不应可达', { threadId: 'X', ext: 'h' });
  // d 引用 g，g 引用 h：从 e 出发分别是一跳、两跳、三跳。
  f.store.db.prepare('UPDATE events SET data=json_set(data,\'$.quotedExternalId\',?) WHERE id=?').run('g', d.id);
  f.store.db.prepare('UPDATE events SET data=json_set(data,\'$.quotedExternalId\',?) WHERE id=?').run('h', g.id);
  const stranger = say(f, '另一个学生的私聊', { threadId: 'P', ext: 'p', actor: 'qq:2', channel: privateChannel });
  const crossCourse = say(f, '别的课的消息', { threadId: 'Z', ext: 'z', courseId: 'other', channel: { kind: 'qq-group', target: '200' } });

  const task = f.engine.createTask(e.id, 'qa', e.text);
  const run = f.engine.claim(task.id)!;
  return (async () => {
    assert.match(JSON.parse(await call(f, run, 'read_message', { eventId: a.id })).text, /第3题/);
    assert.equal(JSON.parse(await call(f, run, 'read_message', { eventId: b.id })).authorRole, 'student');
    assert.match(JSON.parse(await call(f, run, 'read_message', { eventId: d.id })).text, /另一个线程/);
    assert.match(JSON.parse(await call(f, run, 'read_message', { eventId: g.id })).text, /第二跳/);
    assert.match(JSON.parse(await call(f, run, 'read_message', { eventId: h.id })).error, /不在本次任务可见范围/);
    assert.match(JSON.parse(await call(f, run, 'read_message', { eventId: stranger.id })).error, /不在本次任务可见范围/);
    assert.match(JSON.parse(await call(f, run, 'read_message', { eventId: crossCourse.id })).error, /不在本次任务可见范围/);

    // 线程归属变化后，原来的同线程消息不再自动可见。
    f.store.moveEvent(b.id, 'moved-thread');
    assert.match(JSON.parse(await call(f, run, 'read_message', { eventId: b.id })).error, /不在本次任务可见范围/);
    f.store.close();
  })();
});

test('上下文截断给出 ref，read_more 只接受本轮发出的引用', async () => {
  const f = fixture();
  const long = '例题推导。'.repeat(400);
  const a = say(f, long, { threadId: 'T', ext: 'a' });
  const task = f.engine.createTask(a.id, 'qa', '帮我看看');
  const run = f.engine.claim(task.id)!;
  const context = await new ContextBuilder(new MemoryService(f.engine)).build(run, signal, false) as { discussion: { text: string; truncated?: boolean; ref?: string }[] };
  assert.equal(context.discussion[0].truncated, true);
  assert.match(context.discussion[0].ref ?? '', /^evt:.+:\d+$/);
  assert.deepEqual(run.readRefs, [context.discussion[0].ref]);

  const more = JSON.parse(await call(f, run, 'read_more', { ref: context.discussion[0].ref })) as { text: string; nextRef?: string };
  assert.equal(more.text.length, long.length - 1200);
  assert.equal(more.nextRef, undefined);

  const forged = JSON.parse(await call(f, run, 'read_more', { ref: `evt:${a.id}:0` })) as { error: string };
  assert.match(forged.error, /不是本轮上下文发出的/);
  f.store.close();
});
