import assert from 'node:assert/strict';
import test from 'node:test';
import { Router } from '../src/agents/router.ts';
import { Academics } from '../src/application/services/academics.ts';
import { QQAccess } from '../src/application/services/qq-access.ts';
import type { Event } from '../src/domain/model.ts';
import { fixture } from './helpers.ts';
import { TaskRunner } from '../src/application/task-runner.ts';
import { teachingAffairsWorker } from '../src/agents/workers/teaching-affairs-worker.ts';

function setup() {
  const f = fixture();
  f.policy.teacherIds.add('qq:901');
  f.engine.updateCourse('web:admin', { ...f.store.course('math')!, roster: ['演示甲', '演示乙'], gradingPolicy: '每题按步骤给分' }, 1);
  const academics = new Academics(f.engine), access = new QQAccess(f.engine, { isMember: async () => true });
  const signal = new AbortController().signal;
  let nextPlan: object = {};
  let calls = 0;
  let lastRequest = '';
  const model = { complete: async (messages: { content: string }[]) => {
    calls++;
    lastRequest = JSON.parse(messages.at(-1)!.content).request;
    return JSON.stringify(nextPlan);
  } };
  const router = new Router(f.engine, model);
  const teaching = teachingAffairsWorker(router.teacherWork);
  const runner = new TaskRunner(f.engine, async context =>
    context.run.task.kind === 'teaching-affairs' ? teaching(context) : { action: 'silent' });
  let messageId = 500;
  const receive = async (text: string, userId = '900', course = 'math') => {
    const received = await access.receive({ self_id: 999, user_id: userId, message_id: ++messageId,
      message_type: 'private', message: [{ type: 'text', data: { text } }] }, course);
    assert.ok('event' in received && received.event);
    return received.event as Event;
  };
  const route = async (text: string, userId?: string, course?: string) => {
    const event = await receive(text, userId, course);
    await router.route(event, signal);
    runner.tick();
    await runner.idle();
    const replies = f.store.deliveries().filter(d => d.replyEventId === event.id);
    return { event, reply: replies[0]?.text };
  };
  const codeOf = (reply?: string) => {
    const match = /确认 ([0-9A-F]{8})/.exec(reply || '');
    assert.ok(match, reply);
    return match[1];
  };
  return { ...f, academics, route, receivePrivate: receive, runner, router, codeOf, plan: (value: object) => { nextPlan = value; }, modelCalls: () => calls, lastRequest: () => lastRequest };
}

const deadline = '2026-11-20T20:00:00+08:00';

test('教师消息路由为独立事务任务，同课程先后完成且不会重复确认', async t => {
  const f = setup();
  t.after(() => f.store.close());
  const signal = new AbortController().signal;
  f.plan({ action: 'create', title: '第4次作业', instructions: '证明一致收敛', deadline });
  const first = await f.receivePrivate('新建作业「第4次作业」，证明一致收敛，11月20日20:00截止');
  const second = await f.receivePrivate('修改第5次作业，截止日期另定');
  await f.router.route(first, signal);
  await f.router.route(second, signal);
  await f.router.route(first, signal);
  const tasks = f.store.tasks();
  assert.deepEqual(tasks.map(task => [task.kind, task.status]), [['teaching-affairs','queued'], ['teaching-affairs','queued']]);
  f.runner.tick();
  assert.equal(f.runner.active.size, 1);
  await f.runner.idle();
  assert.equal(f.store.task(tasks[0].id)?.status, 'completed');
  assert.equal(f.store.task(tasks[1].id)?.status, 'queued');
  assert.equal(f.academics.assignments('math').length, 0);
  assert.equal(f.store.deliveries().filter(row => row.replyEventId === first.id).length, 1);
  assert.equal(f.store.deliveries()[0].taskId, tasks[0].id);
});

test('教师补充截止日期回到原作业，普通寒暄不会调用规划模型', async () => {
  const f = setup();
  try {
    await f.route('在吗');
    assert.equal(f.modelCalls(), 0);
    f.plan({ action: 'clarify', question: '这份作业什么时候截止？' });
    const first = '新建第十周作业，是 16.3 T7 T8 T12 T15 T20 T21';
    assert.match((await f.route(first)).reply!, /什么时候截止/);
    f.plan({ action: 'create', title: '第十周作业', instructions: '16.3 T7 T8 T12 T15 T20 T21', deadline });
    const draft = await f.route('下周四');
    assert.equal(f.lastRequest(), first + '\n下周四');
    assert.match(draft.reply!, /T7 T8 T12 T15 T20 T21/);
    assert.equal(f.academics.assignments('math').length, 0);
    await f.route('确认 ' + f.codeOf(draft.reply));
    assert.equal(f.academics.assignments('math')[0].title, '第十周作业');
  } finally { f.store.close(); }
});

