import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers.ts';
import { Router } from '../src/agents/router.ts';
import { TaskRunner } from '../src/application/task-runner.ts';
import { buildRouterContext, formatCoursePlan } from '../src/agents/router-context.ts';
import { courseReports, currentReports } from '../src/application/task-reports.ts';
import { Store } from '../src/adapters/storage/sqlite.ts';
import { TaskEngine } from '../src/application/task-engine.ts';
import { Policy } from '../src/security/policy.ts';
import { TeacherConversation } from '../src/application/teacher-conversation.ts';

const signal = new AbortController().signal;
const noModel = { async complete(): Promise<string> { throw new Error('不应调用规划模型'); } };

type Fixture = ReturnType<typeof fixture>;
function teacher(f: Fixture, text: string, courseId = 'math') {
  return f.engine.receive({ sourceKey: randomUUID(), externalId: randomUUID(), threadId: 'teacher-thread',
    courseId, actorId: 'qq:900', channel: { kind: 'qq-private', target: '900' },
    receivedAt: Date.now(), text }).event;
}
async function lesson(f: Fixture, text = '/lesson 准备一致收敛讲义，保留反例') {
  await new Router(f.engine, noModel).route(teacher(f, text), signal);
  return f.store.tasks().filter(task => task.kind === 'lesson').at(-1)!;
}

test('Worker 返回结果时在同一事务写入汇报，且证据只含引用', async () => {
  const f = fixture();
  const task = await lesson(f);
  const epoch = f.store.task(task.id)!.inputEpoch;
  const runner = new TaskRunner(f.engine, async () => '讲义正文');
  runner.tick();
  await runner.idle();
  const reports = courseReports(f.store, 'math');
  assert.equal(reports.length, 1);
  const [report] = reports;
  assert.equal(report.taskId, task.id);
  assert.equal(report.revision, 1);
  assert.equal(report.inputEpoch, epoch);
  assert.equal(report.outcome, 'completed');
  assert.match(report.data.summary, /一致收敛/);
  assert.ok(report.data.evidence.every(item => typeof item.id === 'string'));
  assert.ok(report.data.evidence.some(item => item.kind === 'event'));
  assert.deepEqual(report.data.unresolved, []);
  assert.equal(report.data.next, 'none');
  assert.equal(f.store.task(task.id)?.status, 'completed');
  f.store.close();
});

test('Worker 用 complete(result) 提前提交时只写一份汇报', async () => {
  const f = fixture();
  const task = await lesson(f);
  const runner = new TaskRunner(f.engine, async ({ complete }) => {
    complete!({ action: 'silent' });
    return { action: 'silent' };
  });
  runner.tick();
  await runner.idle();
  const reports = courseReports(f.store, 'math');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].outcome, 'completed');
  assert.equal(f.store.task(task.id)?.result, undefined);
  assert.equal(f.store.deliveries().length, 0);
  f.store.close();
});

test('真正停在 waiting_teacher 才记等待汇报，已回答回队不记', async () => {
  const f = fixture();
  const origin = teacher(f, '备课');
  const task = f.engine.createTask(origin.id, 'scheduled', '准备下周讲义');
  const question = teacher(f, '讲到哪了？');
  const run = f.engine.claim(task.id)!;
  f.engine.updateDSH(run, stored => { stored.teacherWait = { questionId: question.id }; });
  f.engine.finish(run, '等待教师回答', { source: 'worker' });
  const [report] = courseReports(f.store, 'math');
  assert.equal(report.outcome, 'waiting_teacher');
  assert.equal(report.data.next, 'answer_teacher_question');
  assert.ok(report.data.evidence.some(item => item.kind === 'teacher_question' && item.id === question.id));
  assert.match(report.data.unresolved[0], /教师/);
  assert.equal(f.store.task(task.id)?.status, 'waiting_teacher');

  // 教师已在运行中答复：直接回队，不产生第二份汇报。
  const second = f.engine.claim((() => {
    const queued = f.store.task(task.id)!;
    queued.status = 'queued';
    f.store.saveTask(queued);
    return task.id;
  })())!;
  f.engine.updateDSH(second, stored => { stored.teacherWait = { questionId: question.id, answerId: question.id }; });
  f.engine.finish(second, '继续执行', { source: 'worker' });
  assert.equal(courseReports(f.store, 'math').length, 1);
  assert.equal(f.store.task(task.id)?.status, 'queued');
  f.store.close();
});

