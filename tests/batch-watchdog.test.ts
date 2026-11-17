import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.ts';
import { Router } from '../src/agents/router.ts';
import { TaskRunner } from '../src/application/task-runner.ts';
import { Runtime } from '../src/application/runtime.ts';
import { DeliveryOutbox } from '../src/application/delivery-outbox.ts';
import { Watchdog, listAlerts } from '../src/application/watchdog.ts';
import { Store } from '../src/adapters/storage/sqlite.ts';
import { Policy } from '../src/security/policy.ts';
import { TaskEngine } from '../src/application/task-engine.ts';
import { courseReports } from '../src/application/task-reports.ts';
import { createApi } from '../src/http/server.ts';
import type { Delivery } from '../src/domain/model.ts';
import { randomUUID } from 'node:crypto';

const signal = new AbortController().signal;
const noModel = { async complete(): Promise<string> { throw new Error('不应调用模型'); } };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('routeBatch 把同线程两条消息合并成一个任务，重复调用不重复处理', async () => {
  const f = fixture();
  const first = f.receive('第3题怎么做', { threadId: 'T' });
  const second = f.receive('顺便问一下第5题', { threadId: 'T' });
  const router = new Router(f.engine, noModel);
  await router.routeBatch([first, second], signal);
  const tasks = f.store.tasks();
  assert.equal(tasks.length, 1);
  assert.deepEqual(f.store.inputs(tasks[0].id).map(input => input.event.id), [first.id, second.id]);
  assert.ok(f.store.routed(first.id) && f.store.routed(second.id));
  await router.routeBatch([first, second], signal);
  assert.equal(f.store.tasks().length, 1);
  f.store.close();
});

test('Runtime 合并窗口内的同线程消息，窗口结束前不建任务', async () => {
  const f = fixture();
  let clock = Date.now();
  const runner = new TaskRunner(f.engine, async () => '合并后的答复');
  const outbox = new DeliveryOutbox(f.engine, { send: async () => { throw new Error('不应外发'); } }, false);
  const runtime = new Runtime(f.engine, new Router(f.engine, noModel), runner, outbox, undefined, undefined,
    { batchMs: 1500, now: () => clock });
  const first = f.receive('第一句', { threadId: 'B' });
  const second = f.receive('第二句', { threadId: 'B' });
  runtime.tick();
  assert.equal(f.store.tasks().length, 0);
  clock += 1600;
  runtime.tick();
  await sleep(40);
  assert.equal(f.store.tasks().length, 1);
  const task = f.store.tasks()[0];
  assert.deepEqual(f.store.inputs(task.id).map(input => input.event.id), [first.id, second.id]);
  await runtime.stop();
  f.store.close();
});

test('规则型 Watchdog 报告停滞任务，冷却期内不重复，超时后刷新时间', () => {
  const f = fixture();
  let clock = Date.now();
  const watchdog = new Watchdog(f.engine, { now: () => clock, intervalMs: 0, stallMs: 60_000, cooldownMs: 300_000 });
  const event = f.receive('第3题怎么做');
  const task = f.engine.createTask(event.id, 'qa', event.text);
  f.engine.claim(task.id);
  assert.equal(watchdog.scan(clock).length, 0);
  clock += 120_000;
  const first = watchdog.scan(clock);
  assert.equal(first.length, 1);
  assert.equal(first[0].rule, 'stalled_task');
  assert.equal(first[0].targetId, task.id);
  const repeated = watchdog.scan(clock + 1_000);
  assert.equal(repeated.length, 1);
  assert.equal(listAlerts(f.store, 'math').length, 1);
  clock += 300_001;
  watchdog.scan(clock);
  const alerts = listAlerts(f.store, 'math');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].at, clock);
  f.store.close();
});

test('未知发送结果进入告警，不自动重发', () => {
  const f = fixture();
  const clock = Date.now();
  const watchdog = new Watchdog(f.engine, { now: () => clock + 120_000, intervalMs: 0, stallMs: 600_000, cooldownMs: 60_000 });
  const event = f.receive('答复');
  const task = f.engine.createTask(event.id, 'qa', event.text);
  const run = f.engine.claim(task.id)!;
  f.engine.finish(run, '答复正文');
  const delivery: Delivery = {
    id: randomUUID(), taskId: task.id, revision: 1, inputEpoch: task.inputEpoch, replyEventId: event.id,
    channel: { kind: 'qq-group', target: '100' }, text: '答复正文', status: 'unknown',
  };
  f.store.saveDelivery(delivery);
  const alerts = watchdog.scan(clock + 120_000);
  assert.ok(alerts.some(alert => alert.rule === 'unknown_delivery' && alert.targetId === delivery.id));
  assert.equal(f.store.delivery(delivery.id)?.status, 'unknown');
  f.store.close();
});

