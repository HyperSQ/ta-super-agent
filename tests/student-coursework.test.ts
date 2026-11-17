import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.ts';
import { Academics } from '../src/application/services/academics.ts';
import { studentCoursework } from '../src/application/services/student-coursework.ts';
import { QATools } from '../src/agents/qa-tools.ts';
import { Router } from '../src/agents/router.ts';

const signal = new AbortController().signal;

function setup() {
  const f = fixture();
  f.engine.updateCourse('web:admin', { ...f.store.course('math')!, roster: ['张三', '李四'] }, 1);
  const academics = new Academics(f.engine);
  const first = academics.saveAssignment('web:admin', {
    courseId: 'math', title: '第3次作业', instructions: '证明一致收敛', deadline: '2026-11-10T20:00:00+08:00',
    gradingPolicy: '', studentVisible: true,
  });
  const second = academics.saveAssignment('web:admin', {
    courseId: 'math', title: '第4次作业', instructions: '求极限', deadline: '2026-12-01T20:00:00+08:00',
    gradingPolicy: '', studentVisible: true,
  });
  const db = f.store.db;
  const submit = (actor: string, name: string, at: number, late: boolean) => {
    const event = f.engine.receive({ sourceKey: randomUUID(), externalId: randomUUID(), threadId: randomUUID(),
      courseId: 'math', actorId: actor, channel: { kind: 'qq-private', target: actor.split(':')[1] },
      receivedAt: at, text: '提交作业' }).event;
    db.prepare('INSERT INTO coursework_requests VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(), 'math', first.id, 'submission',
      'accepted', actor, name, event.id, JSON.stringify({ receivedAt: at, attempt: 1, late, effectiveDeadline: first.deadline, kind: 'submission' }));
  };
  db.prepare('INSERT INTO coursework_qq_students VALUES(?,?,?)').run('math', 'qq:1', '张三');
  db.prepare('INSERT INTO coursework_qq_students VALUES(?,?,?)').run('math', 'qq:2', '李四');
  submit('qq:1', '张三', Date.parse('2026-11-11T09:00:00+08:00'), true);
  submit('qq:2', '李四', Date.parse('2026-11-09T09:00:00+08:00'), false);
  db.prepare('INSERT INTO assignment_extensions VALUES(?,?,?,?,?)').run(second.id, '张三', '2026-12-05T20:00:00+08:00', '生病', 1);
  db.prepare('INSERT INTO offline_submissions VALUES(?,?,?)').run(first.id, '张三',
    JSON.stringify({ assignmentId: first.id, studentName: '张三', score: 88, registeredAt: '2026-11-12T10:00:00.000Z', revision: 1, actorId: 'web:admin' }));
  db.prepare('INSERT INTO offline_submissions VALUES(?,?,?)').run(first.id, '李四',
    JSON.stringify({ assignmentId: first.id, studentName: '李四', score: 92, registeredAt: '2026-11-12T10:00:00.000Z', revision: 1, actorId: 'web:admin' }));
  return { f, first, second };
}

test('学生只能看到本人提交、迟交、个人延期与分数', () => {
  const { f, first, second } = setup();
  const view = studentCoursework(f.engine, 'math', 'qq:1');
  assert.equal(view.verified, true);
  assert.equal(view.name, '张三');
  const firstView = view.assignments.find(item => item.id === first.id)!;
  assert.equal(firstView.submitted, true);
  assert.equal(firstView.attempts, 1);
  assert.equal(firstView.late, true);
  assert.equal(firstView.score, 88);
  const secondView = view.assignments.find(item => item.id === second.id)!;
  assert.equal(secondView.submitted, false);
  assert.equal(secondView.extension?.deadline, '2026-12-05T20:00:00+08:00');
  assert.equal(secondView.effectiveDeadline, '2026-12-05T20:00:00+08:00');

  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes('李四'));
  assert.ok(!view.assignments.some(item => item.score === 92));

  const other = studentCoursework(f.engine, 'math', 'qq:2');
  assert.equal(other.name, '李四');
  assert.equal(JSON.stringify(other).includes('张三'), false);
  f.store.close();
});

test('未核对的 QQ 只得到如何核对的说明', () => {
  const { f } = setup();
  const view = studentCoursework(f.engine, 'math', 'qq:9');
  assert.equal(view.verified, false);
  assert.equal(view.assignments.length, 0);
  assert.match(view.hint ?? '', /\/bind/);
  f.store.close();
});

