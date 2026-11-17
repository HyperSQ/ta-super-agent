import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, deferred } from './helpers.ts';
import { ThreadClassifier } from '../src/agents/thread-classifier.ts';
import { Router } from '../src/agents/router.ts';
import { Runtime } from '../src/application/runtime.ts';
import { TaskRunner } from '../src/application/task-runner.ts';
import { DeliveryOutbox } from '../src/application/delivery-outbox.ts';
import { setImmediate } from 'node:timers/promises';

test('误分追问移入目标线程，双侧旧结果失效，原始事件不变', () => {
  const f = fixture();
  try {
    const a = f.receive('题2'), b = f.receive('题3');
    const ta = f.engine.createTask(a.id, 'qa', a.text), tb = f.engine.createTask(b.id, 'qa', b.text);
    const wrong = f.receive('我问的是题3', { threadId: a.threadId });
    const runA = f.engine.claim(ta.id)!, runB = f.engine.claim(tb.id)!;
    const corrected = f.engine.reclassify({ feedbackEventId: wrong.id, moves: [{ eventId: wrong.id, revision: 1 }], targetEventId: b.id, targetRevision: 1, reason: '后续反馈表明引用错误' });
    assert.equal(corrected.threadId, b.threadId);
    assert.equal(f.store.originalEvent(wrong.id)!.threadId, a.threadId);
    assert.equal(f.store.event(wrong.id)!.threadId, b.threadId);
    assert.equal(f.store.assignment(wrong.id)!.revision, 2);
    assert.deepEqual(f.store.inputs(ta.id).map(i => i.event.text), ['题2']);
    assert.deepEqual(f.store.inputs(tb.id).map(i => i.event.text), ['题3', '我问的是题3']);
    assert.throws(() => f.engine.finish(runA, '旧A'), /运行已失效/);
    assert.throws(() => f.engine.finish(runB, '旧B'), /运行已失效/);
    assert.equal(f.store.threadForReply('qq-group:100', wrong.externalId), b.threadId);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM thread_changes').get()!.n, 1);
  } finally { f.store.close(); }
});

test('迁移清除污染的既有答案与检查点，撤销未发结果', () => {
  const f = fixture();
  try {
    const a = f.receive('题2'), ta = f.engine.createTask(a.id, 'qa', a.text);
    const wrong = f.receive('题3的内容', { threadId: a.threadId });
    const run = f.engine.claim(ta.id)!;
    f.engine.checkpoint(run, { mixed: true }); f.engine.finish(run, '混合回答');
    f.engine.reclassify({ feedbackEventId: wrong.id, moves: [{ eventId: wrong.id, revision: 1 }], reason: '应独立讨论' });
    const task = f.store.task(ta.id)!;
    assert.equal(task.result, undefined); assert.equal(task.checkpoint, undefined);
    assert.equal(task.status, 'queued');
    assert.equal(f.store.deliveries()[0].status, 'withdrawn');
  } finally { f.store.close(); }
});

test('移动根消息会替代旧任务，剩余讨论重建且不会沿用旧目标', async () => {
  const f = fixture();
  try {
    const a = f.receive('题2'), ta = f.engine.createTask(a.id, 'qa', a.text);
    const remaining = f.receive('其实我想问题3', { actorId: 'qq:2', threadId: a.threadId });
    const result = f.engine.reclassify({ feedbackEventId: a.id, moves: [{ eventId: a.id, revision: 1 }], reason: '根消息应拆出' });
    assert.notEqual(result.threadId, a.threadId);
    assert.equal(f.store.task(ta.id)!.status, 'superseded');
    const router = new Router(f.engine, { complete: async () => { throw new Error('无需模型'); } });
    for (const event of f.store.pendingEvents()) await router.route(event, new AbortController().signal);
    const active = f.store.tasks().filter(t => t.status === 'queued');
    assert.equal(active.length, 2);
    assert.ok(active.some(t => t.goal === remaining.text));
    assert.ok(active.some(t => t.goal === a.text));
    const correction = f.receive('恢复', { actorId: 'qq:900' });
    assert.throws(() => f.engine.control(correction.id, ta.id, 'resume', f.store.task(ta.id)!.revision), /不能恢复/);
  } finally { f.store.close(); }
});

