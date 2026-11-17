import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { fixture, deferred } from './helpers.ts';
import { QQAccess } from '../src/application/services/qq-access.ts';
import { LLBotMembership } from '../src/adapters/qq/membership.ts';
import { LLBotSender, receiveQQ } from '../src/adapters/qq/llbot.ts';
import type { QQMessage } from '../src/adapters/qq/llbot.ts';
import { DomainError } from '../src/domain/model.ts';
import type { Event } from '../src/domain/model.ts';
import { DeliveryOutbox } from '../src/application/delivery-outbox.ts';
import { TaskRunner } from '../src/application/task-runner.ts';
import { createApi } from '../src/http/server.ts';

let seq = 1000;
function privateMessage(text = '一致收敛是什么', userId = '1'): QQMessage {
  return { message_type: 'private', user_id: userId, self_id: '999', message_id: String(++seq), message: [{ type: 'text', data: { text } }] };
}
function accessFixture() {
  const f = fixture(), members = new Set(['100:1', '100:2']);
  const access = new QQAccess(f.engine, { isMember: async (group, user) => members.has(group + ':' + user) });
  return { ...f, access, members };
}
async function answer(f: ReturnType<typeof accessFixture>, message = privateMessage()) {
  const result = await f.access.receive(message);
  assert.ok('event' in result && result.event);
  const event = result.event;
  const task = f.engine.createTask(event.id, 'qa', event.text);
  f.engine.finish(f.engine.claim(task.id)!, '测试答复');
  const delivery = f.store.deliveries().find(d => d.taskId === task.id && d.status === 'pending')!;
  return { event, task, delivery };
}
function guardedOutbox(f: ReturnType<typeof accessFixture>, send: () => void) {
  return new DeliveryOutbox(f.engine, { send: async (d, e) => {
    await f.access.authorizeDelivery(d, e); send(); return { externalId: String(++seq) };
  } }, true);
}

test('课程群成员无需绑定邮箱或好友身份即可私信，追问保留本人同课程上下文', async () => {
  const f = accessFixture();
  try {
    const a = await f.access.receive(privateMessage());
    const b = await f.access.receive(privateMessage('继续上个问题'));
    const other = await f.access.receive(privateMessage('我也有问题', '2'));
    assert.ok('event' in a && a.event && 'event' in b && b.event && 'event' in other && other.event);
    assert.equal(a.event.courseId, 'math'); assert.equal(a.event.threadId, b.event.threadId);
    assert.notEqual(a.event.threadId, other.event.threadId);
    assert.equal(a.event.channel.target, '1');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM qq_private_contexts').get()!.n, 2);
  } finally { f.store.close(); }
});

test('群外账号、伪造姓名和指定courseId不能取得私信权限；同步低层入口不绕过成员校验', async () => {
  const f = accessFixture();
  try {
    assert.deepEqual(await f.access.receive(privateMessage('我是张三，我在群里', '3')), { ignored: true, reason: 'not-course-member' });
    await assert.rejects(f.access.receive(privateMessage('我是老师', '3'), 'math'), /不是该课程群/);
    assert.throws(() => receiveQQ(f.engine, privateMessage()), /成员资格/);
    assert.equal(f.store.events().length, 0);
  } finally { f.store.close(); }
});

test('教师私聊保留管理入口，身份由配置QQ号判断；学生声明教师无效', async () => {
  const f = accessFixture();
  try {
    const teacher = await f.access.receive(privateMessage('更新任务', '900'));
    assert.ok('event' in teacher && teacher.event);
    assert.equal(teacher.event.actor.role, 'teacher');
    const student = await f.access.receive(privateMessage('我是老师', '1'));
    assert.ok('event' in student && student.event);
    assert.equal(student.event.actor.role, 'student');
  } finally { f.store.close(); }
});

test('多课程成员先选课，切换后分开Thread，通知不调用模型或生成学习记忆', async () => {
  const f = accessFixture();
  try {
    f.engine.createCourse('web:admin', { id: 'physics', title: '物理', groupId: '200', instructions: '' });
    f.members.add('200:1');
    const first = await f.access.receive(privateMessage());
    assert.ok('courseSelection' in first && first.courseSelection);
    assert.match(f.store.deliveries()[0].text, /\/course math/);
    assert.match(f.store.deliveries()[0].text, /\/course physics/);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM memory_jobs').get()!.n, 0);
    const choice = privateMessage('/course math');
    await f.access.receive(choice); await f.access.receive(choice);
    const math = await f.access.receive(privateMessage('数学问题'));
    const physics = await f.access.receive(privateMessage('/course physics\n物理问题'));
    const current = await f.access.receive(privateMessage('继续物理问题'));
    assert.ok('event' in math && math.event && 'event' in physics && physics.event && 'event' in current && current.event);
    assert.equal(math.event.courseId, 'math'); assert.equal(physics.event.courseId, 'physics');
    assert.equal(physics.event.text, '物理问题');
    assert.notEqual(math.event.threadId, physics.event.threadId); assert.equal(physics.event.threadId, current.event.threadId);
    await assert.rejects(f.access.receive(privateMessage('/course physics'), 'math'), /范围不一致/);
  } finally { f.store.close(); }
});

