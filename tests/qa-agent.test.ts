import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { fixture } from './helpers.ts';
import { Academics } from '../src/application/services/academics.ts';
import { ChatModel } from '../src/adapters/models/client.ts';
import { receiveQQ, LLBotSender } from '../src/adapters/qq/llbot.ts';
import { QATools } from '../src/agents/qa-tools.ts';
import { qaWorker } from '../src/agents/workers/qa-worker.ts';
import { TaskRunner } from '../src/application/task-runner.ts';
import { Router } from '../src/agents/router.ts';
import { DeliveryOutbox } from '../src/application/delivery-outbox.ts';
import { QQAccess } from '../src/application/services/qq-access.ts';
import type { AgentCompletion, AgentMessage, AgentModel } from '../src/ports/model.ts';

const signal = () => new AbortController().signal;
const call = (name: string, params: object = {}, id = name): AgentCompletion => ({
  finishReason: 'tool_calls', content: null, toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(params) } }],
});
const final = (messages: AgentMessage[], action: object): AgentCompletion => ({
  finishReason: 'stop', toolCalls: [],
  content: JSON.stringify({ protocol: 'ta-reply-v1', turn_id: /程序最终模板：\{"protocol":"ta-reply-v1","turn_id":"([^"]+)"/.exec(String(messages[1].content))![1], ...action }),
});
const lastTool = (messages: AgentMessage[]) => messages.findLast(m => m.role === 'tool')?.content;
const fields = { title: '本周作业', instructions: '2.1节 T2；按定义证明', deadline: '2026-11-15T23:59:00+08:00', gradingPolicy: '仅教师可见' };

test('QQ答疑按需读取作业、题号和页图，经模型 HTTP 协议进入渲染交付队列', async () => {
  const f = fixture(), academics = new Academics(f.engine);
  f.engine.updateCourse('web:admin', { ...f.store.course('math')!, textbookIds: ['book'] }, 1);
  const a = academics.saveAssignment('web:admin', { ...fields, courseId: 'math', studentVisible: true });
  const pageImage = 'data:image/png;base64,iVBORw0KGgo=';
  const outbound: { payload?: Record<string, unknown> }[] = [];
  const input = receiveQQ(f.engine, { message_type: 'group', self_id: 999, user_id: 1, group_id: 100, message_id: 42,
    message: [{ type: 'at', data: { qq: 999 } }, { type: 'text', data: { text: '这周作业第二题怎么起步？请渲染' } }] });
  assert.ok('event' in input);
  let n = 0;
  const mock = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw), messages: AgentMessage[] = request.messages;
    const observation = { payload: request }; outbound.push(observation);
    const steps = [
      () => call('list_assignments'),
      () => call('read_assignment', { assignmentId: a.id }),
      () => call('lookup_textbook', { query: '2.1节 T2' }),
      () => call('view_textbook_page', { bookId: 'book', page: 9 }),
      () => final(messages, { action: 'send', format: 'latex', content: '先写出定义：$x=1$。' }),
    ];
    const reply = steps[n++]();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ finish_reason: reply.finishReason, message: { content: reply.content, tool_calls: reply.toolCalls } }] }));
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  try {
    const model = new ChatModel({ baseUrl: 'http://127.0.0.1:' + (mock.address() as AddressInfo).port, model: 'mock', apiKey: 'local-test', timeoutMs: 2000, vision: true });
    await new Router(f.engine, model).route(input.event, signal());
    const reference = { lookup: (books: string[], term: string) => {
      assert.deepEqual(books, ['book']); assert.equal(term, '2.1节 T2');
      return { requested: ['2.1 T2'], found: [{ label: '2.1 T2', bookId: 'book', page: 9, endPage: 9, text: '证明', needsVisualVerification: true }], unresolved: [] };
    } };
    const runner = new TaskRunner(f.engine, qaWorker(model, new QATools(f.engine, undefined, reference, async (book, page) => {
      assert.equal(book, 'book'); assert.equal(page, 9); return pageImage;
    })));
    runner.tick(); await runner.idle();
    assert.equal(n, 5);
    assert.deepEqual(outbound[0].payload?.response_format, { type: 'json_object' });
    assert.ok(Array.isArray(outbound[0].payload?.tools));
    const read = lastTool(outbound[2].payload!.messages as AgentMessage[]);
    assert.match(String(read), /按定义证明/); assert.doesNotMatch(String(read), /仅教师可见/);
    assert.deepEqual((lastTool(outbound[4].payload!.messages as AgentMessage[]) as unknown[])[1], { type: 'image_url', image_url: { url: pageImage } });
    assert.deepEqual(f.store.deliveries().map(d => [d.channel.target,d.format,d.text]), [['100','latex','先写出定义：$x=1$。']]);
    const outbox = new DeliveryOutbox(f.engine, new LLBotSender('http://invalid.invalid', '', new QQAccess(f.engine)), true);
    await outbox.tick();
    assert.equal(f.store.deliveries()[0].status, 'withdrawn');
    assert.match(f.store.deliveries()[0].error!, /未渲染成功/);
  } finally { await new Promise<void>(resolve => mock.close(() => resolve())); f.store.close(); }
});