test('告警接口按课程返回，Webhook 令牌不能读取', async t => {
  const f = fixture();
  const clock = Date.now();
  const watchdog = new Watchdog(f.engine, { now: () => clock + 120_000, intervalMs: 0, stallMs: 60_000 });
  const event = f.receive('第3题怎么做');
  const task = f.engine.createTask(event.id, 'qa', event.text);
  f.engine.claim(task.id);
  watchdog.scan(clock + 120_000);
  const config = { adminToken: 'alerts-admin-token', webhookToken: 'alerts-webhook-token' };
  const server = createApi(f.engine, config);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); f.store.close(); });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/v1/courses/math/alerts`;
  const authorized = await fetch(url, { headers: { authorization: 'Bearer ' + config.adminToken } });
  assert.equal(authorized.status, 200);
  const body = await authorized.json() as { alerts: { rule: string; targetId: string }[] };
  assert.ok(body.alerts.some(alert => alert.rule === 'stalled_task' && alert.targetId === task.id));
  assert.equal((await fetch(url, { headers: { authorization: 'Bearer ' + config.webhookToken } })).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/v1/courses/nope/alerts`,
    { headers: { authorization: 'Bearer ' + config.adminToken } })).status, 404);
});

function engineWithClock() {
  const store = new Store(':memory:');
  let clock = 10_000;
  const engine = new TaskEngine(store, new Policy(['900']), () => clock);
  engine.createCourse('web:admin', { id: 'math', title: '数学分析', groupId: '100', instructions: '' });
  return { store, engine, tick: (ms: number) => { clock += ms; }, now: () => clock };
}

test('瞬态模型错误退避重试，次数用尽才 blocked，永久错误立即 blocked', () => {
  const { store, engine, tick } = engineWithClock();
  const event = engine.receive({ sourceKey: 'e1', externalId: 'e1', threadId: 'T', courseId: 'math',
    actorId: 'qq:1', channel: { kind: 'qq-group', target: '100' }, receivedAt: Date.now(), text: '第3题' }).event;
  const task = engine.createTask(event.id, 'qa', event.text);
  const first = engine.claim(task.id)!;
  engine.fail(first, new Error('模型请求失败：HTTP 503'));
  let stored = store.task(task.id)!;
  assert.equal(stored.status, 'queued');
  assert.equal(stored.attempts, 1);
  assert.ok((stored.retryAt ?? 0) > 10_000);
  assert.equal(engine.claim(task.id), undefined);

  tick(5_000);
  const second = engine.claim(task.id)!;
  engine.fail(second, new Error('模型请求失败：HTTP 503'));
  stored = store.task(task.id)!;
  assert.equal(stored.attempts, 2);

  tick(20_000);
  const third = engine.claim(task.id)!;
  assert.equal(store.task(task.id)?.attempts, 2);
  engine.fail(third, new Error('模型请求失败：HTTP 503'));
  stored = store.task(task.id)!;
  assert.equal(stored.status, 'blocked');
  assert.equal(courseReports(store, 'math').length, 1);
  assert.equal(courseReports(store, 'math')[0].outcome, 'blocked');

  const permanentEvent = engine.receive({ sourceKey: 'e2', externalId: 'e2', threadId: 'U', courseId: 'math',
    actorId: 'qq:1', channel: { kind: 'qq-group', target: '100' }, receivedAt: Date.now(), text: '第4题' }).event;
  const permanent = engine.createTask(permanentEvent.id, 'qa', permanentEvent.text);
  engine.fail(engine.claim(permanent.id)!, new Error('模型未返回可用内容'));
  assert.equal(store.task(permanent.id)?.status, 'blocked');
  assert.equal(store.task(permanent.id)?.attempts, undefined);
  store.close();
});

test('重试成功后清除退避状态', () => {
  const { store, engine, tick } = engineWithClock();
  const event = engine.receive({ sourceKey: 'ok1', externalId: 'ok1', threadId: 'T', courseId: 'math',
    actorId: 'qq:1', channel: { kind: 'qq-group', target: '100' }, receivedAt: Date.now(), text: '第3题' }).event;
  const task = engine.createTask(event.id, 'qa', event.text);
  engine.fail(engine.claim(task.id)!, new Error('模型请求失败：HTTP 502'));
  tick(5_000);
  const retry = engine.claim(task.id)!;
  assert.equal(store.task(task.id)?.attempts, 1);
  engine.finish(retry, '答复正文', { source: 'worker' });
  assert.equal(store.task(task.id)?.attempts, undefined);
  assert.equal(store.task(task.id)?.retryAt, undefined);
  store.close();
});
