import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { fixture } from './helpers.ts';
import { createApi } from '../src/http/server.ts';
import { ChatModel } from '../src/adapters/models/client.ts';
import { Router } from '../src/agents/router.ts';
import { Runtime } from '../src/application/runtime.ts';
import { TaskRunner } from '../src/application/task-runner.ts';
import { qaWorker } from '../src/agents/workers/qa-worker.ts';
import { QATools } from '../src/agents/qa-tools.ts';
import { DeliveryOutbox } from '../src/application/delivery-outbox.ts';
import { createServer } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';

const config = { adminToken: 'admin-token-for-tests-123', webhookToken: 'qq-token-for-tests-123' };

test('渲染可同时返回同一张预览和留存 ID，旧客户端仍能只收元数据', async t => {
  const socket = process.platform === 'win32' ? '\\\\.\\pipe\\ta-render-' + randomUUID() : join(tmpdir(), 'ta-render-' + randomUUID() + '.sock');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+f7lUAAAAASUVORK5CYII=', 'base64');
  const renderer = createServer((req, res) => { req.resume(); res.end(png); }).listen(socket);
  await once(renderer, 'listening');
  const prior = process.env.TA_MATH_SOCKET;
  process.env.TA_MATH_SOCKET = socket;
  const f = fixture();
  const server = createApi(f.engine, config).listen(0, '127.0.0.1');
  t.after(async () => {
    if (prior === undefined) delete process.env.TA_MATH_SOCKET;
    else process.env.TA_MATH_SOCKET = prior;
    await Promise.all([renderer, server].map(http => new Promise<void>(resolve => http.close(() => resolve()))));
    f.store.close();
  });
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/v1/dsh/courses/math/';
  const headers = { authorization: 'Bearer ' + config.adminToken, 'content-type': 'application/json' };
  const render = (preview?: boolean) => fetch(base + 'render', { method: 'POST', headers, body: JSON.stringify({ text: '$x^2$', preview }) });
  const old = await (await render()).json();
  assert.equal(old.png, undefined);
  assert.equal(old.bytes, png.length);
  const rich = await (await render(true)).json();
  assert.equal(rich.png, png.toString('base64'));
  assert.deepEqual(await (await fetch(base + 'images/' + rich.imageId, { headers })).json(), { png: rich.png });
});