test('有效运行最终 blocked 时写阻塞汇报，异常原文不进入汇报', async () => {
  const f = fixture();
  const task = await lesson(f);
  const runner = new TaskRunner(f.engine, async () => { throw new Error('secret-token-abc123 模型失败'); });
  runner.tick();
  await runner.idle();
  const [report] = courseReports(f.store, 'math');
  assert.equal(report.outcome, 'blocked');
  assert.match(report.data.summary, /阻塞/);
  assert.equal(report.data.next, 'inspect_blocker');
  assert.match(report.data.unresolved[0], /模型调用失败/);
  assert.ok(!JSON.stringify(report).includes('secret-token-abc123'));
  assert.equal(f.store.task(task.id)?.status, 'blocked');
  f.store.close();
});

test('旧运行因新输入失效时不产生当前汇报', async () => {
  const f = fixture();
  const question = f.receive('第3题怎么做');
  const task = f.engine.createTask(question.id, 'qa', question.text);
  const run = f.engine.claim(task.id)!;
  const epoch = f.store.task(task.id)!.inputEpoch;
  f.receive('再补充一句', { threadId: question.threadId });
  assert.ok(f.store.task(task.id)!.inputEpoch > epoch);
  f.engine.fail(run, new Error('晚到的失败'));
  assert.equal(f.store.task(task.id)?.status, 'queued');
  assert.equal(courseReports(f.store, 'math').length, 0);
  f.store.close();
});

test('同步业务回执与外发回执不产生 Worker 汇报', async () => {
  const f = fixture();
  const event = teacher(f, '本课程还有什么等我决定');
  f.engine.replyToTeacher(event, '已收到');
  assert.equal(f.store.deliveries().filter(row => row.replyEventId === event.id).length, 1);
  assert.equal(courseReports(f.store, 'math').length, 0);
  const task = f.store.tasks()[0];
  const run = f.engine.claim(task.id);
  assert.equal(run, undefined);
  f.store.close();
});

test('课程计划包含待处理任务与去敏汇报，排除学生私聊任务', async () => {
  const f = fixture();
  const done = await lesson(f, '/lesson 一致收敛讲义');
  const doneRun = f.engine.claim(done.id)!;
  f.engine.updateDSH(doneRun, stored => { stored.artifacts = [{ name: '讲义.md', bytes: 12, sha256: 'a'.repeat(64) }]; });
  f.engine.finish(doneRun, '讲义正文', { source: 'worker' });

  const paused = await lesson(f, '/lesson 实验说明');
  f.engine.control(teacher(f, '先停一下').id, paused.id, 'pause', 1);

  const privateEvent = f.engine.receive({ sourceKey: randomUUID(), externalId: randomUUID(), threadId: randomUUID(),
    courseId: 'math', actorId: 'qq:1', channel: { kind: 'qq-private', target: '1' }, receivedAt: Date.now(), text: '私信问题' }).event;
  f.engine.createTask(privateEvent.id, 'qa', privateEvent.text);

  const plan = buildRouterContext(f.engine, teacher(f, '/plan'))!;
  assert.equal(plan.course.id, 'math');
  assert.deepEqual(plan.tasks.map(task => task.id), [paused.id]);
  assert.equal(plan.counts.paused, 1);
  assert.ok(plan.reports.some(report => report.taskId === done.id && report.summary.includes('已完成')));
  assert.ok(plan.pending.some(item => item.taskId === done.id && item.type === 'review_output'));
  assert.ok(!plan.tasks.some(task => task.id === privateEvent.id));

  const text = formatCoursePlan(plan);
  assert.match(text, new RegExp(paused.id));
  assert.match(text, /版本 2/);
  assert.ok(!text.includes('私信问题'));
  f.store.close();
});

