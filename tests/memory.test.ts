import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { fixture, deferred } from './helpers.ts';
import type { Event, Run } from '../src/domain/model.ts';
import type { MemoryCard, MemoryJob } from '../src/domain/memory.ts';
import { MemoryService } from '../src/application/services/memory.ts';
import { MemoryUpdater, parseCandidates } from '../src/application/memory-updater.ts';
import { ContextBuilder } from '../src/agents/context-builder.ts';
import { createApi } from '../src/http/server.ts';

type Fixture = ReturnType<typeof fixture>;
function card(f: Fixture, event: Event, fields: Partial<MemoryCard> = {}): MemoryCard {
  const value: MemoryCard = {
    id: randomUUID(), courseId: event.courseId, subjectId: event.actor.id, revision: 1, status: 'active',
    kind: 'episode', observation: event.text, teaching: '', outcome: '尚未验证独立应用',
    topics: ['一致收敛'], anchors: [], evidenceType: 'student-report', channel: event.channel,
    sources: [{ eventId: event.id, threadRevision: f.store.assignment(event.id)!.revision, quote: event.text }],
    occurredAt: event.receivedAt, updatedAt: Date.now(), jobId: randomUUID(), ...fields,
  };
  f.engine.memory.save(value); return value;
}
function run(f: Fixture, text = '一致收敛和积分交换', actorId = 'qq:1'): Run {
  const e = f.receive(text, { actorId }), task = f.engine.createTask(e.id, 'qa', text);
  return f.engine.claim(task.id)!;
}
const signal = () => new AbortController().signal;
function extraction(event: Event, extra = {}) {
  return JSON.stringify({ memories: [{
    kind: 'episode', observation: '学生询问一致收敛的条件', outcome: '尚无独立运用证据',
    topics: ['一致收敛'], anchors: [], sources: [{ eventId: event.id, quote: event.text }], ...extra,
  }] });
}

test('答疑完成后持久提取；同一学生换thread能召回，正式成绩不写入记忆', async () => {
  const f = fixture();
  try {
    const first = run(f); f.engine.finish(first, '解释了相关定理的条件');
    const memory = new MemoryService(f.engine);
    const updater = new MemoryUpdater(f.engine, { complete: async () => extraction(first.history[0].event) }, memory);
    await updater.step();
    const cards = f.engine.memory.list('math');
    assert.equal(cards.length, 1); assert.equal(cards[0].evidenceType, 'student-report');
    assert.equal(cards[0].teaching, '解释了相关定理的条件');
    const next = run(f, '上次一致收敛的条件还有疑问');
    const context = await new ContextBuilder(memory).build(next, signal());
    assert.equal(context.studentMemory.hits[0].id, cards[0].id);
    assert.notEqual(next.history[0].event.threadId, first.history[0].event.threadId);
    assert.equal('grade' in cards[0], false);
    f.engine.finish(next, '继续解释');
    assert.equal(f.store.deliveries().length, 2);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM memory_jobs WHERE status='done'").get()!.n, 1);
  } finally { f.store.close(); }
});

test('同thread多人消息保留作者；跨学生、课程和私人渠道的记忆不进入公开答疑', async () => {
  const f = fixture();
  try {
    card(f, f.receive('一致收敛：甲的公开经历'));
    card(f, f.receive('一致收敛：乙的公开经历', { actorId: 'qq:2' }));
    const privateEvent = f.engine.receive({ sourceKey: randomUUID(), courseId: 'math', threadId: randomUUID(), actorId: 'qq:1', text: '一致收敛：甲的私聊记录', receivedAt: Date.now(), channel: { kind: 'qq-private', target: '1' }, externalId: randomUUID() }).event;
    card(f, privateEvent);
    f.engine.createCourse('web:admin', { id: 'other', title: '另一门课', groupId: '101', instructions: '' });
    const foreign = f.receive('一致收敛：其他课程', { courseId: 'other' }); card(f, foreign);
    const memory = new MemoryService(f.engine), builder = new ContextBuilder(memory);
    const a = run(f), b = run(f, '一致收敛', 'qq:2');
    const contexts = await Promise.all([builder.build(a, signal()), builder.build(b, signal())]);
    assert.deepEqual(contexts[0].studentMemory.hits.map(h => h.observation), ['一致收敛：甲的公开经历']);
    assert.deepEqual(contexts[1].studentMemory.hits.map(h => h.observation), ['一致收敛：乙的公开经历']);
  } finally { f.store.close(); }
});

