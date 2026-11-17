import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.ts';
import { courseInbox } from '../src/application/services/inbox.ts';
import type { InboxKind } from '../src/application/services/inbox.ts';
import { buildProposals } from '../src/application/services/proposals.ts';
import { Academics } from '../src/application/services/academics.ts';
import { createApi } from '../src/http/server.ts';

const now = Date.now();

function setup() {
  const f = fixture();
  const teacher = f.engine.receive({ sourceKey: randomUUID(), externalId: randomUUID(), threadId: 'teacher-thread',
    courseId: 'math', actorId: 'qq:900', channel: { kind: 'qq-private', target: '900' }, receivedAt: now - 1000, text: '新建作业「第5次作业」' }).event;
  const student = f.engine.receive({ sourceKey: randomUUID(), externalId: randomUUID(), threadId: 'student-thread',
    courseId: 'math', actorId: 'qq:1', channel: { kind: 'qq-private', target: '1' }, receivedAt: now - 2000, text: '提交第4次作业' }).event;
  const assignment = new Academics(f.engine).saveAssignment('web:admin', {
    courseId: 'math', title: '第4次作业', instructions: '证明一致收敛', deadline: '2026-11-20T20:00:00+08:00', gradingPolicy: '',
  });
  const expiredEvent = f.engine.receive({ sourceKey: randomUUID(), externalId: randomUUID(), threadId: 'teacher-thread',
    courseId: 'math', actorId: 'qq:900', channel: { kind: 'qq-private', target: '900' }, receivedAt: now - 500_000, text: '旧草稿' }).event;
  const db = f.store.db;
  // 1. 待确认草稿（含确认码，不应外泄）；一条已过期。
  db.prepare('INSERT INTO teacher_work_drafts VALUES(?,?,?,?,?,?,?)').run('ABCD1234', teacher.id, 'math', 'qq:900',
    now + 10 * 60_000, 'pending', JSON.stringify({ courseRevision: 1, change: { action: 'create', fields: { title: '第5次作业' } } }));
  db.prepare('INSERT INTO teacher_work_drafts VALUES(?,?,?,?,?,?,?)').run('EXPIRED1', expiredEvent.id, 'math', 'qq:900',
    now - 60_000, 'pending', JSON.stringify({ courseRevision: 1, change: { action: 'create', fields: { title: '过期草稿' } } }));
  // 2. 提交与延期。
  db.prepare('INSERT INTO coursework_requests VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(), 'math', assignment.id, 'submission',
    'pending', 'qq:1', '张予安', student.id, '{}');
  // 3. 名单变更（含确认码）。
  db.prepare('INSERT INTO roster_approvals VALUES(?,?,?,?,?)').run('ROSTERCODE1', 'math', 'qq:900', now + 5 * 60_000,
    JSON.stringify({ revision: 1, names: ['张予安'] }));
  // 4. 邮件：一封待核对、一封已忽略，正文不得外泄。
  db.prepare('INSERT INTO course_mail_messages VALUES(?,?,?,?,?)').run(randomUUID(), 'math', 'mail-1', now - 3000,
    JSON.stringify({ state: 'pending', subject: '第4次作业', text: '正文机密', from: 'student@example.com' }));
  db.prepare('INSERT INTO course_mail_messages VALUES(?,?,?,?,?)').run(randomUUID(), 'math', 'mail-2', now - 4000,
    JSON.stringify({ state: 'ignored', subject: '已忽略', text: '正文机密' }));
  // 5. 记忆任务：一条失败、一条正常。
  db.prepare('INSERT INTO memory_jobs VALUES(?,?,?,?,?)').run('job-failed', 'failed', 1, JSON.stringify({ courseId: 'math' }), '模型超时');
  db.prepare('INSERT INTO memory_jobs VALUES(?,?,?,?,?)').run('job-pending', 'pending', 0, JSON.stringify({ courseId: 'math' }), null);
  // 6. 等待教师的任务与告警。
  const waiting = f.engine.createTask(f.receive('第3题怎么做').id, 'qa', '第3题怎么做');
  const stored = f.store.task(waiting.id)!;
  stored.status = 'waiting_teacher'; stored.updatedAt = now - 5000;
  f.store.saveTask(stored);
  db.prepare('INSERT INTO alerts VALUES(?,?,?,?,?,?,?)').run('alert-1', 'math', 'stalled_task', waiting.id, 'warning', '任务运行超过 3 分钟没有新进展', now - 10_000);
  return { f, assignment, teacher, student, waiting };
}

