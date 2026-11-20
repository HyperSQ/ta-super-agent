import assert from 'node:assert/strict';
import test from 'node:test';
import { Router } from '../src/agents/router.ts';
import { TextbookReferences } from '../src/adapters/knowledge/references.ts';
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
  let nextRoute = 'teaching-affairs';
  let calls = 0;
  let lastRequest = '';
  let lastRoute: { message: string; pendingTeacherWork: string[] } | undefined;
  const model = { complete: async (messages: { content: string }[]) => {
    const input = JSON.parse(messages.at(-1)!.content);
    if (typeof input.message === 'string') {
      lastRoute = input;
      return JSON.stringify({ action: 'create', kind: nextRoute, goal: input.message });
    }
    calls++;
    lastRequest = input.request;
    return JSON.stringify({ mode: 'save', ...nextPlan });
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
  return { ...f, academics, route, receivePrivate: receive, runner, router, codeOf, plan: (value: object) => { nextPlan = value; },
    classifyAs: (kind: string) => { nextRoute = kind; }, lastRoute: () => lastRoute, modelCalls: () => calls, lastRequest: () => lastRequest };
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
  assert.equal(f.academics.assignments('math').length, 1);
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
    assert.match(f.academics.assignments('math')[0].instructions, /T7 T8 T12 T15 T20 T21/);
    assert.equal(f.academics.assignments('math').length, 1);
    assert.match(draft.reply!, /已新建作业/);
    assert.equal(f.academics.assignments('math')[0].title, '第十周作业');
  } finally { f.store.close(); }
});

