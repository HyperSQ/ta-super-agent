import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fixture } from './helpers.ts';
import { CourseFiles } from '../src/application/services/course-files.ts';
import { QATools } from '../src/agents/qa-tools.ts';
import type { Delivery } from '../src/domain/model.ts';

const signal = new AbortController().signal;

test('服务器上的任务产物可按 path 读取，未发布与越界路径被拒绝', () => {
  const root = mkdtempSync(join(tmpdir(), 'ta-files-'));
  const f = fixture();
  try {
    const event = f.engine.receive({ sourceKey: randomUUID(), externalId: randomUUID(), threadId: randomUUID(),
      courseId: 'math', actorId: 'web:admin', channel: { kind: 'management', target: 'lesson' },
      receivedAt: f.engine.now(), text: '准备讲义' }).event;
    const task = f.engine.createTask(event.id, 'lesson', '第2讲讲义');
    const dir = join(root, 'math', task.id, 'artifacts');
    mkdirSync(dir, { recursive: true });
    const content = Buffer.from('一致收敛的柯西准则');
    writeFileSync(join(dir, 'handout.txt'), content);
    f.store.saveTask({ ...task, result: '讲义正文', artifacts: [{ name: 'handout.txt', bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'), deliveryEventId: event.id }] });

    const files = new CourseFiles(f.engine, root);
    assert.equal(files.list('math').length, 0);
    const delivery: Delivery = { id: randomUUID(), taskId: task.id, revision: task.revision, inputEpoch: task.inputEpoch,
      replyEventId: event.id, channel: { kind: 'qq-group', target: '100' }, text: '讲义', fileId: randomUUID(), status: 'sent', sentAt: f.engine.now() };
    f.store.saveDelivery(delivery);
    const listed = files.list('math');
    assert.equal(listed.length, 1);
    assert.equal(listed[0].path, `${task.id}/artifacts/handout.txt`);
    const read = files.read('math', listed[0].path);
    assert.equal(read.content.toString(), '一致收敛的柯西准则');
    assert.throws(() => files.read('math', '../../etc/passwd'), /找不到/);
    writeFileSync(join(dir, 'handout.txt'), '未发布的同名文件');
    assert.throws(() => files.read('math', read.path), /需要重新发布/);
  } finally {
    f.store.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('文件工具列出并读取文本，看不到草稿', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ta-files-'));
  const f = fixture();
  try {
    const event = f.engine.receive({ sourceKey: randomUUID(), externalId: randomUUID(), threadId: randomUUID(),
      courseId: 'math', actorId: 'web:admin', channel: { kind: 'management', target: 'lesson' },
      receivedAt: f.engine.now(), text: '准备讲义' }).event;
    const task = f.engine.createTask(event.id, 'lesson', '第2讲讲义');
    const dir = join(root, 'math', task.id, 'artifacts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'notes.md'), '一致收敛的定义与反例');
    f.store.saveTask({ ...task, artifacts: [{ name: 'notes.md', bytes: 30, sha256: createHash('sha256').update('一致收敛的定义与反例').digest('hex'), deliveryEventId: event.id }] });
    const delivery: Delivery = { id: randomUUID(), taskId: task.id, revision: task.revision, inputEpoch: task.inputEpoch,
      replyEventId: event.id, channel: { kind: 'qq-group', target: '100' }, text: '文件', fileId: randomUUID(), status: 'sent', sentAt: f.engine.now() };
    f.store.saveDelivery(delivery);

    const question = f.engine.receive({ sourceKey: randomUUID(), externalId: randomUUID(), threadId: randomUUID(),
      courseId: 'math', actorId: 'qq:1', channel: { kind: 'qq-private', target: '1' },
      receivedAt: f.engine.now(), text: '讲义里的文件是什么' }).event;
    const qa = f.engine.createTask(question.id, 'qa', question.text);
    const run = f.engine.claim(qa.id)!;
    const tools = new QATools(f.engine, undefined, undefined, undefined, undefined, undefined, new CourseFiles(f.engine, root));
    const listed = JSON.parse(await tools.call(run, 'list_course_files', '{}', signal, false) as string);
    assert.equal(listed.files.length, 1);
    const read = JSON.parse(await tools.call(run, 'read_course_file', JSON.stringify({ path: listed.files[0].path }), signal, false) as string);
    assert.match(read.text, /一致收敛/);
  } finally {
    f.store.close(); rmSync(root, { recursive: true, force: true });
  }
});
