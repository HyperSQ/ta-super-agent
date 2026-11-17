import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.ts';
import { Academics } from '../src/application/services/academics.ts';
import { studentSubmission } from '../src/application/services/student-submission.ts';
import { QATools } from '../src/agents/qa-tools.ts';
import type { Channel } from '../src/domain/model.ts';

const signal = new AbortController().signal;
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const pdf = Buffer.from('%PDF-1.4\n%demo\n');

function setup(options: { pdfImage?: (pdf: Buffer, page: number, signal: AbortSignal) => Promise<string | undefined> } = {}) {
  const f = fixture();
  f.engine.updateCourse('web:admin', { ...f.store.course('math')!, roster: ['张三', '李四'] }, 1);
  const assignment = new Academics(f.engine).saveAssignment('web:admin', {
    courseId: 'math', title: '第3次作业', instructions: '证明一致收敛', deadline: '2026-11-10T20:00:00+08:00',
    gradingPolicy: '', studentVisible: true,
  });
  const db = f.store.db;
  db.prepare('INSERT INTO coursework_qq_students VALUES(?,?,?)').run('math', 'qq:1', '张三');
  db.prepare('INSERT INTO coursework_qq_students VALUES(?,?,?)').run('math', 'qq:2', '李四');
  const event = f.engine.receive({ sourceKey: randomUUID(), externalId: randomUUID(), threadId: randomUUID(),
    courseId: 'math', actorId: 'qq:1', channel: { kind: 'qq-private', target: '1' }, receivedAt: Date.now(), text: '提交作业' }).event;
  const requestId = randomUUID();
  db.prepare('INSERT INTO coursework_requests VALUES(?,?,?,?,?,?,?,?,?)').run(requestId, 'math', assignment.id, 'submission',
    'accepted', 'qq:1', '张三', event.id, JSON.stringify({ receivedAt: Date.parse('2026-11-11T09:00:00+08:00'), attempt: 1, late: true }));
  db.prepare('INSERT INTO coursework_submission_files VALUES(?,?,?,?)').run(requestId, 1, 'answer.png', png);
  db.prepare('INSERT INTO coursework_submission_files VALUES(?,?,?,?)').run(requestId, 2, 'analysis.pdf', pdf);
  db.prepare('INSERT INTO coursework_submission_files VALUES(?,?,?,?)').run(requestId, 3, 'notes.txt', Buffer.from('第3题：用反例说明', 'utf8'));
  return { f, assignment, requestId, pdfImage: options.pdfImage };
}

function run(f: ReturnType<typeof fixture>, actor = 'qq:1', channel: Channel = { kind: 'qq-private', target: '1' }) {
  const event = f.engine.receive({ sourceKey: randomUUID(), externalId: randomUUID(), threadId: randomUUID(),
    courseId: 'math', actorId: actor, channel, receivedAt: Date.now(), text: '我交的作业哪里错了' }).event;
  const task = f.engine.createTask(event.id, 'qa', event.text);
  return f.engine.claim(task.id)!;
}

test('学生只能查看本人提交的附件列表与内容', async () => {
  const { f, assignment, pdfImage } = setup();
  const tools = new QATools(f.engine, undefined, undefined, undefined, undefined, pdfImage);
  const own = run(f);
  const meta = JSON.parse(await tools.call(own, 'read_my_submission', JSON.stringify({ assignmentId: assignment.id }), signal, true) as string);
  assert.equal(meta.attempt, 1);
  assert.equal(meta.late, true);
  assert.deepEqual(meta.files.map((file: { name: string }) => file.name), ['answer.png', 'analysis.pdf', 'notes.txt']);

  const image = await tools.call(own, 'read_my_submission', JSON.stringify({ assignmentId: assignment.id, fileIndex: 1 }), signal, true);
  assert.ok(Array.isArray(image));
  assert.ok(image.some(item => item.type === 'image_url' && item.image_url.url.startsWith('data:image/png;base64,')));

  const text = JSON.parse(await tools.call(own, 'read_my_submission', JSON.stringify({ assignmentId: assignment.id, fileIndex: 3 }), signal, true) as string);
  assert.match(text.text, /反例/);

  // 另一名已绑定学生查同一份作业：看不到张三的附件。
  const other = run(f, 'qq:2', { kind: 'qq-private', target: '2' });
  const otherView = JSON.parse(await tools.call(other, 'read_my_submission', JSON.stringify({ assignmentId: assignment.id }), signal, true) as string);
  assert.deepEqual(otherView.files, []);
  assert.match(otherView.error, /没有你已登记的提交/);
  f.store.close();
});

test('PDF 无渲染器时如实说明，群聊与未绑定身份被拒绝', async () => {
  const { f, assignment } = setup();
  const tools = new QATools(f.engine);
  const own = run(f);
  const noRenderer = JSON.parse(await tools.call(own, 'read_my_submission', JSON.stringify({ assignmentId: assignment.id, fileIndex: 2 }), signal, true) as string);
  assert.match(noRenderer.error, /PDF/);

  const group = run(f, 'qq:1', { kind: 'qq-group', target: '100' });
  const blocked = JSON.parse(await tools.call(group, 'read_my_submission', JSON.stringify({ assignmentId: assignment.id }), signal, true) as string);
  assert.match(blocked.error, /私聊/);

  const unboundEvent = f.engine.receive({ sourceKey: randomUUID(), externalId: randomUUID(), threadId: randomUUID(),
    courseId: 'math', actorId: 'qq:9', channel: { kind: 'qq-private', target: '9' }, receivedAt: Date.now(), text: '看看我交的' }).event;
  const unboundTask = f.engine.createTask(unboundEvent.id, 'qa', unboundEvent.text);
  const unbound = f.engine.claim(unboundTask.id)!;
  const denied = JSON.parse(await tools.call(unbound, 'read_my_submission', JSON.stringify({ assignmentId: assignment.id }), signal, true) as string);
  assert.match(denied.error, /核对/);
  f.store.close();
});

test('配置了 PDF 渲染器时能返回页面图片', async () => {
  const { f, assignment } = setup({ pdfImage: async () => 'data:image/png;base64,iVBORw0KGgo=' });
  const tools = new QATools(f.engine, undefined, undefined, undefined, undefined, async () => 'data:image/png;base64,iVBORw0KGgo=');
  const own = run(f);
  const page = await tools.call(own, 'read_my_submission', JSON.stringify({ assignmentId: assignment.id, fileIndex: 2, page: 2 }), signal, true);
  assert.ok(Array.isArray(page));
  assert.ok(page.some(item => item.type === 'image_url'));
  f.store.close();
});

test('未指定的作业或没有提交时返回可读说明', () => {
  const { f, assignment } = setup();
  const view = studentSubmission(f.engine, 'math', 'qq:2', assignment.id);
  assert.equal(view.verified, true);
  assert.equal(view.files.length, 0);
  assert.match(view.hint ?? '', /没有你已登记的提交/);
  assert.throws(() => studentSubmission(f.engine, 'math', 'qq:1', 'missing'), /找不到/);
  f.store.close();
});
