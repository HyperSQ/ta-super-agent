import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture } from './helpers.ts';
import { Academics } from '../src/application/services/academics.ts';
import { CourseMail } from '../src/application/services/course-mail.ts';
import { CourseworkIntake } from '../src/application/services/coursework-intake.ts';
import { GradingBatches } from '../src/application/grading-batches.ts';
import type { MailCredentials, MailCursor, MailReply, MailTransport, ReceivedMail } from '../src/adapters/mail/transport.ts';

class FakeMail implements MailTransport {
  replies: MailReply[] = [];
  async check(_credentials: MailCredentials) {}
  async fetch(_credentials: MailCredentials, _cursor: MailCursor) { return { cursor: {}, messages: [] as ReceivedMail[] }; }
  async reply(_credentials: MailCredentials, message: MailReply) { this.replies.push(message); }
}

function setup() {
  const f = fixture();
  const now = f.engine.now();
  f.store.saveCourse({ ...f.store.course('math')!, roster: ['张三'], weeklyLesson: { weekday: 6, time: '09:00', teacherQQ: '900', enabledAt: 1 } });
  const assignment = new Academics(f.engine).saveAssignment('web:admin', {
    courseId: 'math', title: '第3次作业', instructions: 'x', deadline: new Date(now - 10 * 60_000).toISOString(),
    gradingPolicy: 'p1 | 10 | 步骤', studentVisible: true,
  });
  const fake = new FakeMail();
  const mail = new CourseMail(f.engine, fake, randomBytes(32));
  mail.save('math', {
    address: 'course@example.com', imapHost: 'imap.example.com', imapPort: 993, folder: 'INBOX',
    smtpHost: 'smtp.example.com', smtpPort: 465, smtpMode: 'tls', prefix: '作业提交', enabled: true, password: 'secret', revision: 0,
  });
  const mailbox = (f.store.db.prepare('SELECT mailbox_key FROM course_mailboxes WHERE course_id=?').get('math') as { mailbox_key: string }).mailbox_key;
  const submission = new CourseworkIntake(f.engine).registerMail('math',
    { id: 'mail-1', receivedAt: now - 30 * 60_000 }, assignment.id, '张三',
    [{ name: 'answer.txt', bytes: Buffer.from('作答') }]);
  const message = {
    id: '11111111-1111-4111-8111-111111111111', mailbox, messageId: '<a@example.com>', from: 'student@example.com',
    subject: '作业提交 第3次作业 张三', receivedAt: now - 30 * 60_000, text: '作答', files: [], state: 'registered',
    submissionId: submission.id,
    grade: { assignmentRevision: 1, submissionId: submission.id,
      draft: { points: [{ id: 'p1', max: 10, score: 8, evidence: '作答', comment: '步骤清楚' }], total: 8, maximum: 10 } },
  };
  f.store.db.prepare('INSERT INTO course_mail_messages(id,course_id,source_key,received_at,data) VALUES(?,?,?,?,?)')
    .run(message.id, 'math', 'k1', message.receivedAt, JSON.stringify(message));
  return { f, fake, mail, batches: new GradingBatches(f.engine, mail), assignment, now, message };
}

test('截止节点把节点前已批改的提交累积成一批，审核后统一回信', async () => {
  const { f, fake, batches, now, message } = setup();
  const created = batches.tick(now);
  assert.equal(created.length, 1);
  assert.equal(created[0].items.length, 1);
  assert.equal(created[0].items[0].studentName, '张三');
  assert.equal(created[0].status, 'pending');

  const result = await batches.approve('math', created[0].id);
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 0);
  assert.equal(fake.replies.length, 1);
  assert.match(fake.replies[0].text, /批改结果：8\/10/);
  assert.match(fake.replies[0].text, /步骤清楚/);
  const stored = JSON.parse((f.store.db.prepare('SELECT data FROM course_mail_messages WHERE id=?').get(message.id) as { data: string }).data);
  assert.equal(stored.feedback.state, 'sent');

  assert.equal(batches.tick(now + 10_000).length, 0);
  await assert.rejects(() => batches.approve('math', created[0].id), /已经处理/);
  f.store.close();
});

test('节点之后到达的提交进入下一个节点，不混入当前批次', async () => {
  const { f, batches, now, message } = setup();
  const data = JSON.parse((f.store.db.prepare('SELECT data FROM course_mail_messages WHERE id=?').get(message.id) as { data: string }).data);
  data.receivedAt = now + 3600_000;
  f.store.db.prepare('UPDATE course_mail_messages SET data=? WHERE id=?').run(JSON.stringify(data), message.id);
  assert.equal(batches.tick(now).length, 0);
  assert.equal(batches.list('math').length, 0);
  f.store.close();
});

test('驳回后不改提交、不发回信', async () => {
  const { f, fake, batches, now } = setup();
  const [batch] = batches.tick(now);
  const rejected = batches.reject('math', batch.id);
  assert.equal(rejected.status, 'rejected');
  assert.equal(fake.replies.length, 0);
  await assert.rejects(() => batches.approve('math', batch.id), /已经处理/);
  f.store.close();
});
