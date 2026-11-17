import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createApi } from '../src/http/server.ts';
import { Academics } from '../src/application/services/academics.ts';
import { fixture } from './helpers.ts';

test('DSH 班级近况限定课程、时间和公开渠道，姓名与 QQ 分开查询', async t => {
  const f = fixture();
  const course = f.store.course('math')!;
  f.engine.updateCourse('web:admin', { ...course, roster: ['张三', '李四'], progress: '一致收敛' }, 1);
  f.engine.createCourse('web:admin', { id: 'other', title: '另一门课', groupId: '101', instructions: '' });
  const now = Date.now();
  f.engine.now = () => now;
  const visible = f.receive('我对一致收敛还有疑问');
  f.engine.now = () => Math.max(now, visible.receivedAt);
  const privateMessage = f.engine.receive({ sourceKey: randomUUID(), courseId: 'math', threadId: randomUUID(), actorId: 'qq:1',
    text: '私信不应出现', receivedAt: now, externalId: randomUUID(), channel: { kind: 'qq-private', target: '1' } }).event;
  f.receive('别班不应出现', { courseId: 'other' });
  f.engine.receive({ sourceKey: randomUUID(), courseId: 'math', threadId: randomUUID(), actorId: 'qq:1',
    text: '旧消息不应出现', receivedAt: now - 10 * 86_400_000, externalId: randomUUID(), channel: { kind: 'qq-group', target: '100' } });
  for (const event of [visible, privateMessage]) {
    f.engine.memory.save({ id: randomUUID(), courseId: 'math', subjectId: 'qq:1', revision: 1, status: 'active', kind: 'episode',
      observation: event.text, teaching: '', outcome: '', topics: ['一致收敛'], anchors: [], evidenceType: 'student-report', channel: event.channel,
      sources: [{ eventId: event.id, threadRevision: 1, quote: event.text }], occurredAt: now, updatedAt: now, jobId: randomUUID() });
  }
  const academics = new Academics(f.engine);
  const assignment = academics.saveAssignment('web:admin', { courseId: 'math', title: '本周作业', instructions: '', deadline: '2026-12-01T00:00:00Z', gradingPolicy: '' });
  academics.register('web:admin', assignment.id, [{ name: '张三', revision: 0, score: 0 }, { name: '李四', revision: 0, score: 91 }]);
  academics.setExtension('web:admin', assignment.id, '张三', { deadline: '2026-12-03T00:00:00Z', reason: '隐私备注', revision: 0, assignmentRevision: 1 });
  const token = 'test-class-teacher-token';
  const server = createApi(f.engine, { adminToken: token, webhookToken: 'test-class-webhook-token' }).listen(0, '127.0.0.1');
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); f.store.close(); });
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const path = 'http://127.0.0.1:' + address.port + '/v1/dsh/courses/math/class-context';
  const headers = { authorization: 'Bearer ' + token };
  assert.equal((await fetch(path)).status, 401);
  assert.equal((await fetch(path + '?days=31', { headers })).status, 400);
  const overview = await (await fetch(path, { headers })).json();
  assert.equal(overview.course.rosterSize, 2);
  assert.equal(overview.course.progress, '一致收敛');
  assert.equal(overview.group.messageCount, 1);
  assert.equal(overview.group.recentMessages[0].eventId, visible.id);
  assert.deepEqual(overview.group.learningNotes.map((note: { sourceEventIds: string[] }) => note.sourceEventIds), [[visible.id]]);
  assert.equal(overview.assignments[0].offline.rosterScored, 2);
  assert.equal(overview.assignments[0].student, undefined);
  const response = await fetch(path + '?qq=99&student=' + encodeURIComponent('张三'), { headers });
  const raw = await response.text();
  assert.doesNotMatch(raw, /私信不应出现|别班不应出现|隐私备注|李四/);
  const personal = JSON.parse(raw);
  assert.equal(personal.group.messageCount, 0);
  assert.equal(personal.assignments[0].student.score, 0);
  assert.equal(personal.assignments[0].student.effectiveDeadline, '2026-12-03T00:00:00.000Z');
});