test('拆出多条消息后只建立一个新任务，并保持原始接收顺序', async () => {
  const f = fixture();
  try {
    const a = f.receive('原线程'), t = f.engine.createTask(a.id, 'qa', a.text);
    const first = f.receive('新题目', { threadId: a.threadId });
    const second = f.receive('新题目的追问', { threadId: a.threadId });
    f.engine.reclassify({ feedbackEventId: second.id, moves: [{ eventId: second.id, revision: 1 }, { eventId: first.id, revision: 1 }], reason: '拆出独立问题' });
    const router = new Router(f.engine, { complete: async () => '' });
    for (const event of f.store.pendingEvents()) await router.route(event, new AbortController().signal);
    assert.equal(f.store.tasks().length, 2);
    const newer = f.store.tasks().find(task => task.id !== t.id)!;
    assert.deepEqual(f.store.inputs(newer.id).map(i => i.event.id), [first.id, second.id]);
    const run = f.engine.claim(newer.id)!;
    assert.equal(run.throughSeq, Math.max(...run.history.map(i => i.seq)));
  } finally { f.store.close(); }
});

test('学生只能移动自己的消息；批量越权全部回滚', () => {
  const f = fixture();
  try {
    const a = f.receive('自己的'), other = f.receive('他人的', { actorId: 'qq:2' });
    assert.throws(() => f.engine.reclassify({ feedbackEventId: a.id, moves: [{ eventId: a.id, revision: 1 }, { eventId: other.id, revision: 1 }], reason: '冒充老师纠正他人' }), /只能调整自己的/);
    assert.equal(f.store.assignment(a.id)!.revision, 1);
    assert.equal(f.store.assignment(other.id)!.revision, 1);
  } finally { f.store.close(); }
});

test('同名或伪造目标不能越过课程和渠道；归属版本防止并发覆盖', () => {
  const f = fixture();
  try {
    const a = f.receive('A'), b = f.receive('B');
    f.engine.reclassify({ feedbackEventId: a.id, moves: [{ eventId: a.id, revision: 1 }], reason: '第一次纠正' });
    assert.throws(() => f.engine.reclassify({ feedbackEventId: a.id, moves: [{ eventId: a.id, revision: 1 }], targetEventId: b.id, targetRevision: 1, reason: '旧建议' }), /归属已更新/);
    f.engine.createCourse('web:admin', { id: 'other', title: '另一课程', groupId: '101', instructions: '' });
    const cross = f.receive('另一课程', { courseId: 'other' });
    assert.throws(() => f.engine.reclassify({ feedbackEventId: a.id, moves: [{ eventId: a.id, revision: 2 }], targetEventId: cross.id, targetRevision: 1, reason: '跨课' }), /目标线程/);
    const privateEvent = f.engine.receive({ sourceKey: randomUUID(), courseId: 'math', threadId: randomUUID(), actorId: 'qq:1', text: '私聊', channel: { kind: 'qq-private', target: '1' }, externalId: 'private-1', receivedAt: Date.now() }).event;
    assert.throws(() => f.engine.reclassify({ feedbackEventId: a.id, moves: [{ eventId: a.id, revision: 2 }], targetEventId: privateEvent.id, targetRevision: 1, reason: '跨渠道' }), /目标线程/);
  } finally { f.store.close(); }
});

test('分类器不能重建讲义任务，暂停答疑仍保持暂停', () => {
  const f = fixture();
  try {
    const lesson = f.receive('讲义', { actorId: 'qq:900' });
    const tl = f.engine.createTask(lesson.id, 'lesson', lesson.text);
    f.receive('学生的补充', { threadId: lesson.threadId });
    assert.deepEqual(f.store.inputs(tl.id).map(input => input.event.id), [lesson.id]);
    assert.throws(() => f.engine.reclassify({ feedbackEventId: lesson.id, moves: [{ eventId: lesson.id, revision: 1 }], reason: '试图影响讲义' }), /只能重建答疑/);
    assert.equal(f.store.task(tl.id)!.revision, 1);
    const a = f.receive('题2'), ta = f.engine.createTask(a.id, 'qa', a.text);
    const cmd = f.receive('暂停', { actorId: 'qq:900' }); f.engine.control(cmd.id, ta.id, 'pause', 1);
    const b = f.receive('另一个题目');
    f.engine.reclassify({ feedbackEventId: b.id, moves: [{ eventId: b.id, revision: 1 }], targetEventId: a.id, targetRevision: 1, reason: '归到题2' });
    assert.equal(f.store.task(ta.id)!.status, 'paused');
  } finally { f.store.close(); }
});

