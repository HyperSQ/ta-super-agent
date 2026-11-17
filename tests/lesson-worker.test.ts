import assert from 'node:assert/strict';
import test from 'node:test';
import { lessonWorker } from '../src/agents/workers/lesson-worker.ts';
import { Academics } from '../src/application/services/academics.ts';
import { Router } from '../src/agents/router.ts';
import { TaskRunner } from '../src/application/task-runner.ts';
import { fixture } from './helpers.ts';
import { sectionIds } from '../src/adapters/knowledge/references.ts';

test('教师讲义命令生成可核对的两版讲义，写入任务且不会发往 QQ', async t => {
  const f = fixture();
  t.after(() => f.store.close());
  f.engine.updateCourse('web:admin', { ...f.store.course('math')!, progress: '一致收敛', textbookIds: ['math-b3'] }, 1);
  const academic = new Academics(f.engine);
  const a = academic.saveAssignment('web:admin', { courseId: 'math', title: '第十一周', instructions: 'T2 一致收敛', gradingPolicy: '',
    deadline: '2026-12-01T10:00:00Z', studentVisible: true });
  academic.saveAssignment('web:admin', { ...a, id: undefined, title: '未发布作业', studentVisible: false });
  const event = f.receive('/lesson 40 分钟复习一致收敛', { actorId: 'qq:900' });
  await new Router(f.engine, { async complete() { throw new Error('不应调用 Router 模型'); } }).route(event, new AbortController().signal);
  const worker = lessonWorker(f.engine, {
    vision: false,
    async completeTurn(messages, tools) {
      assert.deepEqual(tools, []);
      const input = messages[1].content;
      assert(typeof input === 'string');
      assert.match(input, /一致收敛.*第十一周/);
      assert.doesNotMatch(input, /未发布作业/);
      return { finishReason: 'stop', toolCalls: [], content: JSON.stringify({
        title: '一致收敛习题课', studentMarkdown: '题目。参考 [S1]。', teacherMarkdown: '请核对逐题解答。',
      }) };
    },
  }, { async search(books, query) {
    assert.deepEqual(books, ['math-b3']);
    assert.match(query, /40 分钟/);
    return { hits: [{ bookId: 'math-b3', bookVersion: '1', chunkId: 'chunk', anchor: 'a', page: 12, contextStartPage: 12, endPage: 13,
      chapter: '一致收敛', text: '课本资料', needsVisualVerification: true, reasons: [] }], topics: [], mode: 'keyword', warnings: [] };
  } });
  const runner = new TaskRunner(f.engine, worker);
  runner.tick();
  await runner.idle();
  const task = f.store.tasks()[0];
  assert.equal(task.status, 'completed', task.error);
  assert.match(task.result!, /学生版[\s\S]+教师版[\s\S]+PDF 第 12 页/);
  assert.deepEqual(task.assignmentReads, [{ id: a.id, revision: a.revision }]);
  assert.equal(f.store.deliveries().length, 0);
});

test('定时讲义先依据当前学情选题，再按选题检索和生成，保留选题依据', async t => {
  const f = fixture();
  t.after(() => f.store.close());
  f.engine.updateCourse('web:admin', { ...f.store.course('math')!, progress: '已经讲完一致收敛', textbookIds: ['math-b3'] }, 1);
  f.receive('逐点收敛和一致收敛有什么区别？');
  const { event } = f.engine.receive({ sourceKey: 'weekly', courseId: 'math', threadId: 'weekly', actorId: 'web:admin',
    channel: { kind: 'management', target: 'weekly-lesson' }, text: '/lesson 本周备课', externalId: 'weekly',
    receivedAt: Date.now(), scheduled: 'weekly-lesson' });
  const task = f.engine.createTask(event.id, 'lesson', '本周备课');
  let calls = 0, searchQuery = '';
  const worker = lessonWorker(f.engine, { vision: false, async completeTurn(messages) {
    const input = String(messages[1].content);
    const value = ++calls === 1 ? { focus: '一致收敛反例辨析', rationale: '[Q1] 提到定义混淆' }
      : { title: '反例辨析', studentMarkdown: '题面', teacherMarkdown: '解答' };
    assert.match(input, calls === 1 ? /逐点收敛和一致收敛有什么区别/ : /一致收敛反例辨析/);
    return { finishReason: 'stop', toolCalls: [], content: JSON.stringify(value) };
  } }, { async search(_books, query) { searchQuery = query; return { hits: [], topics: [], mode: 'keyword', warnings: [] }; } });
  const runner = new TaskRunner(f.engine, worker);
  runner.tick(); await runner.idle();
  assert.equal(calls, 2);
  assert.match(searchQuery, /一致收敛反例辨析/);
  assert.match(f.store.task(task.id)!.result!, /选题依据：\[Q1\]/);
});

test('明确进度章节时先锁定真实教材目录，群里无关问题不会改变章节', async t => {
  const f = fixture();
  t.after(() => f.store.close());
  for (const input of ['17章第2节', '讲到第17章第2节', '§17.2', '17.2节', '进度：17.2', '习题17.2']) assert.deepEqual(sectionIds(input), ['17.2']);
  f.engine.updateCourse('web:admin', { ...f.store.course('math')!, progress: '讲到17章第2节', textbookIds: ['math-b3'] }, 1);
  f.receive('问一下复习的一致收敛');
  const { event } = f.engine.receive({ sourceKey: 'weekly17', courseId: 'math', threadId: 'weekly17', actorId: 'web:admin',
    channel: { kind: 'management', target: 'weekly-lesson' }, text: '/lesson 本周备课', externalId: 'weekly17',
    receivedAt: Date.now(), scheduled: 'weekly-lesson' });
  const task = f.engine.createTask(event.id, 'lesson', '本周备课');
  let calls = 0;
  const model = { vision: false, async completeTurn(messages: Parameters<import('../src/ports/model.ts').AgentModel['completeTurn']>[0]) {
    const input = String(messages[1].content);
    assert.match(input, /映射的微分/);
    const value = ++calls === 1 ? { topicIndex: 1, focus: '一致收敛', rationale: '本节起点' }
      : { title: '可微映射', studentMarkdown: '题面 [S1]', teacherMarkdown: '解答' };
    if (calls === 2) assert.match(input, /"focus":"17\.2 可微映射"/);
    return { finishReason: 'stop', toolCalls: [], content: JSON.stringify(value) };
  } };
  const knowledge = { async search() { throw Error('已有明确章节时不应全文检索'); } };
  const worker = lessonWorker(f.engine, model, knowledge, { sections(books, id) {
    assert.deepEqual(books, ['math-b3']); assert.equal(id, '17.2');
    return [{ bookId: books[0], id, title: '映射的微分', page: 152, endPage: 159,
      topics: [{ title: '可微映射', page: 152 }], excerpts: [{ page: 152, text: '可微映射的定义' }] }];
  } });
  const runner = new TaskRunner(f.engine, worker);
  runner.tick(); await runner.idle();
  assert.equal(calls, 2);
  assert.match(f.store.task(task.id)!.result!, /教材范围：17\.2 映射的微分/);
});
