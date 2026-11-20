import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.ts';
import { Router } from '../src/agents/router.ts';
import { createApi } from '../src/http/server.ts';
import { TaskRunner } from '../src/application/task-runner.ts';
import { taskHandoff } from '../src/application/task-memory.ts';
import type { TaskHandoff } from '../src/application/task-memory.ts';
import type { AgentCompletion } from '../src/ports/model.ts';

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

test('按旧产物文件名跨端找回材料，模型消歧后只修改原任务', async t => {
  const f = fixture();
  t.after(() => f.store.close());
  const call = (name: string, args: object): AgentCompletion => ({
    finishReason: 'tool_calls', content: null, toolCalls: [{ id: name, type: 'function',
      function: { name, arguments: JSON.stringify(args) } }],
  });
  const decision = (args: object): AgentCompletion => ({ finishReason: 'stop', content: JSON.stringify(args), toolCalls: [] });
  const teacher = (text: string, courseId = 'math') => f.engine.receive({ sourceKey: text + courseId, externalId: text + courseId,
    threadId: 'teacher-thread', courseId, actorId: 'qq:900', channel: { kind: 'qq-private', target: '900' },
    receivedAt: Date.now(), text }).event;
  f.engine.createCourse('web:admin', { id: 'other', title: '另一门课', instructions: '' });
  const original = f.engine.createTask(teacher('旧课件').id, 'lesson', '给学生做一份课前材料，保留反例');
  f.engine.finish(f.engine.claim(original.id)!, '学生版旧内容');
  f.store.saveTask({ ...f.store.task(original.id)!, artifacts: [
    { name: 'scaled-attention.zip', bytes: 100, sha256: 'a'.repeat(64) },
  ] });
  const otherLocal = f.engine.createTask(teacher('那一份').id, 'lesson', '另一份讲义');
  f.engine.createTask(teacher('隔壁课件', 'other').id, 'lesson', 'scaled-attention.zip 课程隔离标记');

  let clarify = true;
  const router = new Router(f.engine, {
    async complete() { throw Error('应通过模型工具定位'); },
    async completeTurn(messages) {
      const last = messages.at(-1)!;
      if (last.role !== 'tool') {
        const context = JSON.parse(String(last.content));
        assert.deepEqual(context.recentMaterialRuns.map((item: { files: string[] }) => item.files), [['scaled-attention.zip']]);
        return call('find_material_tasks', { terms: clarify ? [] : ['scaled-attention', '缩放注意力'] });
      }
      const result = JSON.parse(String(last.content));
      if (result.tasks) {
        assert.doesNotMatch(String(last.content), /课程隔离标记/);
        if (clarify) {
          assert.equal(result.tasks.length, 2);
          return decision({ action: 'reply', text: '你想改哪一份课件？' });
        }
        assert.equal(result.tasks.length, 1);
        assert.equal(result.tasks[0].taskId, original.id);
        return call('read_material_task', { taskId: result.tasks[0].taskId });
      }
      assert.equal(result.artifacts[0].name, 'scaled-attention.zip');
      assert.equal(result.resultPreview, '学生版旧内容');
      return decision({ action: 'revise', taskId: result.taskId, revision: result.revision + 1,
        goal: '把缩放注意力材料改成五分钟的课前热身，保留反例' });
    },
  });
  const vague = teacher('那份想重新排一下');
  await router.route(vague, signal);
  assert.match(f.store.deliveries().find(row => row.replyEventId === vague.id)?.text ?? '', /哪一份/);
  assert.equal(f.store.task(original.id)?.revision, 1);
  clarify = false;
  await router.route(teacher('上周的 scaled-attention.zip，整理成开课五分钟暖场'), signal);
  const revised = f.store.task(original.id)!;
  assert.equal(revised.revision, 2);
  assert.match(revised.goal, /课前热身，保留反例/);
  assert.equal(f.store.task(otherLocal.id)?.revision, 1);
  assert.equal(f.store.tasks().filter(task => task.kind === 'lesson').length, 3);
  const run = f.engine.claim(original.id)!;
  const handoff = taskHandoff(f.engine, run);
  assert.equal(handoff.recentChanges[0].channel, 'qq-private');
  assert.equal(handoff.previousOutput?.artifacts?.[0].name, 'scaled-attention.zip');
});
