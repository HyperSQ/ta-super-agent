import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fixture } from './helpers.ts';
import { createApi } from '../src/http/server.ts';
import { TextbookLibrary } from '../src/adapters/knowledge/library.ts';
import { TextbookReferences } from '../src/adapters/knowledge/references.ts';
import { receiveQQ } from '../src/adapters/qq/llbot.ts';
import { classContext } from '../src/application/services/class-context.ts';
import { lessonWorker } from '../src/agents/workers/lesson-worker.ts';
import { TaskRunner } from '../src/application/task-runner.ts';

const book = '# 课程讲义\n\n## 1.1 缩放点积注意力\n\n按最后一维做 softmax，缩放因子为 sqrt(d_k)。\n\n### T1 手算\n计算第一个查询的权重。\n';
const signal = new AbortController().signal;

test('课程工作台导入 Markdown 后，该课程可按题号和关键词查教材', async t => {
  const f = fixture();
  const root = mkdtempSync(join(tmpdir(), 'ta-rehearsal-book-'));
  const settings = { adminToken: 'rehearsal-admin', webhookToken: 'rehearsal-webhook' };
  const server = createApi(f.engine, settings, undefined, undefined, undefined, undefined, undefined, undefined, undefined, root);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); f.store.close(); rmSync(root,{recursive:true,force:true}); });
  const address = server.address(); assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/v1/courses/math/textbook-import`;
  const request = (token: string, revision: number) => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ markdown: book, revision }) });
  assert.equal((await request(settings.webhookToken, 1)).status, 401);
  const response = await request(settings.adminToken, 1);
  assert.equal(response.status, 201, await response.clone().text());
  const { id } = await response.json() as { id: string };
  assert.deepEqual(f.store.course('math')?.textbookIds,[id]);
  assert.equal((await request(settings.adminToken, 1)).status, 409);
  const ref = new TextbookReferences(root);
  assert.match(ref.lookup([id], '第1.1节 T1').found[0].text,/第一个查询/);
  assert.equal(ref.sections([id],'1.1')[0].sourceKind,'markdown');
  const library = new TextbookLibrary(root);
  assert.equal((await library.search([id],'softmax 缩放',signal)).hits[0].sourceKind,'markdown');
  assert.equal((await library.search([],'softmax 缩放',signal)).hits.length,0);
});

test('未被点名的问题只记录一次，随后能成为备课证据', async t => {
  const f = fixture(); t.after(() => f.store.close());
  const raw = { message_type: 'group' as const, group_id: 100, self_id: 999, user_id: 20, message_id: 7411,
    message: [{ type: 'text', data: { text: '为什么 softmax 应该沿最后一维算？' } }] };
  receiveQQ(f.engine, raw); receiveQQ(f.engine, raw);
  receiveQQ(f.engine, { ...raw, message_id: 7412, message: [{ type: 'text', data: { text: '我来帮忙一起调试这份作业' } }] });
  assert.equal(f.store.pendingEvents().length,0);
  assert.equal(f.store.deliveries().length,0);
  const [question, extra] = classContext(f.engine, 'math', { days: 7 }).group.passiveQuestions;
  assert.match(question.text, /softmax/); assert.equal(extra,undefined);
  const origin = f.receive('准备习题课', { actorId: 'qq:900' });
  const task = f.engine.createTask(origin.id,'lesson',origin.text);
  const worker = lessonWorker(f.engine, { vision:false, async completeTurn(messages) {
    assert.match(String(messages[1].content),new RegExp(question.eventId));
    assert.match(String(messages[1].content),/群内未点名的问题/);
    return { finishReason:'stop',toolCalls:[],content:JSON.stringify({title:'注意力习题课',studentMarkdown:'检查最后一维',teacherMarkdown:'行和为1'}) };
  } }, { async search() { throw new Error('无需检索未绑定的教材'); } });
  const runner = new TaskRunner(f.engine,worker); runner.tick(); await runner.idle();
  assert.equal(f.store.task(task.id)?.status,'completed');
});
