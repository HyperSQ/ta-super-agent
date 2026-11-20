import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers.ts';
import { Academics } from '../src/application/services/academics.ts';
import { CourseworkIntake } from '../src/application/services/coursework-intake.ts';
import { SubmissionFiles } from '../src/application/services/submission-files.ts';
import { studentSubmission } from '../src/application/services/student-submission.ts';

test('新提交附件落盘，数据库只留路径，读取走文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'ta-sub-'));
  const f = fixture();
  try {
    f.store.saveCourse({ ...f.store.course('math')!, roster: ['张三'] });
    const assignment = new Academics(f.engine).saveAssignment('web:admin', {
      courseId: 'math', title: '第3次作业', instructions: 'x', deadline: '2026-12-20T20:00:00+08:00',
      gradingPolicy: 'p1 | 10 | 步骤', studentVisible: true });
    const files = new SubmissionFiles(f.engine, root);
    const intake = new CourseworkIntake(f.engine, files);
    intake.bind('math', '12345', '张三');
    const content = Buffer.from('我的作答内容');
    const request = intake.registerMail('math', { id: 'mail-1', receivedAt: f.engine.now() }, assignment.id, '张三',
      [{ name: 'answer.txt', bytes: content }]);

    const stored = f.store.db.prepare('SELECT content FROM coursework_submission_files WHERE request_id=?').get(request.id) as { content: Uint8Array };
    assert.equal(stored.content.byteLength, 0, '数据库里不再存正文');
    const paths = f.store.db.prepare('SELECT path FROM coursework_submission_paths WHERE request_id=?').all(request.id) as { path: string }[];
    assert.equal(paths.length, 1);

    const submission = studentSubmission(f.engine, 'math', 'qq:12345', assignment.id);
    assert.equal(submission.files.length, 1);
    assert.equal(submission.files[0].content.toString(), '我的作答内容');
    assert.equal(submission.files[0].bytes, content.length);

    f.engine.createCourse('web:admin', { id: 'other', title: '另一门课', groupId: '101', instructions: '' });
    assert.throws(() => intake.file('other', request.id, 1), /未找到该提交附件/);
    const file = intake.file('math', request.id, 1);
    assert.equal(Buffer.from(file.data, 'base64').toString(), '我的作答内容');
  } finally {
    f.store.close(); rmSync(root, { recursive: true, force: true });
  }
});
