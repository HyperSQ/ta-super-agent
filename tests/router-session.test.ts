import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.ts';
import { Router } from '../src/agents/router.ts';
import { buildRouterContext } from '../src/agents/router-context.ts';
import { courseReports } from '../src/application/task-reports.ts';
import { RouterSessions } from '../src/application/router-sessions.ts';
import { TeacherConversation } from '../src/application/teacher-conversation.ts';
import type { Event } from '../src/domain/model.ts';

const signal = new AbortController().signal;

function event(f: ReturnType<typeof fixture>): Event {
  return f.engine.receive({ sourceKey: randomUUID(), externalId: randomUUID(), threadId: 'thread-router', courseId: 'math',
    actorId: 'qq:1', channel: { kind: 'qq-private', target: '1' }, receivedAt: f.engine.now(), text: '我作业交了吗' }).event;
}

test('Router 保留常驻会话：消息、决策与 Worker 报告进入同一线程', async () => {
  const f = fixture();
  try {
    const router = new Router(f.engine, { async complete(): Promise<string> { throw new Error('不应调用模型'); } });
    const first = event(f);
    await router.route(first, signal);
    const sessions = new RouterSessions(f.engine);
    const session = sessions.ensure('math', 'thread-router');
    let turns = sessions.recent(session);
    assert.equal(turns[0].role, 'user');
    assert.equal(turns[0].content, '我作业交了吗');
    assert.equal(sessions.decisions('math').length, 1);
    assert.equal((sessions.decisions('math')[0] as { action: string }).action, 'create');

    const task = f.store.tasks().find(item => item.courseId === 'math')!;
    const run = f.engine.claim(task.id)!;
    f.engine.finish(run, '还没交，第 3 次作业截止到 12 月 20 日。', { source: 'worker' });
    turns = sessions.recent(sessions.ensure('math', 'thread-router'));
    assert.ok(turns.some(turn => turn.role === 'assistant' && turn.content === '[completed] 学生答疑已处理'));
  } finally { f.store.close(); }
});

test('工作台与 DSH 共享教师协调会话，Worker 汇报来自提交状态', async () => {
  const f = fixture();
  try {
    const inputs: { routerSession: { content: string }[] }[] = [];
    const router = new Router(f.engine, { async complete(messages) {
      inputs.push(JSON.parse(String(messages.at(-1)?.content)));
      return JSON.stringify({ action: 'create', kind: 'lesson', goal: '熟悉一致收敛' });
    } });
    const conversation = new TeacherConversation(f.engine);
    const first = conversation.send('math', 'workbench', '准备讲义，覆盖值守标记', 'test-router-first');
    await router.route(f.store.event(first.eventId)!, signal);
    const task = f.store.tasks()[0];
    f.engine.finish(f.engine.claim(task.id)!, '供教师核对的讲义草稿', { source: 'worker' });
    const follow = conversation.send('math', 'dsh', '准备讲义，安排例题', 'test-router-second');
    await router.route(f.store.event(follow.eventId)!, signal);
    assert.ok(inputs[1].routerSession.some(row => row.content.includes('值守标记')));
    const sessions = new RouterSessions(f.engine);
    const stored = sessions.recent(sessions.forEvent(f.store.event(follow.eventId)!));
    assert.ok(stored.some(row => row.content === '[completed] 已完成「熟悉一致收敛」'));
    assert.ok(!stored.some(row => row.content.includes('供教师核对的讲义草稿')));
  } finally { f.store.close(); }
});

test('协调模型不会收到学生私聊任务原文或教师在群里不可见的课程计划', async () => {
  const f = fixture();
  try {
    const inputs: string[] = [];
    const router = new Router(f.engine, { async complete(messages) {
      inputs.push(String(messages.at(-1)?.content));
      return JSON.stringify({ action: 'create', kind: 'lesson', goal: '习题课材料' });
    } });
    const studentPrivate = event(f);
    f.engine.createTask(studentPrivate.id, 'qa', studentPrivate.text);
    const conversation = new TeacherConversation(f.engine);
    const request = conversation.send('math', 'workbench', '准备讲义，标记 PRIVATE-TEACHER-NOTE', 'router-privacy-first');
    await router.route(f.store.event(request.eventId)!, signal);
    assert.doesNotMatch(inputs[0], /我作业交了吗/);
    const group = f.receive('准备讲义，给下一次习题课', { actorId: 'qq:900' });
    await router.route(group, signal);
    assert.doesNotMatch(inputs[1], /PRIVATE-TEACHER-NOTE|习题课材料|"plan":/);
  } finally { f.store.close(); }
});

test('教师会话重置后 Router 只读取新汇报，旧汇报仍可追溯', t => {
  const f = fixture();
  t.after(() => f.store.close());
  const assistant = new TeacherConversation(f.engine);
  f.engine.now = () => 10;
  const first = f.store.event(assistant.send('math', 'workbench', '旧的讲义', 'test-context-reset-first').eventId)!;
  const oldTask = f.engine.createTask(first.id, 'lesson', '旧的讲义');
  f.engine.finish(f.engine.claim(oldTask.id)!, '旧讲义成稿', { source: 'worker' });
  assert.equal(buildRouterContext(f.engine, first)?.reports[0]?.taskId, oldTask.id);

  f.store.saveCourse({ ...f.store.course('math')!, teacherHistoryStartAt: 20 });
  f.engine.now = () => 21;
  const next = f.store.event(assistant.send('math', 'workbench', '新的讲义', 'test-context-reset-second').eventId)!;
  const freshTask = f.engine.createTask(next.id, 'lesson', '新的讲义');
  f.engine.finish(f.engine.claim(freshTask.id)!, '新讲义成稿', { source: 'worker' });
  assert.deepEqual(buildRouterContext(f.engine, next)?.reports.map(report => report.taskId), [freshTask.id]);
  assert.equal(courseReports(f.store, 'math').length, 2);
});
