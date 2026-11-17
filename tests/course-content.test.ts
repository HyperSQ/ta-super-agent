import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.ts';
import { CourseContent } from '../src/application/services/course-content.ts';
import { QATools } from '../src/agents/qa-tools.ts';
import type { Delivery } from '../src/domain/model.ts';

const signal = new AbortController().signal;

function publish(f: ReturnType<typeof fixture>, taskId: string, eventId: string) {
  const task = f.store.task(taskId)!;
  const delivery: Delivery = { id: randomUUID(), taskId, revision: task.revision, inputEpoch: task.inputEpoch,
    replyEventId: eventId, channel: { kind: 'qq-group', target: '100' }, text: '讲义', status: 'sent', sentAt: f.engine.now() };
  f.store.saveDelivery(delivery);
}

test('讲义发布后学生可检索并打开，未发布草稿只对教师可见', () => {
  const f = fixture();
  const event = f.engine.receive({ sourceKey: randomUUID(), externalId: randomUUID(), threadId: randomUUID(),
    courseId: 'math', actorId: 'web:admin', channel: { kind: 'management', target: 'lesson' },
    receivedAt: f.engine.now(), text: '准备第2讲讲义' }).event;
  const task = f.engine.createTask(event.id, 'lesson', '第2讲讲义：一致收敛');
  f.store.saveTask({ ...task, result: '定理 2.1（一致收敛判别）设函数列……' });

  const content = new CourseContent(f.engine);
  assert.equal(content.search('math', 'qq:1', '一致收敛').length, 0);
  assert.equal(content.search('math', 'qq:900', '一致收敛', { teacher: true }).length, 1);
  assert.throws(() => content.open('math', 'qq:1', `task/${task.id}/result`), /还没有发布/);

  publish(f, task.id, event.id);
  const hits = content.search('math', 'qq:1', '一致收敛');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'material');
  const row = content.open('math', 'qq:1', hits[0].ref);
  assert.match(row.text, /定理 2\.1/);
  f.store.close();
});

test('内容工具按引用检索和打开，不跨课程', async () => {
  const f = fixture();
  const event = f.engine.receive({ sourceKey: randomUUID(), externalId: randomUUID(), threadId: randomUUID(),
    courseId: 'math', actorId: 'web:admin', channel: { kind: 'management', target: 'lesson' },
    receivedAt: f.engine.now(), text: '准备讲义' }).event;
  const task = f.engine.createTask(event.id, 'lesson', '第2讲讲义');
  f.store.saveTask({ ...task, result: '一致收敛的柯西准则与反例。' });
  publish(f, task.id, event.id);

  const question = f.engine.receive({ sourceKey: randomUUID(), externalId: randomUUID(), threadId: randomUUID(),
    courseId: 'math', actorId: 'qq:1', channel: { kind: 'qq-private', target: '1' },
    receivedAt: f.engine.now(), text: '讲义里一致收敛怎么讲的' }).event;
  const qa = f.engine.createTask(question.id, 'qa', question.text);
  const run = f.engine.claim(qa.id)!;
  const tools = new QATools(f.engine);
  const found = JSON.parse(await tools.call(run, 'search_course_content', JSON.stringify({ query: '一致收敛' }), signal, false) as string);
  assert.equal(found.hits.length, 1);
  const opened = JSON.parse(await tools.call(run, 'open_course_content', JSON.stringify({ ref: found.hits[0].ref }), signal, false) as string);
  assert.match(opened.text, /柯西准则/);
  const wrong = JSON.parse(await tools.call(run, 'open_course_content', JSON.stringify({ ref: 'task/不存在/result' }), signal, false) as string);
  assert.match(wrong.error, /找不到/);
  f.store.close();
});
