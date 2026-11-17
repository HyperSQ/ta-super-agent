import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.ts';
import { Router } from '../src/agents/router.ts';
import { createApi } from '../src/http/server.ts';
import { TaskRunner } from '../src/application/task-runner.ts';
import { taskHandoff } from '../src/application/task-memory.ts';
import type { TaskHandoff } from '../src/application/task-memory.ts';

const signal = new AbortController().signal;
const noModel = { async complete() { throw Error('不应调用路由模型'); } };

test('QQ 建讲义、DSH 修改、Worker 恢复同一任务，跨课和过期版本被拒绝', async t => {
  const f = fixture();
  f.engine.createCourse('web:admin', { id: 'other', title: '其他课程', instructions: '' });
  const router = new Router(f.engine, noModel);
  const request = f.receive('/lesson 准备一致收敛讲义，保留反例', { actorId: 'qq:900' });
  await router.route(request, signal);
  const task = f.store.tasks()[0];
  const run = f.engine.claim(task.id)!;
  f.engine.finish(run, '原始讲义正文：例题和反例');

  const config = { adminToken: 'test-admin-token', webhookToken: 'test-qq-hook' };
  const server = createApi(f.engine, config);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    f.store.close();
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const post = (course: string, path: string, data: object, token = config.adminToken) =>
    fetch('http://127.0.0.1:' + address.port + '/v1/dsh/courses/' + course + '/' + path, {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(data),
    });
  const read = await post('math', 'task-memory', { query: '一致收敛' });
  assert.equal(read.status, 200);
  assert.equal((await read.json() as { candidates: { taskId: string }[] }).candidates[0].taskId, task.id);
  assert.equal((await post('other', 'task-memory', { taskId: task.id })).status, 404);
  assert.equal((await post('math', 'task-memory', {}, config.webhookToken)).status, 401);
  const change = { taskId: task.id, revision: 1, goal: '缩成两页，保留反例', requestId: 'a'.repeat(64) };
  const revised = await post('math', 'task-revision', change);
  assert.equal(revised.status, 200);
  assert.equal((await post('math', 'task-revision', change)).status, 200);
  assert.equal((await post('math', 'task-revision', { ...change, requestId: 'b'.repeat(64) })).status, 409);
  assert.equal(f.store.task(task.id)?.revision, 2);
  assert.equal(f.store.tasks().length, 1);
  let handoff: TaskHandoff | undefined;
  const runner = new TaskRunner(f.engine, async context => { handoff = context.handoff; return '新版讲义正文'; });
  runner.tick();
  await runner.idle();
  assert.equal(handoff?.task.id, task.id);
  assert.equal(handoff?.task.revision, 2);
  assert.equal(handoff?.task.role, 'teaching-materials');
  assert.equal(handoff?.origin?.eventId, request.id);
  assert.equal(handoff?.recentChanges[0].channel, 'management');
  assert.match(handoff?.previousOutput?.excerpt ?? '', /原始讲义/);
  assert.equal(f.store.task(task.id)?.result, '新版讲义正文');
});

test('教师说刚才那份时存在两个候选就询问，明确任务后保留原任务身份', async t => {
  const f = fixture();
  t.after(() => f.store.close());
  let modelCalls = 0;
  const router = new Router(f.engine, { async complete(messages) {
    modelCalls++;
    const info = JSON.parse(String(messages[1].content));
    assert.match(info.currentGoal, /保留反例/);
    return JSON.stringify({ goal: '讲义缩到两页，保留反例' });
  } });
  const teacher = (text: string) => f.engine.receive({ sourceKey: text, externalId: text, threadId: 'teacher-thread', courseId: 'math',
    actorId: 'qq:900', channel: { kind: 'qq-private', target: '900' }, receivedAt: Date.now(), text }).event;
  await router.route(teacher('/lesson 第一份讲义，保留反例'), signal);
  await router.route(teacher('/lesson 第二份讲义，包含测试'), signal);
  const lesson = f.store.tasks()[0];
  const vague = teacher('把刚才那份讲义缩到两页');
  await router.route(vague, signal);
  assert.equal(modelCalls, 0);
  assert.match(f.store.deliveries().find(row => row.replyEventId === vague.id)?.text ?? '', /哪一份/);
  await router.route(teacher('把讲义缩到两页 ' + lesson.id), signal);
  assert.equal(modelCalls, 1);
  assert.equal(f.store.task(lesson.id)?.goal, '讲义缩到两页，保留反例');
  assert.equal(f.store.tasks().filter(task => task.kind === 'lesson').length, 2);
  const run = f.engine.claim(lesson.id)!;
  assert.equal(taskHandoff(f.engine, run).recentChanges[0].channel, 'qq-private');
});
