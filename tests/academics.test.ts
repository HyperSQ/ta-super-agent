import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.ts';
import { Academics } from '../src/application/services/academics.ts';

const create = (service: Academics) => service.saveAssignment('web:admin', { courseId: 'math', title: '第4次作业', instructions: '第2、4题', gradingPolicy: '按步骤评分', deadline: '2026-11-02T22:00:00+08:00' });
test('个别延期可修改和撤销，不能越过名单或覆盖新版本，全班截止时间不变', () => {
  const f = fixture(), service = new Academics(f.engine);
  try {
    const course = f.store.course('math')!;
    f.engine.updateCourse('web:admin', { ...course, roster: ['张三', '李四'] }, course.revision ?? 1);
    const assignment = create(service);
    const set = { deadline: '2026-11-05T22:00:00+08:00', reason: '请假', revision: 0, assignmentRevision: assignment.revision };
    assert.throws(() => service.extensions('qq:1', assignment.id), /仅教师/);
    assert.throws(() => service.setExtension('qq:1', assignment.id, '张三', set), /仅教师/);
    assert.throws(() => service.setExtension('web:admin', assignment.id, '外班学生', set), /不在/);
    assert.throws(() => service.setExtension('web:admin', assignment.id, '张三', { ...set, deadline: assignment.deadline }), /须晚于/);
    const saved = service.setExtension('web:admin', assignment.id, '张三', set);
    assert.equal(saved.deadline, assignment.deadline);
    assert.equal(saved.students[0].effectiveDeadline, '2026-11-05T14:00:00.000Z');
    assert.equal(saved.students[1].effectiveDeadline, assignment.deadline);
    assert.throws(() => service.setExtension('web:admin', assignment.id, '张三', set), /已修改/);
    const changed = service.saveAssignment('web:admin', { ...assignment, deadline: '2026-11-06T22:00:00+08:00' });
    assert.equal(service.extensions('web:admin', assignment.id).students[0].effectiveDeadline, changed.deadline);
    assert.throws(() => service.setExtension('web:admin', assignment.id, '张三', { ...set, revision: 1, deadline: null }), /已修改/);
    const revised = service.setExtension('web:admin', assignment.id, '张三', {
      ...set, revision: 1, assignmentRevision: changed.revision, deadline: '2026-11-07T22:00:00+08:00',
    });
    assert.equal(revised.students[0].effectiveDeadline, '2026-11-07T14:00:00.000Z');
    const revoked = service.setExtension('web:admin', assignment.id, '张三', { ...set, revision: 2, assignmentRevision: changed.revision, deadline: null });
    assert.equal(revoked.students[0].effectiveDeadline, changed.deadline);
    assert.equal(revoked.students[0].reason, '');
    assert.equal(revoked.students[0].revision, 3);
    assert.equal(f.store.deliveries().length, 0);
  } finally { f.store.close(); }
});
test('课程编辑有版本控制，旧执行不能提交，已完成答案不自动重发', () => {
  const f = fixture();
  try {
    const e = f.receive('问题'), task = f.engine.createTask(e.id, 'qa', e.text), run = f.engine.claim(task.id)!;
    const old = f.store.course('math')!;
    const updated = f.engine.updateCourse('web:admin', { ...old, progress: '第三章', roster: ['张三', '李四'], gradingPolicy: '按步骤给分' }, old.revision || 1);
    assert.equal(updated.revision, 2); assert.deepEqual(f.store.course('math')!.roster, ['张三', '李四']);
    assert.throws(() => f.engine.finish(run, '旧安排的答案'), /运行已失效/);
    assert.throws(() => f.engine.updateCourse('web:admin', old, 1), /课程已被修改/);
    f.engine.finish(f.engine.claim(task.id)!, '新答案');
    f.engine.updateCourse('web:admin', { ...updated, className: '一班' }, 2);
    assert.equal(f.store.task(task.id)!.status, 'completed');
    assert.equal(f.store.deliveries().filter(d => d.status === 'pending').length, 0);
  } finally { f.store.close(); }
});
test('线下批量登记逐人分数，支持零分、更正和撤销', () => {
  const f = fixture(), service = new Academics(f.engine);
  try {
    const a = create(service);
    service.register('web:admin', a.id, [{ name: '张三', revision: 0, score: 0 }, { name: '李四', revision: 0, score: 8.5 }]);
    assert.deepEqual(Object.fromEntries(service.offline(a.id).map(r => [r.studentName, r.score])), { 张三: 0, 李四: 8.5 });
    const updated = service.register('web:admin', a.id, [{ name: '张三', revision: 1, score: 9 }])[0];
    assert.equal(updated.score, 9); assert.equal(updated.revision, 2);
    service.remove('web:admin', a.id, '张三', 2);
    assert.deepEqual(service.offline(a.id).map(r => r.studentName), ['李四']);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE kind='offline.removed'").get()!.n, 1);
    assert.equal(f.store.deliveries().length, 0);
  } finally { f.store.close(); }
});
test('批量登记版本冲突完整回滚，不能覆盖另一个桌面端的登记', () => {
  const f = fixture(), service = new Academics(f.engine);
  try {
    const a = create(service);
    service.register('web:admin', a.id, [{ name: '李四', revision: 0, score: 8 }]);
    assert.throws(() => service.register('web:admin', a.id, [{ name: '张三', revision: 0, score: 9 }, { name: '李四', revision: 0, score: 9 }]), /登记已变化/);
    assert.equal(service.offline(a.id).length, 1);
    assert.throws(() => service.remove('web:admin', a.id, '李四', 99), /登记已变化/);
  } finally { f.store.close(); }
});
test('历史登记保持未评分，调整截止时间不改变分数或登记版本', () => {
  const f = fixture(), service = new Academics(f.engine);
  try {
    const a = create(service);
    const legacy = { assignmentId: a.id, studentName: '张三', registeredAt: '2026-11-03T11:00:00+08:00', submittedAt: '2026-11-03T10:00:00+08:00', late: true, notes: '旧登记', revision: 1, actorId: 'web:admin' };
    f.store.db.prepare('INSERT INTO offline_submissions VALUES (?,?,?)').run(a.id, '张三', JSON.stringify(legacy));
    assert.equal(service.offline(a.id)[0].score, undefined);
    assert.equal('late' in service.offline(a.id)[0], false);
    service.register('web:admin', a.id, [{ name: '张三', revision: 1, score: 9 }]);
    service.saveAssignment('web:admin', { ...a, deadline: '2026-11-04T22:00:00+08:00' });
    assert.equal(service.offline(a.id)[0].score, 9);
    assert.equal(service.offline(a.id)[0].revision, 2);
    assert.equal(JSON.parse(String(f.store.db.prepare('SELECT data FROM offline_submissions').get()!.data)).notes, '旧登记');
    assert.equal(f.store.pendingEvents().length, 0);
    assert.equal(f.store.deliveries().length, 0);
  } finally { f.store.close(); }
});
test('学生不能登记、更改作业或课程；拒绝非法分数', () => {
  const f = fixture(), service = new Academics(f.engine);
  try {
    const a = create(service);
    assert.throws(() => service.register('qq:1', a.id, [{ name: '张三', revision: 0, score: 8 }]), /仅教师/);
    assert.throws(() => service.saveAssignment('qq:1', { ...a, title: '篡改' }), /仅教师/);
    assert.throws(() => service.register('web:admin', a.id, [{ name: '张三', revision: 0, score: -1 }]), /非负数字/);
    assert.throws(() => f.engine.updateCourse('qq:1', f.store.course('math')!, 1), /只有教师/);
  } finally { f.store.close(); }
});