test('任务版本变化后旧汇报不再指挥下一次决策', async () => {
  const f = fixture();
  const task = await lesson(f);
  const run = f.engine.claim(task.id)!;
  f.engine.finish(run, '第一版', { source: 'worker' });
  assert.equal(currentReports(f.store, 'math').length, 1);
  f.engine.control(teacher(f, '改成两页').id, task.id, 'revise', 1, '缩到两页');
  assert.equal(currentReports(f.store, 'math').length, 0);
  assert.equal(courseReports(f.store, 'math').length, 1);
  f.store.close();
});

test('教师问「还有什么等我决定」由课程计划确定性回答，不调用模型', async () => {
  const f = fixture();
  const task = await lesson(f);
  f.engine.control(teacher(f, '暂停').id, task.id, 'pause', 1);
  const router = new Router(f.engine, noModel);
  const question = teacher(f, '本课程还有什么等我决定');
  await router.route(question, signal);
  const reply = f.store.deliveries().find(row => row.replyEventId === question.id)?.text ?? '';
  assert.match(reply, /待处理/);
  assert.match(reply, new RegExp(task.id));
  assert.match(reply, /已暂停/);
  f.store.close();
});

test('「继续刚才那份讲义」续跑同一暂停任务并保留任务 ID', async () => {
  const f = fixture();
  const task = await lesson(f);
  f.engine.control(teacher(f, '暂停').id, task.id, 'pause', 1);
  const router = new Router(f.engine, noModel);
  const message = teacher(f, '继续刚才那份讲义');
  await router.route(message, signal);
  assert.equal(f.store.task(task.id)?.status, 'queued');
  assert.equal(f.store.tasks().filter(row => row.kind === 'lesson').length, 1);
  const reply = f.store.deliveries().find(row => row.replyEventId === message.id)?.text ?? '';
  assert.match(reply, new RegExp(task.id));
  f.store.close();
});

test('两份候选时只澄清，不替教师选任务', async () => {
  const f = fixture();
  const first = await lesson(f, '/lesson 第一份讲义');
  const second = await lesson(f, '/lesson 第二份讲义');
  f.engine.control(teacher(f, '暂停一').id, first.id, 'pause', 1);
  f.engine.control(teacher(f, '暂停二').id, second.id, 'pause', 1);
  const router = new Router(f.engine, noModel);
  const message = teacher(f, '继续刚才那份讲义');
  await router.route(message, signal);
  assert.equal(f.store.task(first.id)?.status, 'paused');
  assert.equal(f.store.task(second.id)?.status, 'paused');
  const reply = f.store.deliveries().find(row => row.replyEventId === message.id)?.text ?? '';
  assert.match(reply, /哪一份/);
  assert.match(reply, new RegExp(first.id));
  assert.match(reply, new RegExp(second.id));
  f.store.close();
});

test('教师自然语言规划请求携带课程计划，学生答疑不带', async () => {
  const f = fixture();
  const task = await lesson(f);
  f.engine.control(teacher(f, '暂停').id, task.id, 'pause', 1);
  let seen: { plan?: { tasks?: { id: string }[] } } | undefined;
  const router = new Router(f.engine, { async complete(messages: { content: string }[]) {
    seen = JSON.parse(messages.at(-1)!.content);
    return JSON.stringify({ action: 'create', kind: 'qa', goal: '讨论安排' });
  } });
  await router.route(teacher(f, '准备下次课讲义'), signal);
  assert.ok(seen?.plan?.tasks?.some(item => item.id === task.id));

  let calls = 0;
  const studentRouter = new Router(f.engine, { async complete() { calls++; return '{}'; } });
  const student = f.receive('第5题怎么做');
  await studentRouter.route(student, signal);
  assert.equal(calls, 0);
  f.store.close();
});

