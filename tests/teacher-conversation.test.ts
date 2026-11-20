import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './helpers.ts';
import { TeacherConversation, contextForTeacher } from '../src/application/teacher-conversation.ts';
import { Router } from '../src/agents/router.ts';
import { TaskRunner } from '../src/application/task-runner.ts';
import { teachingAffairsWorker } from '../src/agents/workers/teaching-affairs-worker.ts';
import { Academics } from '../src/application/services/academics.ts';
import { createApi } from '../src/http/server.ts';
import type { Event } from '../src/domain/model.ts';

const signal = new AbortController().signal;
function qq(f: ReturnType<typeof fixture>, text: string, actor = '900', courseId = 'math') {
  return f.engine.receive({ sourceKey: text, externalId: text, threadId: 'qq-' + actor, courseId,
    channel: { kind: 'qq-private', target: actor }, actorId: 'qq:' + actor, text, receivedAt: f.engine.now() }).event;
}

test('在 QQ 发起作业，DSH 补充截止时间，工作台核对并确认同一草稿', async t => {
  const f = fixture();
  const assistant = new TeacherConversation(f.engine);
  const router = new Router(f.engine, { async complete(messages) {
    const { request, taskHandoff, message } = JSON.parse(String(messages[1].content));
    if (message) return '{"action":"create","kind":"teaching-affairs","goal":"补充作业截止时间"}';
    if (!request.includes('下周四')) return '{"action":"clarify","question":"什么时候截止？"}';
    assert.match(request, /证明一致收敛/);
    assert(taskHandoff.teacherConversation.some((turn: { reply?: string }) => turn.reply?.includes('什么时候截止')));
    return '{"action":"create","title":"第4次作业","instructions":"证明一致收敛","deadline":"2026-11-26T23:59:00+08:00"}';
  } });
  const runner = new TaskRunner(f.engine, teachingAffairsWorker(router.teacherWork));
  const route = async (event: Event) => { await router.route(event, signal); runner.tick(); await runner.idle(); };
  const config = { adminToken: 'assistant-test-admin', webhookToken: 'assistant-test-webhook' };
  const server = createApi(f.engine, config);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); f.store.close(); });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = 'http://127.0.0.1:' + address.port, dsh = '/v1/dsh/courses/math/conversation', desktop = '/v1/courses/math/conversation';
  const request = (path: string, data?: object, token = config.adminToken) => fetch(origin + path, {
    method: data ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const launch = qq(f, '新建作业「第4次作业」，证明一致收敛');
  await route(launch);
  const start = await (await request(dsh)).json() as ReturnType<TeacherConversation['history']>;
  assert.equal(start.sharesQQ, true);
  assert.equal(start.turns[0].eventId, launch.id);
  const params = { message: '下周四', requestId: 'dsh-cutoff-abcdef-1' };
  const followup = await request(dsh, params);
  assert.equal(followup.status, 202);
  const first = await followup.json() as { eventId: string };
  assert.equal((await (await request(dsh, params)).json() as { eventId: string }).eventId, first.eventId);
  await route(f.store.event(first.eventId)!);
  const history = await (await request(desktop)).json() as ReturnType<TeacherConversation['history']>;
  const code = /确认 ([0-9A-F]{8})/.exec(history.turns.at(-1)?.reply ?? '')?.[1];
  assert(code);
  assert.deepEqual(history.turns.map(turn => turn.surface), ['qq', 'dsh']);
  const acceptance = await (await request(desktop, { message: '确认 ' + code, requestId: 'workbench-confirm-1' })).json() as { eventId: string };
  await route(f.store.event(acceptance.eventId)!);
  assert.equal(new Academics(f.engine).assignments('math').length, 1);
  assert.deepEqual(assistant.history('math').turns.map(turn => turn.surface), ['qq', 'dsh', 'workbench']);
  assert.match(assistant.turn('math', acceptance.eventId).reply ?? '', /已新建作业/);
  assert.equal(f.store.deliveries().length, 1);
  assert.equal((await request(desktop, undefined, config.webhookToken)).status, 401);
});