test('作业和引用工具限定可见范围；任务读取后撤回作业会使未发答复失效', async () => {
  const f = fixture(), academics = new Academics(f.engine);
  try {
    f.engine.createCourse('web:admin', { id: 'other', title: '其他课', instructions: '', groupId: '200' });
    const visible = academics.saveAssignment('web:admin', { ...fields, courseId: 'math', studentVisible: true });
    const hidden = academics.saveAssignment('web:admin', { ...fields, title: '隐藏作业', courseId: 'math' });
    const other = academics.saveAssignment('web:admin', { ...fields, title: '别课作业', courseId: 'other', studentVisible: true });
    const group = { message_type: 'group' as const, self_id: 999, user_id: 1, group_id: 100 };
    const root = receiveQQ(f.engine, { ...group, message_id: 1, message: [{ type: 'at', data: { qq: 999 } }, { type: 'text', data: { text: '被引用的题' } }] });
    assert.ok('event' in root);
    f.receive('无关的另一题');
    const quoted = receiveQQ(f.engine, { ...group, message_id: 2, message: [{ type: 'reply', data: { id: 1 } }, { type: 'text', data: { text: '这题' } }] });
    assert.ok('event' in quoted);
    const task = f.engine.createTask(quoted.event.id,'qa','这题');
    const run = f.engine.claim(task.id)!; const tools = new QATools(f.engine);
    assert.match(String(await tools.call(run,'read_quoted_message','{}',signal(),false)), /被引用的题/);
    assert.match(String(await tools.call(run,'list_assignments','{}',signal(),false)), new RegExp(visible.id));
    for (const a of [hidden, other]) assert.match(String(await tools.call(run,'read_assignment',JSON.stringify({assignmentId:a.id}),signal(),false)), /未找到/);
    assert.match(String(await tools.call(run,'list_assignments','{"courseId":"other"}',signal(),false)), /未授权/);
    assert.match(String(await tools.call(run,'view_textbook_page','{"bookId":"other","page":1}',signal(),true)), /不属于本课程/);
    f.engine.finish(run,{ action:'send', format:'text', content:['旧作业信息'] });
    academics.saveAssignment('web:admin', { ...visible, studentVisible: false });
    const d = f.store.deliveries()[0];
    assert.equal(f.engine.claimDelivery(d.id), undefined);
    assert.equal(f.store.delivery(d.id)?.status,'withdrawn');
  } finally { f.store.close(); }
});

test('静默零发送；截断中的工具不执行；任务保留原有的过期运行保护', async () => {
  const f = fixture();
  try {
    const event = f.receive('不用回复'), task = f.engine.createTask(event.id,'qa',event.text);
    let requests = 0;
    const model: AgentModel = { vision:false, completeTurn: async (messages, _tools, _signal, maxTokens) => {
      if (++requests === 1) return { ...call('list_assignments'), finishReason:'length' };
      assert.equal(maxTokens,8192); assert.ok(!messages.some(m => m.role === 'tool'));
      return final(messages,{action:'silent'});
    }};
    const runner = new TaskRunner(f.engine,qaWorker(model,new QATools(f.engine)));
    runner.tick(); await runner.idle();
    assert.equal(requests,2); assert.equal(f.store.deliveries().length,0);
    assert.equal(f.store.task(task.id)?.replyAction?.action,'silent');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM memory_jobs').get()?.n,0);
    const second = f.receive('解释另一题'), t = f.engine.createTask(second.id,'qa',second.text);
    let now = Date.now(); f.engine.now = () => now;
    const run = f.engine.claim(t.id,100)!; now += 90; f.engine.renew(run,100); now += 20;
    f.engine.checkpoint(run,{ stage:'evidence_read' });
    f.receive('追加条件',{threadId:second.threadId});
    assert.throws(() => f.engine.finish(run,{ action:'send',format:'text',content:['过期答案'] }),/运行已失效/);
  } finally { f.store.close(); }
});

test('分条独立记回执；前一条状态未知时不继续发送', async () => {
  const f = fixture();
  try {
    const event = f.receive('分两条'), t = f.engine.createTask(event.id,'qa',event.text);
    f.engine.finish(f.engine.claim(t.id)!,{ action:'send',format:'text',content:['第一条','第二条'] });
    let attempted = 0;
    await new DeliveryOutbox(f.engine,{send: async () => { attempted++; throw new Error('响应中断'); }},true).tick();
    assert.equal(attempted,1);
    assert.deepEqual(f.store.deliveries().map(d => d.status),['unknown','withdrawn']);
  } finally { f.store.close(); }
});