test('汇报持久化：重启后仍可读，旧库无汇报也不影响任务查询', () => {
  const path = join(tmpdir(), 'ta-reports-' + randomUUID() + '.sqlite');
  try {
    const first = fixture(path);
    const task = first.engine.createTask(teacher(first, '备课').id, 'scheduled', '准备讲义');
    const run = first.engine.claim(task.id)!;
    first.engine.finish(run, '讲义正文', { source: 'worker' });
    first.store.close();

    const store = new Store(path);
    const engine = new TaskEngine(store, new Policy(['900']));
    assert.equal(courseReports(store, 'math').length, 1);
    const event = engine.receive({ sourceKey: 'plan-after-restart', externalId: 'plan-after-restart',
      threadId: 'teacher-thread', courseId: 'math', actorId: 'qq:900',
      channel: { kind: 'qq-private', target: '900' }, receivedAt: Date.now(), text: '/plan' }).event;
    const plan = buildRouterContext(engine, event)!;
    assert.ok(plan.reports.some(report => report.taskId === task.id));
    store.close();
  } finally {
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  }
});

test('另一门课看不到前一门课的任务与汇报', async () => {
  const f = fixture();
  f.engine.createCourse('web:admin', { id: 'other', title: '其他课程', instructions: '' });
  const mathTask = await lesson(f);
  f.engine.control(teacher(f, '暂停').id, mathTask.id, 'pause', 1);
  let seen: { plan?: { course?: { id: string }; tasks?: { id: string }[] } } | undefined;
  const router = new Router(f.engine, { async complete(messages: { content: string }[]) {
    seen = JSON.parse(messages.at(-1)!.content);
    return JSON.stringify({ action: 'create', kind: 'qa', goal: '讨论安排' });
  } });
  await router.route(teacher(f, '准备下次课讲义', 'other'), signal);
  assert.equal(seen?.plan?.course?.id, 'other');
  assert.ok(!seen?.plan?.tasks?.some(item => item.id === mathTask.id));
  f.store.close();
});

test('DSH 助教会话问计划时，确定性回答写回同一会话', async () => {
  const f = fixture();
  const task = await lesson(f);
  f.engine.control(teacher(f, '暂停').id, task.id, 'pause', 1);
  const conversation = new TeacherConversation(f.engine);
  const sent = conversation.send('math', 'dsh', '本课程还有什么等我决定', 'r'.repeat(16));
  await new Router(f.engine, noModel).route(f.store.event(sent.eventId)!, signal);
  const turn = conversation.turn('math', sent.eventId);
  assert.match(turn.reply ?? '', new RegExp(task.id));
  assert.equal(f.store.deliveries().filter(row => row.replyEventId === sent.eventId).length, 0);
  f.store.close();
});

test('模型编造陌生任务 ID 或旧版本时不修改任何任务', async () => {
  const f = fixture();
  const task = await lesson(f);
  const router = new Router(f.engine, { async complete() {
    return JSON.stringify({ action: 'revise', taskId: randomUUID(), revision: 1, goal: '被编造的新目标' });
  } });
  const fabricated = teacher(f, '准备下次课讲义');
  await router.route(fabricated, signal);
  assert.equal(f.store.task(task.id)?.goal, '准备一致收敛讲义，保留反例');
  assert.equal(f.store.task(task.id)?.revision, 1);
  const reply = f.store.deliveries().find(row => row.replyEventId === fabricated.id)?.text ?? '';
  assert.match(reply, /任务 ID/);

  const stale = new Router(f.engine, { async complete() {
    return JSON.stringify({ action: 'revise', taskId: task.id, revision: 9, goal: '过期版本' });
  } });
  await assert.rejects(stale.route(teacher(f, '准备下次课讲义'), signal), /版本/);
  assert.equal(f.store.task(task.id)?.goal, '准备一致收敛讲义，保留反例');
  f.store.close();
});