test('按教师和课程隔离对话，多位候选时管理端不会读入 QQ 私聊', t => {
  const f = fixture();
  t.after(() => f.store.close());
  f.policy.teacherIds.add('qq:901');
  f.engine.createCourse('web:admin', { id: 'other', title: '另一课程', groupId: '101', instructions: '' });
  const private900 = qq(f, '900 私聊消息');
  qq(f, '另一课程内容', '900', 'other');
  qq(f, '901 私聊消息', '901');
  const other = qq(f, '901 后续', '901');
  assert(!JSON.stringify(contextForTeacher(f.engine, other)).includes('900 私聊消息'));
  const student = qq(f, '学生私聊内容', '11');
  const publicEvent = f.receive('公开群消息', { actorId: 'qq:900' });
  assert.equal(contextForTeacher(f.engine, student), undefined);
  assert.equal(contextForTeacher(f.engine, publicEvent), undefined);
  const service = new TeacherConversation(f.engine);
  assert.deepEqual(service.history('math'), { sharesQQ: false, turns: [] });
  assert.throws(() => service.turn('math', private900.id), /找不到/);
  f.store.saveCourse({ ...f.store.course('math')!, weeklyLesson: { weekday: 6, time: '09:00', teacherQQ: '900', enabledAt: 1 } });
  const solo = service.history('math');
  assert.equal(solo.sharesQQ, true);
  assert.deepEqual(solo.turns.map(turn => turn.text), ['900 私聊消息']);
});

test('重置边界排除旧教师对话，保留历史事件与其他课程', t => {
  const f = fixture();
  t.after(() => f.store.close());
  const service = new TeacherConversation(f.engine);
  f.engine.createCourse('web:admin', { id: 'other', title: '另一门课', instructions: '' });
  f.engine.now = () => 100;
  const old = qq(f, '旧的演练标记');
  const other = qq(f, '另一门课的记录', '900', 'other');
  f.store.saveCourse({ ...f.store.course('math')!, teacherHistoryStartAt: 200 });
  f.engine.updateCourse('web:admin', { id: 'math', title: '数分', instructions: '课程说明' }, 1);
  f.engine.now = () => 201;
  const fresh = qq(f, '这周的题目');
  const latest = qq(f, '新的补充');
  assert.deepEqual(contextForTeacher(f.engine, latest)?.map(turn => turn.eventId), [fresh.id]);
  assert.deepEqual(service.history('other').turns.map(turn => turn.eventId), [other.id]);
  assert.equal(f.store.originalEvent(old.id)?.text, '旧的演练标记');
});

test('工作台发起、DSH 暂停，教师从 QQ 说继续做恢复同一个任务', async t => {
  const f = fixture();
  t.after(() => f.store.close());
  const assistant = new TeacherConversation(f.engine);
  const router = new Router(f.engine, { async complete(messages) {
    const input = JSON.parse(messages.at(-1)!.content);
    const [paused] = input.plan.tasks.filter((task: { status: string }) => task.status === 'paused');
    return JSON.stringify({ action: 'resume', taskId: paused.id, revision: paused.revision });
  } });
  const begin = assistant.send('math', 'workbench', '/lesson 准备一致收敛讲义', 'workbench-lesson-1');
  await router.route(f.store.event(begin.eventId)!, signal);
  const original = f.store.tasks().find(task => task.kind === 'lesson')!;
  const pause = assistant.send('math', 'dsh', '/task pause ' + original.id, 'dsh-pause-lecture-1');
  await router.route(f.store.event(pause.eventId)!, signal);
  assert.equal(f.store.task(original.id)?.status, 'paused');
  const continued = qq(f, '那就继续做');
  await router.route(continued, signal);
  assert.equal(f.store.task(original.id)?.status, 'queued');
  assert.equal(f.store.task(original.id)?.revision, 3);
  assert.equal(f.store.tasks().filter(task => task.kind === 'lesson').length, 1);
});
