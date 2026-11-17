import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { DomainError } from '../../domain/model.ts';
import type { TaskEngine } from '../task-engine.ts';
import { CourseworkIntake } from './coursework-intake.ts';
import type { SubmissionFiles } from './submission-files.ts';
import { rubric } from './grading-draft.ts';
import type { GradeDraft } from './grading-draft.ts';
import { Academics } from './academics.ts';
import type { Event } from '../../domain/model.ts';
import type { MailSettings, MailCredentials, MailCursor, ReceivedMail, MailTransport } from '../../adapters/mail/transport.ts';

type Message = Omit<ReceivedMail, 'uid' | 'files'> & {
  id: string; mailbox: string; files: { index: number; name: string; bytes: number }[];
  state: 'pending' | 'registered' | 'ignored'; submissionId?: string;
  feedback?: { state: 'sending' | 'sent' | 'unknown'; at: number };
  suggestion?: MailSuggestion;
  grade?: { assignmentRevision: number; submissionId: string; draft: GradeDraft };
  gradingEventId?: string;
};
export type MailSuggestion = {
  assignment?: { id: string; title: string; revision: number };
  studentName?: string;
  evidence: string[];
};
type Status = { at?: number; error?: string };
const invalid = (message: string) => new DomainError('invalid', message);
const parse = <T>(data: unknown): T => JSON.parse(String(data));
const digest = (items: unknown[]) => createHash('sha256').update(JSON.stringify(items)).digest('hex');
const addressPattern = /^[A-Za-z0-9.!#$%&'*+/=?^_{}|~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/;
const hostPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const endpoints = (s: MailSettings) => JSON.stringify([s.address, s.imapHost, s.imapPort, s.smtpHost, s.smtpPort, s.smtpMode]);

export function mailKey(path: string): Buffer {
  if (path === ':memory:') return randomBytes(32);
  const name = path + '.mail-key';
  try { writeFileSync(name, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; }
  const key = readFileSync(name);
  if (key.length !== 32) throw Error('邮箱凭据密钥文件长度无效');
  return key;
}

export class CourseMail {
  private active = new Map<string, Promise<unknown>>();
  private timer?: ReturnType<typeof setInterval>;
  private coursework: CourseworkIntake;
  private engine: TaskEngine;
  private transport: MailTransport;
  private key: Buffer;
  constructor(engine: TaskEngine, transport: MailTransport, key: Buffer, submissions?: SubmissionFiles) {
    this.engine = engine;
    this.transport = transport;
    this.key = key;
    this.coursework = new CourseworkIntake(engine, submissions);
  }
  private get db() { return this.engine.store.db; }
  private course(id: string) {
    const course = this.engine.store.course(id);
    if (!course) throw new DomainError('not_found', '课程不存在');
    return course;
  }
  private row(id: string) {
    return this.db.prepare('SELECT mailbox_key,data,secret,cursor,status FROM course_mailboxes WHERE course_id=?').get(id);
  }
  private seal(courseId: string, password: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv).setAAD(Buffer.from(courseId));
    return Buffer.concat([iv, cipher.update(password), cipher.final(), cipher.getAuthTag()]).toString('base64');
  }
  private open(id: string, row: NonNullable<ReturnType<CourseMail['row']>>): MailCredentials {
    const value = Buffer.from(String(row.secret), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, value.subarray(0, 12)).setAAD(Buffer.from(id));
    decipher.setAuthTag(value.subarray(-16));
    return { ...parse<MailSettings>(row.data), password: Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString() };
  }
  get(id: string) {
    const course = this.course(id);
    const row = this.row(id);
    const messages = this.db.prepare("SELECT data FROM course_mail_messages WHERE course_id=? ORDER BY (json_extract(data,'$.state')='pending') DESC,received_at DESC,rowid DESC LIMIT 50").all(id)
      .map(row => { const { text, messageId, mailbox, grade, ...item } = parse<Message>(row.data); return { ...item, preview: text.slice(0, 400) }; });
    return { settings: row ? parse<MailSettings>(row.data) : null, status: row ? parse<Status>(row.status) : {}, messages, roster: course.roster ?? [] };
  }
  save(id: string, input: Record<string, unknown>) {
    this.course(id);
    if (this.active.has(id)) throw new DomainError('conflict', '邮箱操作进行中，请稍后保存');
    const old = this.row(id), previous = old && parse<MailSettings>(old.data);
    if (input.revision !== (previous?.revision ?? 0)) throw new DomainError('stale', '邮箱配置已变更，请刷新');
    const field = (name: string, limit: number) => {
      const value = input[name];
      if (typeof value !== 'string' || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) throw invalid('无效邮箱配置：' + name);
      return value.trim();
    };
    const port = (name: string) => {
      const value = input[name];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) throw invalid('无效邮箱端口');
      return value;
    };
    const address = field('address', 254), imapHost = field('imapHost', 253).toLowerCase(), smtpHost = field('smtpHost', 253).toLowerCase();
    const folder = field('folder', 128), prefix = field('prefix', 100), password = field('password', 400);
    const { enabled, smtpMode } = input;
    if (!addressPattern.test(address) || !hostPattern.test(imapHost) || !hostPattern.test(smtpHost)) throw invalid('请输入完整邮箱地址和服务器域名');
    if (!/^[\x20-\x7e]+$/.test(folder) || /["\\]/.test(folder) || !prefix) throw invalid('请填写邮箱文件夹和作业邮件主题前缀');
    if (typeof enabled !== 'boolean' || (smtpMode !== 'tls' && smtpMode !== 'starttls')) throw invalid('请选择轮询状态和发件加密方式');
    const settings: MailSettings = {
      address, imapHost, imapPort: port('imapPort'), folder, smtpHost, smtpPort: port('smtpPort'), smtpMode, prefix, enabled,
      revision: (previous?.revision ?? 0) + 1, since: previous?.since ?? this.engine.now(),
    };
    if (!password && (!previous || endpoints(settings) !== endpoints(previous))) throw invalid('首次设置或更换服务器、邮箱时，请填写客户端专用密码');
    const key = digest([address.toLowerCase(), imapHost, settings.imapPort, folder.toUpperCase()]);
    const same = key === old?.mailbox_key && prefix === previous?.prefix;
    if (!same) settings.since = this.engine.now();
    const conflict = this.db.prepare('SELECT course_id FROM course_mailboxes WHERE mailbox_key=? AND course_id<>?').get(key, id);
    if (conflict) throw invalid('已有课程使用同一邮箱文件夹，请为课程使用不同文件夹或邮箱');
    this.db.prepare('INSERT INTO course_mailboxes(course_id,mailbox_key,data,secret,cursor,status) VALUES(?,?,?,?,?,?) ' +
      'ON CONFLICT(course_id) DO UPDATE SET mailbox_key=excluded.mailbox_key,data=excluded.data,secret=excluded.secret,cursor=excluded.cursor,status=excluded.status')
      .run(id, key, JSON.stringify(settings), password ? this.seal(id, password) : String(old!.secret), same ? String(old!.cursor) : '{}', '{}');
    return this.get(id);
  }
  private exclusive<T>(id: string, work: () => Promise<T>) {
    if (this.active.has(id)) throw new DomainError('conflict', '该课程邮箱操作正在进行');
    const result = Promise.resolve().then(work).finally(() => this.active.delete(id));
    this.active.set(id, result);
    return result;
  }
  private configured(id: string) {
    const row = this.row(id);
    if (!row) throw invalid('请先保存邮箱配置');
    return row;
  }
  check(id: string) {
    return this.exclusive(id, async () => {
      await this.transport.check(this.open(id, this.configured(id)));
      return { ok: true };
    });
  }
  sync(id: string) {
    return this.exclusive(id, async () => {
      const row = this.configured(id);
      const settings = this.open(id, row);
      try {
        const page = await this.transport.fetch(settings, parse<MailCursor>(row.cursor));
        this.engine.store.atomic(() => {
          for (const mail of page.messages) this.archive(id, String(row.mailbox_key), mail, page.cursor);
          this.db.prepare('UPDATE course_mailboxes SET cursor=?,status=? WHERE course_id=?')
            .run(JSON.stringify(page.cursor), JSON.stringify({ at: this.engine.now() }), id);
        });
        return this.get(id);
      } catch (error) {
        this.db.prepare('UPDATE course_mailboxes SET status=? WHERE course_id=?')
          .run(JSON.stringify({ at: this.engine.now(), error: error instanceof DomainError ? error.message : '收件失败，进度未推进。' }), id);
        throw error;
      }
    });
  }
  private archive(courseId: string, mailbox: string, mail: ReceivedMail, cursor: MailCursor) {
    const id = randomUUID(), { uid, files, ...info } = mail;
    const key = digest(mail.messageId ? [mailbox, mail.from.toLowerCase(), mail.messageId, mail.subject] : [mailbox, cursor.validity, uid]);
    const copies = files.map(file => ({ name: file.name, bytes: Buffer.from(file.content, 'base64') }));
    const message: Message = { ...info, id, mailbox, state: 'pending',
      files: copies.map((file, i) => ({ index: i + 1, name: file.name, bytes: file.bytes.length })) };
    if (!this.db.prepare('INSERT OR IGNORE INTO course_mail_messages VALUES(?,?,?,?,?)')
      .run(id, courseId, key, mail.receivedAt, JSON.stringify(message)).changes) return;
    copies.forEach((file, i) => this.db.prepare('INSERT INTO course_mail_files VALUES(?,?,?,?)').run(id, i + 1, file.name, file.bytes));
    const eventKey = 'course-mail:received:' + id;
    this.engine.receive({ sourceKey: eventKey, externalId: eventKey, threadId: eventKey, courseId, actorId: 'web:admin',
      channel: { kind: 'management', target: 'course-mail' }, text: '收到新的作业邮件',
      receivedAt: mail.receivedAt, mailIntake: { messageId: id } });
  }
  private message(course: string, id: string) {
    const row = this.db.prepare('SELECT data FROM course_mail_messages WHERE course_id=? AND id=?').get(course, id);
    if (!row) throw new DomainError('not_found', '邮件不存在或不属于此课程');
    return parse<Message>(row.data);
  }
  read(course: string, id: string) {
    const original = this.message(course, id);
    const { mailbox, messageId, ...message } = original;
    const task = message.gradingEventId && this.engine.store.tasks().find(t => t.grant.originEventId === message.gradingEventId);
    const grading = task ? { status: task.status, error: task.error } : message.gradingEventId ? { status: 'queued' } : undefined;
    const grade = message.grade && this.gradeIsCurrent(course, original, message.grade.assignmentRevision) ? message.grade : undefined;
    return { ...message, grade, grading };
  }
  private submission(course: string, message: Message) {
    if (!message.submissionId || message.state !== 'registered') throw invalid('请先确认邮件所属作业和学生');
    const row = this.db.prepare("SELECT id,assignment_id,student_name,data FROM coursework_requests WHERE course_id=? AND id=? AND state='accepted'")
      .get(course, message.submissionId);
    if (!row) throw invalid('找不到已登记的提交');
    const newest = this.db.prepare("SELECT id FROM coursework_requests WHERE course_id=? AND assignment_id=? AND student_name=? AND kind='submission' AND state='accepted' " +
      "ORDER BY json_extract(data,'$.receivedAt') DESC,rowid DESC LIMIT 1").get(course, row.assignment_id, row.student_name);
    if (newest?.id !== row.id) throw new DomainError('conflict', '该学生已有更新的提交，请处理最新版本');
    return row;
  }
  private gradeIsCurrent(course: string, message: Message, revision: number) {
    try {
      const submission = this.submission(course, message);
      return new Academics(this.engine).visibleAssignment(course, String(submission.assignment_id)).revision === revision;
    } catch { return false; }
  }
  requestGrade(course: string, id: string) {
    return this.engine.store.atomic(() => {
      const message = this.message(course, id), submission = this.submission(course, message);
      const assignment = new Academics(this.engine).visibleAssignment(course, String(submission.assignment_id));
      rubric(assignment.gradingPolicy);
      const current = message.gradingEventId && this.engine.store.tasks().find(t => t.grant.originEventId === message.gradingEventId);
      if (current && ['queued', 'running'].includes(current.status)) return this.read(course, id);
      if (message.grade && this.gradeIsCurrent(course, message, message.grade.assignmentRevision)) return this.read(course, id);
      const key = 'course-mail:grade:' + randomUUID();
      const { event } = this.engine.receive({ sourceKey: key, externalId: key, threadId: key, courseId: course, actorId: 'web:admin',
        channel: { kind: 'management', target: 'course-mail' }, text: '教师请求生成批改草稿', receivedAt: this.engine.now(),
        mailIntake: { messageId: id, grade: { submissionId: String(submission.id), assignmentId: assignment.id, assignmentRevision: assignment.revision } } });
      this.engine.createTask(event.id, 'coursework', '逐题生成邮件作业批改草稿');
      this.update({ ...message, gradingEventId: event.id });
      return this.read(course, id);
    });
  }
  gradingInput(event: Event) {
    const spec = event.mailIntake;
    if (!spec?.grade) throw invalid('缺少批改请求标识');
    const message = this.message(event.courseId, spec.messageId), submission = this.submission(event.courseId, message);
    const assignment = new Academics(this.engine).visibleAssignment(event.courseId, spec.grade.assignmentId);
    if (message.gradingEventId !== event.id || submission.id !== spec.grade.submissionId ||
      submission.assignment_id !== assignment.id || assignment.revision !== spec.grade.assignmentRevision)
      throw new DomainError('conflict', '批改请求关联的作业或提交已有变化，请重新生成草稿');
    const files = this.db.prepare('SELECT name,content FROM course_mail_files WHERE mail_id=? ORDER BY position').all(message.id)
      .map(row => ({ name: String(row.name), bytes: Buffer.from(row.content as Uint8Array) }));
    return { message, text: message.text, files, assignment, criteria: rubric(assignment.gradingPolicy) };
  }
  batchCandidates(course: string, nodeAt: number) {
    const rows = this.db.prepare('SELECT data FROM course_mail_messages WHERE course_id=?').all(course) as { data: string }[];
    const out: { id: string; subject: string; from: string; receivedAt: number; submissionId: string;
      assignmentId: string; assignmentTitle: string; studentName: string; draft: GradeDraft }[] = [];
    for (const row of rows) {
      const message = parse<Message>(row.data);
      if (message.state !== 'registered' || message.feedback || !message.grade || !message.submissionId || message.receivedAt > nodeAt) continue;
      if (!this.gradeIsCurrent(course, message, message.grade.assignmentRevision)) continue;
      const submission = this.db.prepare("SELECT assignment_id,student_name FROM coursework_requests WHERE course_id=? AND id=? AND state='accepted'")
        .get(course, message.submissionId) as { assignment_id: string; student_name: string } | undefined;
      if (!submission) continue;
      const assignment = this.db.prepare("SELECT json_extract(data,'$.title') AS title FROM coursework_assignments WHERE course_id=? AND id=?")
        .get(course, submission.assignment_id) as { title?: string } | undefined;
      out.push({ id: message.id, subject: message.subject, from: message.from, receivedAt: message.receivedAt,
        submissionId: message.submissionId!, assignmentId: String(submission.assignment_id), assignmentTitle: String(assignment?.title ?? ''),
        studentName: String(submission.student_name), draft: message.grade.draft });
    }
    return out;
  }
  saveGrade(event: Event, draft: GradeDraft) {
    const { message, assignment } = this.gradingInput(event);
    this.update({ ...message, grade: { assignmentRevision: assignment.revision, submissionId: message.submissionId!, draft } });
  }
  suggest(course: string, id: string, suggestion: MailSuggestion) {
    const message = this.message(course, id);
    if (message.state === 'pending') this.update({ ...message, suggestion });
  }
  file(course: string, id: string, index: number) {
    this.message(course, id);
    const row = this.db.prepare('SELECT name,content FROM course_mail_files WHERE mail_id=? AND position=?').get(id, index);
    if (!row || !(row.content instanceof Uint8Array)) throw new DomainError('not_found', '邮件附件不存在');
    return { name: String(row.name), data: Buffer.from(row.content).toString('base64') };
  }
  private update(message: Message) {
    this.db.prepare('UPDATE course_mail_messages SET data=? WHERE id=?').run(JSON.stringify(message), message.id);
  }
  review(course: string, id: string, assignment: string, name: string, ignore: boolean) {
    return this.engine.store.atomic(() => {
      const message = this.message(course, id);
      if (message.state !== 'pending') throw new DomainError('stale', '这封邮件已经处理');
      if (ignore) message.state = 'ignored';
      else {
        if (message.issue) throw invalid('这封邮件的内容不完整，请核对原邮件后向学生索取完整版本');
        const files = this.db.prepare('SELECT name,content FROM course_mail_files WHERE mail_id=? ORDER BY position').all(id)
          .map(row => ({ name: String(row.name), bytes: Buffer.from(row.content as Uint8Array) }));
        if (files.length === 0 && message.text.trim()) files.push({ name: '邮件正文.txt', bytes: Buffer.from(message.text) });
        const submission = this.coursework.registerMail(course, message, assignment, name, files);
        message.submissionId = submission.id;
        message.state = 'registered';
      }
      this.update(message);
      return this.get(course);
    });
  }
  reply(course: string, id: string, text: string) {
    if (!text.trim() || text.length > 12000) throw invalid('请输入反馈内容（最多 12,000 字）');
    return this.exclusive(course, async () => {
      const message = this.message(course, id), row = this.configured(course);
      if (message.state !== 'registered' || message.feedback) throw new DomainError('conflict', '邮件未登记或已有反馈发送记录');
      if (message.grade && !this.gradeIsCurrent(course, message, message.grade.assignmentRevision))
        throw new DomainError('stale', '这份批改草稿已过期，请处理最新提交或重新批改');
      if (!addressPattern.test(message.from) || message.mailbox !== row.mailbox_key) throw invalid('发件地址无效或当前邮箱与原收件邮箱不一致');
      const credentials = this.open(course, row);
      message.feedback = { state: 'sending', at: this.engine.now() };
      this.update(message);
      try {
        await this.transport.reply(credentials, { to: message.from, subject: message.subject, text, parent: message.messageId,
          id: '<ta-' + message.id + '@' + credentials.address.split('@')[1] + '>' });
      } catch (error) {
        message.feedback.state = 'unknown';
        this.update(message);
        throw error;
      }
      message.feedback.state = 'sent';
      this.update(message);
      return this.get(course);
    });
  }
  start() {
    if (this.timer) return;
    this.db.prepare("UPDATE course_mail_messages SET data=json_set(data,'$.feedback.state','unknown') WHERE json_extract(data,'$.feedback.state')='sending'").run();
    this.timer = setInterval(() => {
      if (this.active.size) return;
      const row = this.db.prepare("SELECT course_id FROM course_mailboxes WHERE json_extract(data,'$.enabled')=1 " +
        "ORDER BY coalesce(json_extract(status,'$.at'),0),course_id LIMIT 1").get();
      if (row) void this.sync(String(row.course_id)).catch(() => {});
    }, 30_000);
    this.timer.unref();
  }
  async stop() { clearInterval(this.timer); this.timer = undefined; await Promise.allSettled(this.active.values()); }
}