test('DSH 与 Worker 共用教材查询，保留课程隔离与原页图片', async t => {
  const f = fixture();
  f.store.saveCourse({ ...f.store.course('math')!, textbookIds: ['b3'] });
  const section = { bookId: 'b3', id: '17.2', title: '教材标题', page: 36, endPage: 40,
    topics: [{ title: '专题', page: 37 }], excerpts: [{ text: '课文摘录', page: 36 }] };
  const tools = new QATools(f.engine, undefined, {
    lookup: () => ({ requested: ['17.2 T2'], found: [], unresolved: ['17.2 T2'] }),
    sections: (books, id) => {
      assert.deepEqual(books, ['b3']); assert.equal(id, '17.2');
      return [section];
    },
  }, async (book, page) => {
    assert.equal(book, 'b3'); assert.equal(page, 36);
    return 'data:image/png;base64,iVBORw0KGgo=';
  });
  const server = createApi(f.engine, config, undefined, tools).listen(0, '127.0.0.1');
  t.after(async () => { await new Promise<void>(r => server.close(() => r())); f.store.close(); });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/dsh/courses/math`;
  const call = (path: string, token: string, data?: object) => fetch(base + path, {
    method: data ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: data ? JSON.stringify(data) : undefined,
  });
  const args = { sectionId: '17.2' };
  assert.equal((await call('/textbook', config.webhookToken, { action: 'section', ...args })).status, 401);
  const local = await tools.call({ course: f.store.course('math')!, history: [] }, 'textbook_section', JSON.stringify(args), AbortSignal.timeout(1000), false);
  const result = await (await call('/textbook', config.adminToken, { action: 'section', ...args })).json();
  assert.deepEqual(result, { data: JSON.parse(local as string) });
  assert.deepEqual(result.data.sections, [section]);
  const forbidden = await (await call('/textbook', config.adminToken, { action: 'section', ...args, bookId: 'other-course-book' })).json();
  assert.match(forbidden.data.error, /不属于本课程/);
  const page = await (await call('/textbook', config.adminToken, { action: 'page', bookId: 'b3', page: 36 })).json();
  assert.equal(page.data.page, 36);
  assert.equal(page.png, 'iVBORw0KGgo=');
  const formats = await (await call('/group-file', config.adminToken)).json();
  assert(formats.extensions.includes('zip'));
  assert.equal(formats.groupId, '100');
});

test('管理API与QQ接入令牌隔离；结构化控制校验版本', async () => {
  const f = fixture(), server = createApi(f.engine, config);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, token: string, data?: unknown) => fetch(url + path, { method: data ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
  try {
    assert.equal((await call('/v1/tasks', config.webhookToken)).status, 401);
    assert.equal((await call('/hooks/qq', config.adminToken, {})).status, 401);
    const created = await call('/v1/tasks', config.adminToken, { courseId: 'math', kind: 'qa', goal: '问题' });
    assert.equal(created.status, 201);
    const task = await created.json() as { id: string };
    assert.equal((await call(`/v1/tasks/${task.id}/control`, config.adminToken, { action: 'pause', revision: 1 })).status, 200);
    assert.equal((await call(`/v1/tasks/${task.id}/control`, config.adminToken, { action: 'resume', revision: 1 })).status, 409);
    const malformed = await call('/hooks/qq', config.webhookToken, { actor: { role: 'teacher' } });
    assert.equal(malformed.status, 400);
  } finally { await new Promise<void>(r => server.close(() => r())); f.store.close(); }
});

test('QQ webhook → Router → 隔离Worker → 持久交付队列', async () => {
  const f = fixture(), server = createApi(f.engine, config);
  const model = { complete: async () => '模拟模型的基础答疑结果' };
  const runner = new TaskRunner(f.engine, qaWorker({ vision: false, completeTurn: async messages => ({
    finishReason: 'stop', content: JSON.stringify({ protocol: 'ta-reply-v1', turn_id: /"turn_id":"([^"]+)"/.exec(String(messages[1].content))![1], action: 'send', format: 'text', content: '模拟模型的基础答疑结果' }), toolCalls: [],
  }) }, new QATools(f.engine)));
  const runtime = new Runtime(f.engine, new Router(f.engine, model), runner, new DeliveryOutbox(f.engine, { send: async () => { throw new Error('关闭外发时不能调用'); } }, false));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const raw = JSON.stringify({ post_type: 'message', message_type: 'group', self_id: 999, user_id: 1, group_id: 100, message_id: -111,
      message: [{ type: 'at', data: { qq: 999 } }, { type: 'text', data: { text: '请解释极限' } }] });
    const signature = 'sha1=' + createHmac('sha1', config.webhookToken).update(raw).digest('hex');
    const call = (body: string) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks/qq`, {
      method: 'POST', headers: { 'x-signature': signature, 'content-type': 'application/json' }, body,
    });
    assert.equal((await call(raw.replace('极限', '连续'))).status, 401);
    assert.equal((await call(raw)).status, 204);
    runtime.tick(); await Promise.resolve(); runner.tick(); await runner.idle();
    assert.equal(f.store.tasks()[0].status, 'completed');
    assert.equal(f.store.deliveries()[0].status, 'pending');
    assert.equal(f.store.deliveries()[0].text, '模拟模型的基础答疑结果');
    assert.equal(f.store.deliveries()[0].channel.target, '100');
  } finally { await runtime.stop(); await new Promise<void>(r => server.close(() => r())); f.store.close(); }
});

test('模型适配器发送配置、支持JSON模式并校验返回', async () => {
  let seen: Record<string, unknown> = {};
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-key');
    let data = ''; for await (const chunk of req) data += chunk;
    seen = JSON.parse(data);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"action":"create","kind":"qa","goal":"x"}' } }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const model = new ChatModel({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: 'test-key', model: 'test-model', timeoutMs: 1000 });
    assert.match(await model.complete([{ role: 'user', content: '测试' }], new AbortController().signal, true), /create/);
    assert.equal(seen.model, 'test-model'); assert.deepEqual(seen.response_format, { type: 'json_object' });
  } finally { await new Promise<void>(r => server.close(() => r())); }
});

test('启动配置拒绝相同令牌与非数字教师ID', () => {
  assert.throws(() => loadConfig({ ADMIN_TOKEN: 'same-token-1234567', QQ_WEBHOOK_TOKEN: 'same-token-1234567' }), /两个不同/);
  assert.throws(() => loadConfig({ ADMIN_TOKEN: config.adminToken, QQ_WEBHOOK_TOKEN: config.webhookToken, TEACHER_QQ_IDS: '老师' }), /数字ID/);
  assert.equal(loadConfig({ ADMIN_TOKEN: config.adminToken, QQ_WEBHOOK_TOKEN: config.webhookToken }).llbotUrl, 'http://127.0.0.1:13010');
});