test('教师用自然语言或 /bind 绑定 QQ 与姓名，重复绑定会被拒绝', async () => {
  const { f } = setup();
  f.store.db.prepare('DELETE FROM coursework_qq_students').run();
  const router = new Router(f.engine, { async complete(): Promise<string> { throw new Error('不应调用模型'); } });
  const teacher = (text: string) => f.engine.receive({ sourceKey: randomUUID(), externalId: randomUUID(), threadId: 'teacher-thread',
    courseId: 'math', actorId: 'qq:900', channel: { kind: 'qq-private', target: '900' }, receivedAt: Date.now(), text }).event;
  const first = teacher('/bind 12345 张三');
  await router.route(first, signal);
  assert.equal(studentCoursework(f.engine, 'math', 'qq:12345').verified, true);
  assert.match(f.store.deliveries().find(row => row.replyEventId === first.id)?.text ?? '', /已把 QQ 12345 绑定到「张三」/);

  const natural = teacher('把 QQ 67890 绑定到李四');
  await router.route(natural, signal);
  assert.equal(studentCoursework(f.engine, 'math', 'qq:67890').name, '李四');

  const conflict = teacher('/bind 13579 张三');
  await router.route(conflict, signal);
  assert.match(f.store.deliveries().find(row => row.replyEventId === conflict.id)?.text ?? '', /已绑定其他 QQ/);

  const unknown = teacher('/bind 24680 不在名单');
  await router.route(unknown, signal);
  assert.match(f.store.deliveries().find(row => row.replyEventId === unknown.id)?.text ?? '', /名单上的姓名/);
  f.store.close();
});

test('学生用自然语言申请延期，工具只创建待审批记录', async () => {
  const { f, first } = setup();
  const tools = new QATools(f.engine);
  const event = f.engine.receive({ sourceKey: randomUUID(), externalId: randomUUID(), threadId: randomUUID(),
    courseId: 'math', actorId: 'qq:1', channel: { kind: 'qq-private', target: '1' },
    receivedAt: Date.now(), text: '老师我生病了，第三次作业能延到12月5日晚上10点吗' }).event;
  const task = f.engine.createTask(event.id, 'qa', event.text);
  const run = f.engine.claim(task.id)!;
  const request = { assignmentId: first.id, deadline: '2026-12-05T22:00:00+08:00', reason: '生病' };
  const created = JSON.parse(await tools.call(run, 'request_extension', JSON.stringify(request), signal, false) as string);
  assert.equal(created.status, 'pending');
  const row = f.store.db.prepare('SELECT state, data FROM coursework_requests WHERE id=?').get(created.id) as { state: string; data: string };
  assert.equal(row.state, 'pending');
  assert.equal(JSON.parse(row.data).name, '张三');

  const again = JSON.parse(await tools.call(run, 'request_extension', JSON.stringify(request), signal, false) as string);
  assert.equal(again.id, created.id);
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM coursework_requests WHERE kind='extension'").get() as { n: number }).n, 1);

  const early = JSON.parse(await tools.call(run, 'request_extension', JSON.stringify({ ...request, deadline: '2026-11-01T22:00:00+08:00' }), signal, false) as string);
  assert.match(early.error, /晚于/);

  const groupEvent = f.engine.receive({ sourceKey: randomUUID(), externalId: randomUUID(), threadId: randomUUID(),
    courseId: 'math', actorId: 'qq:1', channel: { kind: 'qq-group', target: '100' }, receivedAt: Date.now(), text: '我想延期' }).event;
  const groupTask = f.engine.createTask(groupEvent.id, 'qa', groupEvent.text);
  const groupRun = f.engine.claim(groupTask.id)!;
  const blocked = JSON.parse(await tools.call(groupRun, 'request_extension', JSON.stringify(request), signal, false) as string);
  assert.match(blocked.error, /私聊/);
  f.store.close();
});

test('工具只在学生私聊返回本人数据，群聊与未核对身份都被拒绝', async () => {
  const { f } = setup();
  const tools = new QATools(f.engine);
  const privateEvent = f.engine.receive({ sourceKey: randomUUID(), externalId: randomUUID(), threadId: randomUUID(),
    courseId: 'math', actorId: 'qq:1', channel: { kind: 'qq-private', target: '1' }, receivedAt: Date.now(), text: '我作业交了吗' }).event;
  const privateTask = f.engine.createTask(privateEvent.id, 'qa', privateEvent.text);
  const privateRun = f.engine.claim(privateTask.id)!;
  const own = JSON.parse(await tools.call(privateRun, 'my_coursework', '{}', signal, false) as string);
  assert.equal(own.verified, true);
  assert.equal(own.name, '张三');
  assert.ok(!JSON.stringify(own).includes('李四'));

  const groupEvent = f.engine.receive({ sourceKey: randomUUID(), externalId: randomUUID(), threadId: randomUUID(),
    courseId: 'math', actorId: 'qq:1', channel: { kind: 'qq-group', target: '100' }, receivedAt: Date.now(), text: '我作业交了吗' }).event;
  const groupTask = f.engine.createTask(groupEvent.id, 'qa', groupEvent.text);
  const groupRun = f.engine.claim(groupTask.id)!;
  const blocked = JSON.parse(await tools.call(groupRun, 'my_coursework', '{}', signal, false) as string);
  assert.match(blocked.error, /私聊/);

  const unknownEvent = f.engine.receive({ sourceKey: randomUUID(), externalId: randomUUID(), threadId: randomUUID(),
    courseId: 'math', actorId: 'qq:9', channel: { kind: 'qq-private', target: '9' }, receivedAt: Date.now(), text: '我作业交了吗' }).event;
  const unknownTask = f.engine.createTask(unknownEvent.id, 'qa', unknownEvent.text);
  const unknownRun = f.engine.claim(unknownTask.id)!;
  const unverified = JSON.parse(await tools.call(unknownRun, 'my_coursework', '{}', signal, false) as string);
  assert.equal(unverified.verified, false);
  f.store.close();
});
