import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fixture } from './helpers.ts';
import { CourseFiles } from '../src/application/services/course-files.ts';
import { GroupFiles } from '../src/application/services/group-files.ts';

test('群文件下载一次落盘，worker 可按 path 读取且对学生可见', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ta-group-'));
  const f = fixture();
  try {
    const files = new CourseFiles(f.engine, { artifacts: join(root, 'artifacts'), group: join(root, 'files') });
    const content = Buffer.from('PK zip data');
    const groups = new GroupFiles(files, join(root, 'files'), async () => content);
    const event = f.engine.receive({ sourceKey: randomUUID(), externalId: randomUUID(), threadId: randomUUID(),
      courseId: 'math', actorId: 'qq:1', channel: { kind: 'qq-group', target: '100' },
      receivedAt: f.engine.now(), text: '[QQ 群文件]',
      attachments: [{ kind: 'file', fileId: 'f1', name: '实验一.zip', size: content.length }] }).event;
    assert.equal(await groups.ingest(event), true);

    const listed = files.list('math');
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, '实验一.zip');
    assert.equal(listed[0].visibility, 'published');
    const sha = createHash('sha256').update(content).digest('hex');
    assert.equal(listed[0].path, `group/${sha}/实验一.zip`);
    assert.equal(files.read('math', listed[0].path).content.toString(), 'PK zip data');

    await groups.ingest(event);
    assert.equal(files.list('math').length, 1);
  } finally {
    f.store.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('下载失败时不登记文件，由调用方记录审计', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ta-group-'));
  const f = fixture();
  try {
    const files = new CourseFiles(f.engine, { artifacts: join(root, 'artifacts'), group: join(root, 'files') });
    const groups = new GroupFiles(files, join(root, 'files'), async () => { throw new Error('llbot 不可用'); });
    const event = f.engine.receive({ sourceKey: randomUUID(), externalId: randomUUID(), threadId: randomUUID(),
      courseId: 'math', actorId: 'qq:1', channel: { kind: 'qq-group', target: '100' },
      receivedAt: f.engine.now(), text: '[QQ 群文件]',
      attachments: [{ kind: 'file', fileId: 'f2', name: '讲义.pdf', size: 3 }] }).event;
    await assert.rejects(() => groups.ingest(event), /llbot/);
    assert.equal(files.list('math').length, 0);
  } finally {
    f.store.close(); rmSync(root, { recursive: true, force: true });
  }
});