test('线程迁移管理API要求管理员令牌与归属版本，并公开修订历史', async () => {
  const f = fixture(), server = createApi(f.engine, config);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const a = f.receive('误分消息'), b = f.receive('正确线程', { actorId: 'qq:2' });
    f.engine.createTask(a.id, 'qa', a.text); f.engine.createTask(b.id, 'qa', b.text);
    const data = { moves: [{ eventId: a.id, revision: 1 }], targetEventId: b.id, targetRevision: 1, reason: '教师核实后合并' };
    const post = (token: string) => fetch(`${url}/v1/threads/reclassify`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(data) });
    assert.equal((await post(config.webhookToken)).status, 401);
    assert.equal((await post(config.adminToken)).status, 200);
    assert.equal((await post(config.adminToken)).status, 409);
    assert.equal(f.store.event(a.id)!.threadId, b.threadId);
    const history = await fetch(`${url}/v1/threads/changes`, { headers: { authorization: `Bearer ${config.adminToken}` } });
    const rows = await history.json() as { data: { feedbackActor: string } }[];
    assert.equal(rows.length, 1); assert.equal(rows[0].data.feedbackActor, 'web:admin');
    const review = await fetch(`${url}/v1/events/${a.id}/reconsider`, { method: 'POST', headers: { authorization: `Bearer ${config.adminToken}` } });
    assert.equal(review.status, 202);
    assert.equal(f.store.pendingReviews()[0].id, a.id);
  } finally { await new Promise<void>(r => server.close(() => r())); f.store.close(); }
});

test('桌面工作台API完成课程编辑、建作业、批量登记与刷新读取', async () => {
  const f = fixture(), server = createApi(f.engine, config);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (method: string, path: string, data?: unknown) => fetch(url + path, { method, headers: { authorization: `Bearer ${config.adminToken}`, 'content-type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
  try {
    const edit = await call('PUT', '/v1/courses/math', { revision: 1, title: '数学分析', groupId: '100', instructions: '', roster: ['张三', '李四'], progress: '第三章', gradingPolicy: '步骤分' });
    assert.equal(edit.status, 200);
    const courses = await (await call('GET', '/v1/courses')).json() as { roster: string[]; revision: number }[];
    assert.deepEqual(courses[0].roster, ['张三', '李四']); assert.equal(courses[0].revision, 2);
    const image = { name: '题图.png', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+f7lUAAAAASUVORK5CYII=' };
    const assignment = { title: '第4次', instructions: '', deadline: '2026-11-02T22:00:00+08:00', gradingPolicy: '步骤分' };
    const a = await (await call('POST', '/v1/courses/math/assignments', { ...assignment, images: [image] })).json() as { id: string };
    assert.ok(a.id);
    const detail = `/v1/assignments/${a.id}`;
    assert.deepEqual((await (await call('GET', detail)).json()).images, [image]);
    assert.equal((await (await call('GET', '/v1/courses/math/assignments')).json())[0].images, undefined);
    const dshAssignments = '/v1/dsh/courses/math/assignments';
    const dshAssignment = dshAssignments + '?assignmentId=' + encodeURIComponent(a.id);
    const list = await (await call('GET', dshAssignments)).json();
    assert.equal(list[0].imageCount, 1);
    const metadata = await (await call('GET', dshAssignment)).json();
    assert.equal(metadata.data.studentVisible, false);
    assert.deepEqual(metadata.data.attachments, [{ name: image.name, index: 1 }]);
    assert.equal(metadata.image, undefined);
    const selected = await (await call('GET', dshAssignment + '&attachment=1')).json();
    assert.deepEqual(selected.image, image);
    assert.equal(selected.data.loadedAttachment, 1);
    assert.equal((await call('GET', dshAssignments + '?attachment=1')).status, 400);
    assert.equal((await call('GET', dshAssignment + '&attachment=2')).status, 404);
    f.engine.createCourse('web:admin', { id: 'other', title: '其他课', instructions: '' });
    assert.equal((await call('GET', dshAssignment.replace('/math/', '/other/') + '&attachment=1')).status, 404);
    assert.equal((await call('PUT', detail, { ...assignment, revision: 1, images: [{ ...image, dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }] })).status, 400);
    assert.deepEqual((await (await call('PUT', detail, { ...assignment, title: '更正标题', revision: 1 })).json()).images, [image]);
    assert.deepEqual((await (await call('PUT', detail, { ...assignment, instructions: '第2题', revision: 2, images: [] })).json()).images, []);
    assert.equal((await call('POST', detail + '/offline', { students: [{ name: '张三', revision: 0 }] })).status, 400);
    assert.equal((await call('POST', detail + '/offline', { students: [{ name: '张三', revision: 0, score: 0 }] })).status, 200);
    const rows = await (await call('GET', detail + '/offline')).json() as { studentName: string; score: number }[];
    assert.equal(rows[0].studentName, '张三'); assert.equal(rows[0].score, 0); assert.equal('late' in rows[0], false);
    assert.equal((await call('DELETE', `/v1/assignments/${a.id}/offline/${encodeURIComponent('张三')}`, { revision: 1 })).status, 200);
    assert.deepEqual(await (await call('GET', `/v1/assignments/${a.id}/offline`)).json(), []);
  } finally { await new Promise<void>(r => server.close(() => r())); f.store.close(); }
});
