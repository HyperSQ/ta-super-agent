import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.ts';
import { WeeklyLesson, weeklySlot } from '../src/application/weekly-lesson.ts';
import { Router } from '../src/agents/router.ts';
import { Academics } from '../src/application/services/academics.ts';

const slot = Date.parse('2026-11-13T19:00:00+08:00');
const plan = { weekday: 5, time: '19:00', teacherQQ: '900', enabledAt: slot - 40_000 };
const noModel = { async complete() { throw Error('模型不应被调用'); } };

test('北京周五定时，资料不足询问一次，教师回复更新后恢复，重启不重复', async t => {
  const f = fixture();
  t.after(() => f.store.close());
  let now = slot - 1000;
  f.engine.now = () => now;
  f.store.saveCourse({ ...f.store.course('math')!, weeklyLesson: plan, progress: '旧进度', progressAt: slot - 8 * 86_400_000 });
  assert.equal(weeklySlot(now, plan), slot - 7 * 86_400_000);
  const weekly = new WeeklyLesson(f.engine, noModel);
  weekly.tick();
  assert.equal(f.store.deliveries().length, 0);
  now = slot + 20_000;
  weekly.tick();
  await weekly.idle();
  const delivery = f.store.deliveries()[0];
  assert.equal(delivery.channel.kind, 'qq-private');
  assert.equal(delivery.channel.target, '900');
  assert.equal(delivery.announcement, true);
  const { event } = f.engine.receive({ sourceKey: 'teacher-response', courseId: 'math', threadId: 'teacher-response', actorId: 'qq:900',
    channel: { kind: 'qq-private', target: '900' }, text: '本周讲到一致收敛', externalId: '123', receivedAt: now });
  const router = new Router(f.engine, noModel);
  await router.route(event, new AbortController().signal);
  assert.equal(f.store.course('math')?.progress, '一致收敛');
  assert.equal(f.store.course('math')?.progressSource, 'teacher');
  now += 20_000;
  weekly.tick();
  await weekly.idle();
  const request = f.store.pendingEvents().find(item => item.scheduled === 'weekly-lesson')!;
  await router.route(request, new AbortController().signal);
  const restart = new WeeklyLesson(f.engine, noModel);
  restart.tick();
  await restart.idle();
  assert.equal(f.store.tasks().filter(task => task.kind === 'lesson').length, 1);
  assert.equal(f.store.deliveries().filter(item => item.announcement).length, 1);
});

test('群消息与作业共同支持时推断进度，记录来源且直接进入备课', async t => {
  const f = fixture();
  t.after(() => f.store.close());
  f.engine.now = () => slot + 20_000;
  f.store.saveCourse({ ...f.store.course('math')!, weeklyLesson: plan });
  const { event } = f.engine.receive({ sourceKey: 'class', courseId: 'math', threadId: 'class', actorId: 'qq:1',
    channel: { kind: 'qq-group', target: '100' }, text: '今天课上讲了一致收敛', externalId: '321', receivedAt: slot - 1000 }, true);
  const assignment = new Academics(f.engine).saveAssignment('web:admin', { courseId: 'math', title: '一致收敛练习', instructions: '一致收敛的判别',
    deadline: '2026-11-20T12:00:00Z', gradingPolicy: '', studentVisible: true });
  f.store.db.prepare("UPDATE coursework_assignments SET data=json_set(data,'$.createdAt',?) WHERE id=?").run(new Date(slot - 1000).toISOString(), assignment.id);
  const weekly = new WeeklyLesson(f.engine, { async complete() {
    return JSON.stringify({ progress: '一致收敛', refs: ['Q:' + event.id, 'A:' + assignment.id] });
  } });
  weekly.tick(); await weekly.idle();
  assert.equal(f.store.course('math')?.progressSource, 'inferred');
  assert.deepEqual(f.store.course('math')?.progressEvidence, ['Q:' + event.id, 'A:' + assignment.id]);
  assert(f.store.pendingEvents().some(item => item.scheduled === 'weekly-lesson'));
  assert.equal(f.store.deliveries().length, 0);
});