test('教师 QQ 直接新建和修改作业，登分照常确认，重发作业不会重复写入', async () => {
  const f = setup();
  try {
    f.plan({ action: 'create', title: '错误标题', instructions: '证明一致收敛', deadline });
    const request = '新建作业「第4次作业」，证明一致收敛，11月20日20:00截止';
    assert.match((await f.route(request)).reply!, /已新建作业/);
    assert.equal(f.academics.assignments('math').length, 1);
    const a = f.academics.assignments('math')[0];
    assert.equal(a.title, '第4次作业');
    assert.equal(a.gradingPolicy, '每题按步骤给分');
    assert.match((await f.route(request)).reply!, /已经布置/);
    assert.equal(f.academics.assignments('math').length, 1);

    f.plan({ action: 'edit', assignmentId: a.id, deadline: '2026-11-21T20:00:00+08:00' });
    assert.match((await f.route('把第4次作业的截止时间改到11月21日20:00')).reply!, /已保存作业/);
    assert.equal(f.academics.assignment(a.id).instructions, '证明一致收敛');
    assert.equal(f.academics.assignment(a.id).deadline, '2026-11-21T12:00:00.000Z');

    f.plan({ action: 'scores', assignmentId: a.id, students: [{ name: '演示甲', score: 0 }, { name: '演示乙', score: 8.5 }] });
    const scores = f.codeOf((await f.route('第4次作业，演示甲0分、演示乙8.5分')).reply);
    assert.deepEqual(f.academics.offline(a.id), []);
    await f.route('确认 ' + scores);
    assert.deepEqual(f.academics.offline(a.id).map(row => [row.studentName, row.score]).sort(), [['演示乙', 8.5], ['演示甲', 0]]);
    assert.equal(f.modelCalls(), 4);
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


test('教师私聊直接发两节题号，只需补截止时间，写入下一周作业', async t => {
  const f = setup();
  t.after(() => f.store.close());
  f.academics.saveAssignment('web:admin', { courseId: 'math', title: '第十一周作业', instructions: '其他题', deadline, gradingPolicy: '' });
  f.plan({ action: 'clarify', question: '这份作业什么时候截止？' });
  assert.match((await f.route('1.1 T1 T2，1.2 T1')).reply!, /什么时候截止/);
  assert.equal(f.academics.assignments('math').length, 1);
  f.plan({ action: 'create', title: '第12周作业', instructions: '1.1 T1 T2，1.2 T1', deadline: '2026-11-25T22:00:00+08:00' });
  const saved = await f.route('2026年11月25日 22:00');
  assert.match(saved.reply!, /已新建作业「第12周作业」/);
  const assignments = f.academics.assignments('math');
  assert.equal(assignments.length, 2);
  assert.equal(assignments[1].instructions, '1.1 T1 T2，1.2 T1');
  assert.equal(assignments[1].deadline, '2026-11-25T14:00:00.000Z');
  assert.equal(assignments[1].studentVisible, false);
  assert.match((await f.route('1.1 T1 T2，1.2 T1，2026-11-25 22:00截止')).reply!, /已经布置/);
  assert.equal(f.academics.assignments('math').length, 2);
  f.classifyAs('qa');
  const look = await f.route('1.1 T1 怎么做？');
  assert.equal(f.store.tasks().find(task => task.grant.originEventId === look.event.id)?.kind, 'qa');
  await f.route('1.1 T1 T2，1.2 T1', '1');
  assert.equal(f.academics.assignments('math').length, 2);
  assert.equal(f.modelCalls(), 3);
});

test('教师用“第一周的作业布置”发题号时查缺失截止时间并真实创建', async t => {
  const f = setup();
  t.after(() => f.store.close());
  f.engine.now = () => Date.parse('2026-11-19T11:08:41+08:00');
  f.academics.saveAssignment('web:admin', { courseId: 'math', title: '第3周作业', instructions: '别的题', deadline, gradingPolicy: '' });
  f.plan({ action: 'clarify', question: '这份作业什么时候截止？' });
  const initial = '第一周的作业布置1.1 T1 T2，1.2 T1';
  const request = await f.route(initial);
  assert.match(request.reply!, /什么时候截止/);
  assert.equal(f.academics.assignments('math').length, 1);
  assert.equal(f.store.tasks().find(task => task.grant.originEventId === request.event.id)?.kind, 'teaching-affairs');
  f.classifyAs('qa');
  const unrelated = await f.route('讲一下为什么注意力要缩放');
  assert.equal(f.store.tasks().find(task => task.grant.originEventId === unrelated.event.id)?.kind, 'qa');
  f.classifyAs('teaching-affairs');
  const followup = '那就等下个礼拜四结束前交吧';
  f.plan({ action: 'create', title: '第1周作业', instructions: '1.1 T1 T2，1.2 T1', deadline: '2026-11-26T23:59:00+08:00' });
  assert.match((await f.route(followup)).reply!, /已新建作业「第1周作业」/);
  assert.deepEqual(f.lastRoute()?.pendingTeacherWork, [initial]);
  assert.equal(f.lastRequest(), initial + '\n' + followup);
  const saved = f.academics.assignments('math').find(assignment => assignment.title === '第1周作业');
  assert.equal(saved?.instructions, '1.1 T1 T2，1.2 T1');
  assert.equal(saved?.deadline, '2026-11-26T15:59:00.000Z');
  assert.equal(f.modelCalls(), 2);
});

test('仅发题号可补节号，QQ 预览的确认不需要码且不能代替登分确认', async t => {
  const f = setup();
  t.after(() => f.store.close());
  f.plan({ action: 'clarify', question: '这些题是哪一节的？' });
  assert.match((await f.route('T2 T3')).reply!, /哪一节/);
  f.plan({ action: 'clarify', question: '这份作业什么时候截止？' });
  assert.match((await f.route('15.2')).reply!, /什么时候截止/);
  f.plan({ action: 'create', title: '第1周作业', deadline:'2026-11-25T22:00:00+08:00', instructions:'15.2 T2 T3' });
  assert.match((await f.route('11月25日 22:00')).reply!, /第1周作业/);
  const created = f.academics.assignments('math')[0];
  assert.equal(created.instructions, '15.2 T2 T3');
  f.plan({ action: 'create', mode: 'preview', title: '额外练习', deadline, instructions: '证明一致收敛' });
  const draft = await f.route('新建作业「额外练习」，证明一致收敛，11月20日20:00截止。先给我预览。');
  assert.match(draft.reply!, /回「确认」/);
  assert.doesNotMatch(draft.reply!, /确认码/);
  assert.equal(f.academics.assignments('math').length, 1);
  await f.route('确认', '901');
  assert.equal(f.academics.assignments('math').length, 1);
  assert.match((await f.route('确认')).reply!, /已新建作业「额外练习」/);
  assert.equal(f.academics.assignments('math').length, 2);
  f.plan({ action: 'scores', assignmentId: created.id, students: [{ name: '演示甲', score: 8 }] });
  const scoreDraft = await f.route('登记第1周作业，演示甲8分');
  assert.match(scoreDraft.reply!, /确认码/);
  await f.route('确认');
  assert.deepEqual(f.academics.offline(created.id), []);
});

test('作业 Agent 自行调用教材工具，按模型结构化决定保存作业', async t => {
  const f = fixture();
  t.after(() => f.store.close());
  f.store.saveCourse({ ...f.store.course('math')!, textbookIds: ['course-book'] });
  const refs = new TextbookReferences('unused-test-library');
  refs.lookup = (books, query) => {
    assert.deepEqual(books, ['course-book']);
    assert.equal(query, '1.2 T1');
    return { requested: ['1.2 T1'], unresolved: [], found: [{ label:'1.2 T1', bookId:'course-book', page:4,
      endPage:4, text:'测试题目', needsVisualVerification:false }] };
  };
  const router = new Router(f.engine, {
    async complete() { throw Error('此场景直接进入作业 Agent'); },
    async completeTurn(messages, tools) {
      if (tools.some(tool => tool.function.name === 'list_schedules'))
        return { finishReason: 'stop', content: JSON.stringify({ action: 'create', kind: 'teaching-affairs', goal: '布置作业' }), toolCalls: [] };
      assert.equal(tools[0].function.name, 'lookup_textbook');
      const latest = messages.at(-1)!;
      if (latest.role !== 'tool') return { finishReason: 'tool_calls', content: null, toolCalls: [{
        id: 'lookup', type: 'function', function: { name:'lookup_textbook', arguments:'{"query":"1.2 T1"}' },
      }] };
      assert.match(String(latest.content), /"page":4/);
      return { finishReason:'stop', content: JSON.stringify({ action:'create', mode:'save', title:'第1周作业',
        instructions:'1.2 T1', deadline }), toolCalls:[] };
    },
  }, refs);
  const { event } = f.engine.receive({ courseId:'math', sourceKey:'teacher-agent-tool', externalId:'teacher-agent-tool',
    channel:{ kind:'qq-private', target:'900' }, actorId:'qq:900', threadId:'teacher-tool-chat', receivedAt:Date.now(),
    text:'布置作业，1.2 T1，11月20日晚上八点交。' });
  await router.route(event, new AbortController().signal);
  const runner = new TaskRunner(f.engine, teachingAffairsWorker(router.teacherWork));
  runner.tick();
  await runner.idle();
  assert.equal(new Academics(f.engine).assignments('math').length, 1);
  assert.match(f.store.deliveries().find(item => item.replyEventId === event.id)?.text ?? '', /已新建作业.*\n[\s\S]*PDF 第 4 页/);
});