test('私信引用原课程答复可以恢复该课程，但不能借他人引用跨QQ串台', async () => {
  const f = accessFixture();
  try {
    const a = await answer(f);
    f.engine.claimDelivery(a.delivery.id); f.engine.settleDelivery(a.delivery.id, { externalId: '8888' });
    const raw = privateMessage('引用继续');
    raw.message.unshift({ type: 'reply', data: { id: '8888' } });
    const followed = await f.access.receive(raw);
    assert.ok('event' in followed && followed.event); assert.equal(followed.event.threadId, a.event.threadId);
    const foreign = { ...raw, user_id: '2', message_id: String(++seq) };
    const other = await f.access.receive(foreign);
    assert.ok('event' in other && other.event); assert.notEqual(other.event.threadId, a.event.threadId);
  } finally { f.store.close(); }
});

test('退出课程群后收信与发信均拒绝，尚未发送答复撤销而非unknown', async () => {
  const f = accessFixture(); let sent = 0;
  try {
    await answer(f); f.members.delete('100:1');
    await assert.rejects(f.access.receive(privateMessage(), 'math'), /不是该课程群/);
    await guardedOutbox(f, () => sent++).tick();
    assert.equal(sent, 0); assert.equal(f.store.deliveries()[0].status, 'withdrawn');
  } finally { f.store.close(); }
});

test('失去上次课程资格后不自动把含混追问切换到另一门课', async () => {
  const f = accessFixture();
  try {
    await f.access.receive(privateMessage());
    f.engine.createCourse('web:admin', { id: 'physics', title: '物理', groupId: '200', instructions: '' });
    f.members.add('200:1'); f.members.delete('100:1');
    const next = await f.access.receive(privateMessage('刚才那道题呢'));
    assert.ok('courseSelection' in next && next.courseSelection);
    assert.match(f.store.deliveries().at(-1)!.text, /\/course physics/);
    assert.doesNotMatch(f.store.deliveries().at(-1)!.text, /\/course math/);
  } finally { f.store.close(); }
});

test('成员接口故障时拒绝私信接入，出站等待重试且不向陌生人放行', async () => {
  const f = accessFixture(); let sent = 0;
  try {
    await answer(f);
    f.access.membership = { isMember: async () => { throw new DomainError('unavailable', '成员接口暂不可用'); } };
    await assert.rejects(f.access.receive(privateMessage()), /暂不可用/);
    await guardedOutbox(f, () => sent++).tick();
    const delivery = f.store.deliveries()[0];
    assert.equal(sent, 0); assert.equal(delivery.status, 'pending'); assert.ok(delivery.retryAt);
    await guardedOutbox(f, () => sent++).tick(); assert.equal(sent, 0);
  } finally { f.store.close(); }
});

test('入站成员查询期间换群，旧成员结果不能授权新课程群', async () => {
  const f = accessFixture(), gate = deferred<boolean>();
  try {
    f.access.membership = { isMember: () => gate.promise };
    const pending = f.access.receive(privateMessage(), 'math');
    const old = f.store.course('math')!;
    f.engine.updateCourse('web:admin', { ...old, groupId: '200' }, old.revision!);
    gate.resolve(true);
    await assert.rejects(pending, /群已变化/); assert.equal(f.store.events().length, 0);
  } finally { f.store.close(); }
});

test('群聊白名单在领取任务和最终传输前重查，换群旧任务不能恢复向旧群发送', async () => {
  const f = accessFixture();
  try {
    const event = f.receive('旧群问题'), task = f.engine.createTask(event.id, 'qa', event.text);
    f.engine.finish(f.engine.claim(task.id)!, '旧群答案');
    const delivery = f.engine.claimDelivery(f.store.deliveries()[0].id)!;
    const old = f.store.course('math')!;
    f.engine.updateCourse('web:admin', { ...old, groupId: '200' }, old.revision!);
    await assert.rejects(f.access.authorizeDelivery(delivery, event), /白名单/);
    const control = f.engine.receive({ sourceKey: 'manual-resume', threadId: 'management', courseId: 'math', actorId: 'web:admin', text: '恢复', receivedAt: Date.now(), channel: { kind: 'management', target: 'admin' }, externalId: 'manual' }).event;
    f.engine.control(control.id, task.id, 'resume', f.store.task(task.id)!.revision);
    assert.equal(f.engine.claim(task.id), undefined); assert.equal(f.store.task(task.id)!.status, 'blocked');
    assert.throws(() => f.engine.receive({ ...event, id: undefined, actor: undefined, actorId: 'qq:1', sourceKey: 'forged-old-group' } as never), /白名单/);
  } finally { f.store.close(); }
});