test('已发答复不抹除；发送中的回执不会因消息迁移而错误跳到新线程', () => {
  const f = fixture();
  try {
    const a = f.receive('题2'), ta = f.engine.createTask(a.id, 'qa', a.text);
    f.engine.finish(f.engine.claim(ta.id)!, '已经开始发送的旧答复');
    const delivery = f.store.deliveries()[0]; f.engine.claimDelivery(delivery.id);
    const result = f.engine.reclassify({ feedbackEventId: a.id, moves: [{ eventId: a.id, revision: 1 }], reason: '根消息误分' });
    f.engine.settleDelivery(delivery.id, { externalId: 'answer-old' });
    assert.equal(f.store.delivery(delivery.id)!.status, 'sent');
    assert.equal(f.store.delivery(delivery.id)!.text, '已经开始发送的旧答复');
    assert.equal(f.store.threadForReply('qq-group:100', 'answer-old'), a.threadId);
    assert.equal(f.store.threadForReply('qq-group:100', a.externalId), result.threadId);
  } finally { f.store.close(); }
});

test('后续反馈触发模型纠错，引用归属可被覆盖且不改变作者', async () => {
  const f = fixture();
  try {
    f.engine.reviewFeedback = true;
    const a = f.receive('题2'), b = f.receive('题3');
    const ta = f.engine.createTask(a.id, 'qa', a.text), tb = f.engine.createTask(b.id, 'qa', b.text);
    const feedback = f.receive('串台了，我问的是题3', { threadId: a.threadId });
    assert.equal(f.store.pendingReviews()[0].id, feedback.id);
    assert.equal(f.store.inputs(ta.id).length, 1);
    const classifier = new ThreadClassifier(f.engine, { complete: async () => JSON.stringify({ action: 'move', eventIds: [feedback.id], targetEventId: b.id, reason: '学生明确指出题3' }) });
    await classifier.reconsider(feedback.id, new AbortController().signal);
    assert.equal(f.store.event(feedback.id)!.actor.id, 'qq:1');
    assert.equal(f.store.event(feedback.id)!.threadId, b.threadId);
    assert.equal(f.store.inputs(tb.id).length, 2);
    assert.equal(f.store.pendingReviews().length, 0);
  } finally { f.store.close(); }
});

test('分类期间另一纠正已提交时，迟到模型建议不能覆盖', async () => {
  const f = fixture(), gate = deferred<string>();
  try {
    const a = f.receive('A'), b = f.receive('B');
    const classifier = new ThreadClassifier(f.engine, { complete: async () => gate.promise });
    const job = classifier.reconsider(a.id, new AbortController().signal);
    f.engine.reclassify({ feedbackEventId: a.id, moves: [{ eventId: a.id, revision: 1 }], reason: '较新纠正' });
    gate.resolve(JSON.stringify({ action: 'move', eventIds: [a.id], targetEventId: b.id, reason: '旧模型建议' }));
    await assert.rejects(job, /分类期间线程已更新/);
    assert.notEqual(f.store.event(a.id)!.threadId, b.threadId);
  } finally { gate.resolve('{"action":"keep"}'); f.store.close(); }
});

test('运行循环自动复核反馈、迁移并按新上下文继续执行', async () => {
  const f = fixture();
  let runtime: Runtime | undefined;
  try {
    f.engine.reviewFeedback = true;
    const a = f.receive('题2'), b = f.receive('题3');
    const ta = f.engine.createTask(a.id, 'qa', a.text), tb = f.engine.createTask(b.id, 'qa', b.text);
    const feedback = f.receive('串台了，我问的是题3', { threadId: a.threadId });
    const model = { complete: async () => JSON.stringify({ action: 'move', eventIds: [feedback.id], targetEventId: b.id, reason: '后续反馈明确题3' }) };
    const runner = new TaskRunner(f.engine, async ({ run }) => run.history.map(i => i.event.text).join('|'));
    runtime = new Runtime(f.engine, new Router(f.engine, model), runner, new DeliveryOutbox(f.engine, { send: async () => { throw new Error('不应外发'); } }), new ThreadClassifier(f.engine, model));
    for (let i = 0; i < 4; i++) { runtime.tick(); await setImmediate(); }
    await runner.idle();
    assert.equal(f.store.task(ta.id)!.result, '题2');
    assert.equal(f.store.task(tb.id)!.result, '题3|串台了，我问的是题3');
    assert.equal(f.store.pendingReviews().length, 0);
  } finally { await runtime?.stop(); f.store.close(); }
});