test('批量提取不能把乙的回答认作甲的表现，也不能伪造来源或锚点', () => {
  const f = fixture();
  try {
    const first = f.receive('一致收敛是什么'), task = f.engine.createTask(first.id, 'qa', first.text);
    const other = f.receive('我明白了', { actorId: 'qq:2', threadId: first.threadId });
    const own = f.engine.claim(task.id)!;
    f.engine.finish(own, '説明');
    const row = f.store.db.prepare('SELECT data FROM memory_jobs LIMIT 1').get()!;
    const job = JSON.parse(String(row.data)) as MemoryJob;
    assert.throws(() => parseCandidates(extraction(other), job), /该学生/);
    assert.throws(() => parseCandidates(extraction(own.history[0].event, { sources: [{ eventId: own.history[0].event.id, quote: '不存在的原文' }] }), job), /实际原文/);
    assert.throws(() => parseCandidates(extraction(own.history[0].event, { anchors: ['invented:theorem'] }), job), /字段无效/);
    assert.throws(() => parseCandidates(extraction(own.history[0].event, { grade: 100 }), job), /字段无效/);
    assert.throws(() => parseCandidates(extraction(own.history[0].event, { kind: 'preference', preference: 'change-rubric' }), job), /偏好无效/);
  } finally { f.store.close(); }
});

test('有效解释偏好不依赖语义命中；新声明替代旧偏好', async () => {
  const f = fixture();
  try {
    card(f, f.receive('请先给例子'), { kind: 'preference', preference: 'examples-first', topics: [] });
    const r = run(f, '请分步骤讲解');
    f.engine.finish(r, '按步骤讲解');
    const memory = new MemoryService(f.engine), updater = new MemoryUpdater(f.engine, {
      complete: async () => extraction(r.history[0].event, { kind: 'preference', preference: 'steps-first', observation: '学生明确希望分步解释', topics: [] }),
    }, memory);
    await updater.step();
    const found = await memory.search(run(f, '一个完全不同的问题'), '不相干', [], signal());
    assert.equal(found.hits[0].card.preference, 'steps-first');
    assert.equal(f.engine.memory.list('math').filter(c => c.status === 'active').length, 1);
  } finally { f.store.close(); }
});

test('记忆的混合检索实际执行向量召回，精确锚点独立保留；配置变化不能混用旧向量', async () => {
  const f = fixture();
  try {
    const c = card(f, f.receive('旧问题'), { observation: '之前的讨论', topics: [], anchors: ['theorem:1'] });
    let calls = 0;
    const embedding = { fingerprint: 'encoder-config-v1', dimensions: 2, encode: async () => { calls++; return [1, 0]; } };
    f.engine.memory.saveVector(c, embedding.fingerprint, [1, 0]);
    const memory = new MemoryService(f.engine, embedding);
    const found = await memory.search(run(f), '没有词面重合', ['theorem:1'], signal());
    assert.equal(calls, 1); assert.equal(found.mode, 'hybrid');
    assert.deepEqual(found.hits[0].reasons, ['exact-anchor', 'vector']);
    const mismatch = new MemoryService(f.engine, { ...embedding, fingerprint: 'encoder-config-v2' });
    const fallback = await mismatch.search(run(f), '没有词面重合', [], signal());
    assert.equal(fallback.mode, 'keyword'); assert.equal(fallback.hits.length, 0);
    assert.match(fallback.warnings.join(), /尚未完成/);
  } finally { f.store.close(); }
});

test('向量服务失败时保留关键词路径，并如实报告降级', async () => {
  const f = fixture();
  try {
    card(f, f.receive('一致收敛的疑问'));
    const memory = new MemoryService(f.engine, { fingerprint: 'down', dimensions: 2, encode: async () => { throw new Error('离线'); } });
    const found = await memory.search(run(f), '一致收敛', [], signal());
    assert.equal(found.hits.length, 1); assert.equal(found.mode, 'keyword'); assert.match(found.warnings.join(), /降级/);
  } finally { f.store.close(); }
});

test('thread纠正撤销来源记忆，并拒绝运行中依赖旧记忆的结果', async () => {
  const f = fixture();
  try {
    const source = f.receive('一致收敛的疑问'), c = card(f, source);
    const r = run(f); await new ContextBuilder(new MemoryService(f.engine)).build(r, signal());
    assert.equal(r.memoryReads![0].id, c.id);
    const feedback = f.receive('这条分错了');
    f.engine.reclassify({ feedbackEventId: feedback.id, moves: [{ eventId: source.id, revision: 1 }], reason: '属于另一道题' });
    assert.equal(f.engine.memory.get(c.id)!.status, 'invalidated');
    let failure: unknown;
    try { f.engine.finish(r, '过期结论'); } catch (error) { failure = error; }
    assert.match((failure as Error).message, /记忆已修订/);
    f.engine.fail(r, failure);
    assert.equal(f.store.task(r.task.id)!.status, 'queued');
    assert.equal(f.store.deliveries().length, 0);
  } finally { f.store.close(); }
});