test('教师 QQ 新建、修改作业和录入分数在确认后共用正式记录，重放不重复写入', async () => {
  const f = setup();
  try {
    f.plan({ action: 'create', title: '错误标题', instructions: '证明一致收敛', deadline });
    const preview = await f.route('新建作业「第4次作业」，证明一致收敛，11月20日20:00截止');
    assert.equal(f.academics.assignments('math').length, 0);
    const create = f.codeOf(preview.reply);
    await f.route('确认 ' + create);
    const a = f.academics.assignments('math')[0];
    assert.equal(a.title, '第4次作业');
    assert.equal(a.gradingPolicy, '每题按步骤给分');
    await f.route('确认 ' + create);
    assert.equal(f.academics.assignments('math').length, 1);

    f.plan({ action: 'edit', assignmentId: a.id, deadline: '2026-11-21T20:00:00+08:00' });
    const edit = f.codeOf((await f.route('把第4次作业的截止时间改到11月21日20:00')).reply);
    await f.route('确认 ' + edit);
    assert.equal(f.academics.assignment(a.id).instructions, '证明一致收敛');
    assert.equal(f.academics.assignment(a.id).deadline, '2026-11-21T12:00:00.000Z');

    f.plan({ action: 'scores', assignmentId: a.id, students: [{ name: '演示甲', score: 0 }, { name: '演示乙', score: 8.5 }] });
    const scores = f.codeOf((await f.route('第4次作业，演示甲0分、演示乙8.5分')).reply);
    assert.deepEqual(f.academics.offline(a.id), []);
    await f.route('确认 ' + scores);
    assert.deepEqual(f.academics.offline(a.id).map(row => [row.studentName, row.score]).sort(), [['演示乙', 8.5], ['演示甲', 0]]);
    assert.equal(f.modelCalls(), 3);
    assert.equal(f.store.deliveries().every(d => d.channel.kind === 'qq-private' && d.channel.target === '900'), true);
  } finally { f.store.close(); }
});

test('确认码绑定教师与课程，桌面并发更改时整批分数不落库', async () => {
  const f = setup();
  try {
    f.engine.createCourse('web:admin', { id: 'other', title: '另一门课', instructions: '' });
    const a = f.academics.saveAssignment('web:admin', { courseId: 'math', title: '第4次作业', instructions: '证明', deadline, gradingPolicy: '' });
    f.plan({ action: 'scores', assignmentId: a.id, students: [{ name: '演示甲', score: 9 }, { name: '演示乙', score: 8 }] });
    const code = f.codeOf((await f.route('登记第4次作业，演示甲9分、演示乙8分')).reply);
    assert.match((await f.route('确认 ' + code, '901')).reply!, /找不到该确认码/);
    assert.match((await f.route('确认 ' + code, '900', 'other')).reply!, /找不到该确认码/);
    await f.route('确认 ' + code, '1');
    assert.deepEqual(f.academics.offline(a.id), []);
    f.academics.register('web:admin', a.id, [{ name: '演示乙', revision: 0, score: 10 }]);
    assert.match((await f.route('确认 ' + code)).reply!, /登记已变化/);
    assert.deepEqual(f.academics.offline(a.id).map(r => [r.studentName, r.score]), [['演示乙', 10]]);
    assert.match((await f.route('取消 ' + code)).reply!, /已取消/);
    assert.match((await f.route('确认 ' + code)).reply!, /已经取消/);
  } finally { f.store.close(); }
});

test('教师业务禁止群内写入，并拒绝模型编出的学生姓名', async () => {
  const f = setup();
  try {
    const a = f.academics.saveAssignment('web:admin', { courseId: 'math', title: '第4次作业', instructions: '证明', deadline, gradingPolicy: '' });
    f.plan({ action: 'scores', assignmentId: a.id, students: [{ name: '演示乙', score: 9 }] });
    assert.match((await f.route('给第4次作业登记分数，演示甲9分')).reply!, /姓名与课程名单不匹配/);
    const group = f.receive('给第4次作业登记分数，演示乙9分', { actorId: 'qq:900' });
    await assert.rejects(new Router(f.engine, { complete: async () => { throw Error('不能调用模型'); } }).route(group, new AbortController().signal), /教师私信/);
    assert.deepEqual(f.academics.offline(a.id), []);
  } finally { f.store.close(); }
});