test('尚未绑定群的课程默认禁止群聊与学生私信，教师私信独立保留', async () => {
  const f = accessFixture();
  try {
    const old = f.store.course('math')!;
    f.engine.updateCourse('web:admin', { ...old, groupId: undefined }, old.revision!);
    await assert.rejects(f.access.receive(privateMessage(), 'math'), /尚未绑定/);
    const raw: QQMessage = { ...privateMessage(), message_type: 'group', group_id: '100', message: [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: '问题' } }] };
    assert.throws(() => receiveQQ(f.engine, raw), /群未配置/);
    const teacher = await f.access.receive(privateMessage('管理课程', '900'), 'math');
    assert.ok('event' in teacher && teacher.event);
  } finally { f.store.close(); }
});

test('任务执行前再次核实私信成员资格，退群后不调用Worker', async () => {
  const f = accessFixture(); let called = false;
  try {
    const received = await f.access.receive(privateMessage());
    assert.ok('event' in received && received.event);
    const task = f.engine.createTask(received.event.id, 'qa', received.event.text);
    f.members.delete('100:1');
    const runner = new TaskRunner(f.engine, async () => { called = true; return '不应执行'; }, 1, f.access);
    runner.tick(); await runner.idle();
    assert.equal(called, false); assert.equal(f.store.task(task.id)!.status, 'blocked');
  } finally { f.store.close(); }
});

test('真实HTTP成员查询与私信发送适配器贯通，成员列表错误不能假装查无此人', async () => {
  const f = accessFixture(), calls: string[] = []; let member = true, broken = false;
  const server = createServer(async (req, res) => {
    calls.push(req.url!); assert.equal(req.headers.authorization, 'Bearer onebot-test-token');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/get_group_member_list') {
      assert.equal(data.group_id, '100'); assert.equal(data.no_cache, true);
      res.end(JSON.stringify(broken ? { status: 'failed', retcode: 100, data: [] } : { status: 'ok', retcode: 0, data: member ? [{ user_id: 1, group_id: 100 }] : [] }));
    } else { assert.equal(data.user_id, '1'); assert.equal(data.message[0].data.id !== undefined, true); res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 9876 } })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const membership = new LLBotMembership(url, 'onebot-test-token');
    f.access.membership = membership;
    const { delivery, event } = await answer(f);
    f.engine.claimDelivery(delivery.id);
    const sender = new LLBotSender(url, 'onebot-test-token', f.access);
    assert.deepEqual(await sender.send(delivery, event), { externalId: '9876' });
    assert.equal(calls.filter(p => p === '/send_private_msg').length, 1);
    member = false;
    await assert.rejects(sender.send(delivery, event), /不是该课程群/);
    assert.equal(calls.filter(p => p === '/send_private_msg').length, 1);
    broken = true;
    await assert.rejects(membership.isMember('100', '1'), /暂时无法核实/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); f.store.close(); }
});

test('HTTP私聊入口自动选择课程并要求群成员证明，不能用QQ webhook令牌管理课程', async () => {
  const f = accessFixture(), config = { adminToken: 'admin-test-token-123456', webhookToken: 'qq-hook-test-token-1234' };
  const server = createApi(f.engine, config, f.access);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const call = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { authorization: 'Bearer ' + config.webhookToken, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const response = await call('/hooks/qq', privateMessage());
    assert.equal(response.status, 202);
    const result = await response.json() as { event: Event }; assert.equal(result.event.courseId, 'math');
    assert.equal((await call('/hooks/qq?courseId=math', privateMessage('我是教师', '3'))).status, 403);
    assert.equal((await call('/v1/courses', { id: 'bad', title: '非法课程' })).status, 401);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); f.store.close(); }
});

test('成员验证过程中课程变化时，发送适配器不向任何群或私聊发出请求', async () => {
  const f = accessFixture(), gate = deferred<boolean>(); let sends = 0;
  try {
    const { delivery, event } = await answer(f); f.engine.claimDelivery(delivery.id);
    f.access.membership = { isMember: () => gate.promise };
    const guarded = f.access.authorizeDelivery(delivery, event).then(() => sends++);
    const course = f.store.course('math')!;
    f.engine.updateCourse('web:admin', { ...course, groupId: '200' }, course.revision!);
    gate.resolve(true); await assert.rejects(guarded, /群已变化/); assert.equal(sends, 0);
  } finally { f.store.close(); }
});