test('间接上下文来源被移动同样失效；异步提取不能提交旧归属结果', async () => {
  const f = fixture();
  try {
    const first = run(f), gate = deferred<string>();
    f.engine.finish(first, '解释');
    const updater = new MemoryUpdater(f.engine, { complete: () => gate.promise }, new MemoryService(f.engine));
    const working = updater.step();
    await Promise.resolve();
    const feedback = f.receive('换到正确线程');
    f.engine.reclassify({ feedbackEventId: feedback.id, moves: [{ eventId: first.history[0].event.id, revision: 1 }], reason: '原归属错误' });
    gate.resolve(extraction(first.history[0].event)); await working;
    assert.equal(f.engine.memory.list('math').length, 0);
    assert.equal(f.store.db.prepare('SELECT status FROM memory_jobs LIMIT 1').get()!.status, 'invalidated');
    const a = f.receive('一致收敛'), b = f.receive('另一人的补充', { actorId: 'qq:2' });
    const c = card(f, a, { dependencies: [{ eventId: a.id, threadRevision: 1 }, { eventId: b.id, threadRevision: 1 }] });
    const teacher = f.receive('更正上下文', { actorId: 'qq:900' });
    f.engine.reclassify({ feedbackEventId: teacher.id, moves: [{ eventId: b.id, revision: 1 }], reason: '补充属于其他题' });
    assert.equal(f.engine.memory.get(c.id)!.status, 'invalidated');
  } finally { f.store.close(); }
});

test('教师修订后，待发送的旧记忆答复不再交付；学生不能管理记忆', async () => {
  const f = fixture();
  try {
    const c = card(f, f.receive('一致收敛')), memory = new MemoryService(f.engine);
    const r = run(f); await new ContextBuilder(memory).build(r, signal()); f.engine.finish(r, '根据历史解释');
    assert.throws(() => memory.retire('qq:1', c.id, 1), /只有教师/);
    memory.revise('web:admin', c.id, 1, { observation: '教师纠正的观察', outcome: '需要重新验证', topics: ['一致收敛'] });
    assert.equal(f.engine.claimDelivery(f.store.deliveries()[0].id), undefined);
    assert.equal(f.store.deliveries()[0].status, 'withdrawn');
    assert.throws(() => memory.retire('web:admin', c.id, 1), /刷新/);
    const retired = memory.retire('web:admin', c.id, 2);
    assert.equal(retired.status, 'retired');
    assert.throws(() => memory.revise('web:admin', c.id, 3, { observation: '恢复', outcome: '', topics: [] }), /不能直接恢复/);
  } finally { f.store.close(); }
});

test('教材检索的知识点扩展记忆查询；记忆与检索原文保持在数据消息内', async () => {
  const f = fixture();
  try {
    card(f, f.receive('曾询问一致收敛的定义'));
    const builder = new ContextBuilder(new MemoryService(f.engine), { search: async books => {
        assert.deepEqual(books, []);
        return { hits: [], topics: ['一致收敛'], mode: 'keyword', warnings: [] };
      } });
    const r = run(f, '为什么这个操作成立');
    const context = await builder.build(r, signal());
    assert.equal(context.studentMemory.hits.length, 1); assert.equal(context.studentMemory.hits[0].subjectId, 'qq:1');
    assert.equal(r.task.grant.requester, 'qq:1');
  } finally { f.store.close(); }
});

test('记忆提取失败保留可重试状态，重启恢复中断任务，不重复创建卡片', async () => {
  const f = fixture();
  try {
    const r = run(f); f.engine.finish(r, '解释');
    f.engine.memory.claim(); f.engine.recover();
    assert.equal(f.store.db.prepare('SELECT status FROM memory_jobs').get()!.status, 'pending');
    const updater = new MemoryUpdater(f.engine, { complete: async () => 'invalid-json' }, new MemoryService(f.engine));
    await updater.step(); assert.equal(f.store.db.prepare('SELECT status FROM memory_jobs').get()!.status, 'failed');
    f.store.db.prepare("UPDATE memory_jobs SET status='pending'").run();
    const ok = new MemoryUpdater(f.engine, { complete: async () => extraction(r.history[0].event) }, new MemoryService(f.engine));
    await ok.step(); f.store.db.prepare("UPDATE memory_jobs SET status='pending'").run(); await ok.step();
    assert.equal(f.engine.memory.list('math').length, 1);
  } finally { f.store.close(); }
});

test('记忆管理API隔离QQ令牌、检查修订版本，并提供原文依据', async () => {
  const f = fixture(), tokens = { adminToken: 'admin-test-token-123456', webhookToken: 'webhook-test-token-123' };
  const c = card(f, f.receive('一致收敛的原始问题')), server = createApi(f.engine, tokens);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const call = (route: string, method = 'GET', body?: unknown, token = tokens.adminToken) => fetch(base + route, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    assert.equal((await call('/v1/courses/math/memories', 'GET', undefined, tokens.webhookToken)).status, 401);
    const detail = await (await call('/v1/memories/' + c.id)).json() as { sources: { event: Event }[] };
    assert.equal(detail.sources[0].event.text, '一致收敛的原始问题');
    assert.equal((await call('/v1/memories/' + c.id, 'PUT', { revision: 1, observation: '教师纠正', outcome: '', topics: [] })).status, 200);
    assert.equal((await call('/v1/memories/' + c.id + '/retire', 'POST', { revision: 1 })).status, 409);
    assert.equal((await call('/v1/memories/' + c.id + '/retire', 'POST', { revision: 2 })).status, 200);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); f.store.close(); }
});