test('收件箱聚合七类待办，隐藏确认码与邮件正文，过期和已忽略项不出现', () => {
  const { f, waiting } = setup();
  const inbox = courseInbox(f.engine, 'math', { now, limit: 50 });
  const kinds = new Set(inbox.items.map(item => item.kind));
  for (const kind of ['teacher_draft', 'coursework', 'roster', 'mail', 'memory_job', 'task', 'alert'] as InboxKind[])
    assert.ok(kinds.has(kind), kind);
  assert.equal(inbox.counts.total, 7);
  assert.equal(inbox.counts.teacher_draft, 1);
  assert.equal(inbox.counts.coursework, 1);
  assert.equal(inbox.counts.roster, 1);
  assert.equal(inbox.counts.mail, 1);
  assert.equal(inbox.counts.memory_job, 1);
  assert.equal(inbox.counts.task, 1);
  assert.equal(inbox.counts.alert, 1);
  assert.ok(inbox.items.some(item => item.kind === 'task' && item.id === waiting.id));

  const serialized = JSON.stringify(inbox);
  assert.ok(!serialized.includes('ABCD1234'));
  assert.ok(!serialized.includes('EXPIRED1'));
  assert.ok(!serialized.includes('ROSTERCODE1'));
  assert.ok(!serialized.includes('正文机密'));
  assert.ok(!serialized.includes('student@example.com'));

  // 时间倒序：最新的是草稿（receivedAt 最早但 createdAt 用事件时间，-1s 大于提交 -2s）。
  assert.equal(inbox.items[0].kind, 'teacher_draft');
  f.store.close();
});

test('返回条数受限时 counts 仍统计全部，并按课程隔离', () => {
  const { f } = setup();
  f.engine.createCourse('web:admin', { id: 'other', title: '其他课程', groupId: '200', instructions: '' });
  f.store.db.prepare('INSERT INTO roster_approvals VALUES(?,?,?,?,?)').run('OTHERCODE', 'other', 'qq:900', now + 60_000,
    JSON.stringify({ revision: 1, names: ['李四'] }));
  const page = courseInbox(f.engine, 'math', { now, limit: 3 });
  assert.equal(page.items.length, 3);
  assert.equal(page.counts.total, 7);
  const other = courseInbox(f.engine, 'other', { now });
  assert.equal(other.counts.total, 1);
  assert.equal(other.items[0].kind, 'roster');
  assert.ok(!JSON.stringify(other).includes('张予安'));
  f.store.close();
});

test('建议只给候选与理由，不创建任务、不发消息', () => {
  const { f } = setup();
  const before = { tasks: f.store.tasks().length, deliveries: f.store.deliveries().length };
  const proposals = buildProposals(f.engine, 'math', { now });
  const rules = new Set(proposals.map(item => item.rule));
  assert.ok(rules.has('coursework_backlog'));
  assert.ok(rules.has('mail_backlog'));
  assert.ok(rules.has('memory_failures'));
  assert.ok(proposals.every(item => item.reason && item.count > 0));
  assert.equal(f.store.tasks().length, before.tasks);
  assert.equal(f.store.deliveries().length, before.deliveries);

  const running = f.engine.createTask(f.receive('第5题怎么做').id, 'qa', '第5题怎么做');
  f.engine.claim(running.id);
  const stale = buildProposals(f.engine, 'math', { now: now + 600_000, stallMs: 60_000 });
  assert.ok(stale.some(item => item.rule === 'stalled_task' && item.entry === 'tasks'));

  f.engine.createCourse('web:admin', { id: 'clean', title: '干净课程', groupId: '300', instructions: '' });
  assert.deepEqual(buildProposals(f.engine, 'clean', { now: now + 600_000 }), []);
  f.store.close();
});

test('收件箱接口需要管理令牌，课程必填', async t => {
  const { f } = setup();
  const config = { adminToken: 'inbox-admin-token', webhookToken: 'inbox-webhook-token' };
  const server = createApi(f.engine, config);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); f.store.close(); });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const url = (path: string) => `http://127.0.0.1:${address.port}${path}`;
  const read = await fetch(url('/v1/courses/math/inbox'), { headers: { authorization: 'Bearer ' + config.adminToken } });
  assert.equal(read.status, 200);
  const body = await read.json() as { items: unknown[]; counts: { total: number }; proposals: { rule: string }[] };
  assert.equal(body.counts.total, 7);
  assert.ok(body.proposals.some(item => item.rule === 'mail_backlog'));
  assert.ok(!JSON.stringify(body).includes('ABCD1234'));
  assert.equal((await fetch(url('/v1/courses/math/inbox'), { headers: { authorization: 'Bearer ' + config.webhookToken } })).status, 401);
  assert.equal((await fetch(url('/v1/courses/nope/inbox'), { headers: { authorization: 'Bearer ' + config.adminToken } })).status, 404);
});
