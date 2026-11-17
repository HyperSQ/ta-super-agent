import { randomUUID } from 'node:crypto';
import { DomainError } from '../../domain/model.ts';
import type { Event } from '../../domain/model.ts';
import type { TaskEngine } from '../task-engine.ts';
import type { SubmissionFiles } from './submission-files.ts';
import { Academics } from './academics.ts';

type Draft = { assignmentId: string; name: string };
type Request = Draft & {
  id: string; courseId: string; actor: string; eventId: string; kind: 'submission' | 'extension';
  state: 'pending' | 'accepted' | 'declined'; receivedAt: number; revision: number;
  deadline?: string; reason?: string; effectiveDeadline?: string; late?: boolean;
  attempt?: number; files?: { index: number; name: string; bytes: number }[]; decisionNote?: string;
  source?: 'mail'; mailId?: string;
};
const invalid = (message: string) => new DomainError('invalid', message);
const iso = (value: string) => /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
const parse = <T>(data: unknown) => JSON.parse(String(data)) as T;

export class CourseworkIntake {
  private engine: TaskEngine;
  private academics: Academics;
  private submissions?: SubmissionFiles;
  constructor(engine: TaskEngine, submissions?: SubmissionFiles) { this.engine = engine; this.academics = new Academics(engine); this.submissions = submissions; }
  /** 教师把学生 QQ 与名单姓名绑定一次，之后学生可私聊查询自己的提交与成绩。 */
  bind(courseId: string, qq: string, name: string) {
    if (!/^\d{5,12}$/.test(qq)) throw invalid('QQ 号须为 5–12 位数字');
    const course = this.engine.store.course(courseId);
    if (!course) throw new DomainError('not_found', '课程不存在');
    if (!(course.roster ?? []).includes(name)) throw invalid('请使用课程名单上的姓名');
    const actor = 'qq:' + qq;
    return this.engine.store.atomic(() => {
      const db = this.engine.store.db;
      const byActor = db.prepare('SELECT student_name FROM coursework_qq_students WHERE course_id=? AND actor=?')
        .get(courseId, actor) as { student_name?: string } | undefined;
      if (byActor && byActor.student_name !== name) throw new DomainError('conflict', '这个 QQ 已绑定其他姓名，请先核实');
      const byName = db.prepare('SELECT actor FROM coursework_qq_students WHERE course_id=? AND student_name=?')
        .get(courseId, name) as { actor?: string } | undefined;
      if (byName && byName.actor !== actor) throw new DomainError('conflict', '这个姓名已绑定其他 QQ，请先核实');
      db.prepare('INSERT INTO coursework_qq_students VALUES(?,?,?) ON CONFLICT(course_id,actor) DO UPDATE SET student_name=excluded.student_name')
        .run(courseId, actor, name);
      this.engine.store.audit('coursework.bind', { courseId, actor, name });
      return { actor, name };
    });
  }
  /** 学生用自然语言提出延期：由答疑 Worker 调用，进入教师待审批。 */
  requestExtension(event: Event, assignmentId: string, deadline: string, reason: string, name?: string) {
    if (event.actor.role !== 'student' || event.channel.kind !== 'qq-private')
      throw new DomainError('forbidden', '延期申请只能在学生私聊中提交');
    const parsed = iso(deadline);
    if (!parsed) throw invalid('请给出含时区的截止时间，例如 2026-11-22T22:00:00+08:00');
    const assignment = this.academics.visibleAssignment(event.courseId, assignmentId);
    if (Date.parse(parsed) <= Date.parse(assignment.deadline)) throw invalid('申请的时间须晚于全班截止时间');
    if (!reason?.trim() || reason.trim().length > 500) throw invalid('请说明申请理由（最多 500 字）');
    const selected = this.requireName(event, name?.trim() ?? '');
    const db = this.engine.store.db;
    const existing = db.prepare('SELECT data FROM coursework_requests WHERE event_id=?').get(event.id) as { data: string } | undefined;
    if (existing) return parse<Request>(existing.data);
    const duplicate = db.prepare("SELECT data FROM coursework_requests WHERE course_id=? AND assignment_id=? AND student_name=? AND kind='extension' AND state='pending'")
      .get(event.courseId, assignmentId, selected) as { data: string } | undefined;
    if (duplicate) return parse<Request>(duplicate.data);
    return this.engine.store.atomic(() => this.create(event, { assignmentId, name: selected }, 'extension', { deadline: parsed, reason: reason.trim() }));
  }
  private identity(courseId: string, actor: string) {
    const row = this.engine.store.db.prepare('SELECT student_name FROM coursework_qq_students WHERE course_id=? AND actor=?').get(courseId, actor);
    return row ? String(row.student_name) : undefined;
  }
  private requireName(event: Event, name: string) {
    const known = this.identity(event.courseId, event.actor.id);
    if (known && name && name !== known) throw invalid('该 QQ 已关联其他名单姓名，请联系教师核对');
    const selected = known ?? name;
    if (!selected || !this.engine.store.course(event.courseId)?.roster?.includes(selected)) throw invalid('请使用课程名单上的完整姓名');
    return selected;
  }
  async route(event: Event, signal?: AbortSignal): Promise<boolean> {
    if (event.actor.role !== 'student' || event.channel.kind !== 'qq-private') return false;
    const { courseId, id } = event;
    const db = this.engine.store.db;
    const extension = /^\/(?:extension|申请延期)(?:\s+([\s\S]+))?$/iu.exec(event.text);
    const assignmentsCommand = /^\/assignments$/i.test(event.text);
    const submitCommand = /^\/(?:submit|交作业)\b/iu.test(event.text);
    if (!extension && !assignmentsCommand && !submitCommand) return false;
    const reply = (message: string) => this.engine.replyCoursework(event, message);
    if (db.prepare('SELECT id FROM coursework_requests WHERE event_id=?').get(id)) return true;
    try {
      if (submitCommand) {
        // 私信不再接收作业：统一走课程邮箱，避免附件与身份在两处分叉。
        reply('作业请通过课程邮箱提交，私信不再接收作业附件；有疑问可以直接问我。');
      } else if (assignmentsCommand) {
        const rows = this.academics.visibleAssignments(courseId).slice(-10).reverse();
        reply(rows.length ? rows.map(a => `${a.title}  截止 ${a.deadline}\nID ${a.id}`).join('\n\n') : '当前没有已发布作业。');
      } else if (extension) {
        const [selection, nameLine, reason] = extension[1]?.split(/\r?\n/, 3) ?? [];
        const [assignmentId, date] = selection?.trim().split(/\s+/) ?? [];
        const deadline = date && iso(date);
        if (!assignmentId || !deadline || !nameLine?.trim() || !reason?.trim() || reason.length > 500)
          throw invalid('格式：/extension 作业ID ISO截止时间（含时区），下一行写名单姓名，再下一行写原因。');
        const record = this.requestExtension(event, assignmentId, deadline, reason.trim(), nameLine.trim());
        reply('延期申请已登记，等待老师审批。编号 ' + record.id);
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof DomainError)) throw error;
      reply(error.message);
    }
    return true;
  }

  private create(event: Event, draft: Draft, kind: Request['kind'], fields: Partial<Request>): Request {
    const row: Request = { ...draft, ...fields, id: randomUUID(), courseId: event.courseId, actor: event.actor.id, eventId: event.id,
      kind, state: 'pending', receivedAt: fields.receivedAt ?? event.receivedAt, revision: 1 };
    this.engine.store.db.prepare('INSERT INTO coursework_requests VALUES(?,?,?,?,?,?,?,?,?)')
      .run(row.id, row.courseId, row.assignmentId, row.kind, row.state, row.actor, row.name, row.eventId, JSON.stringify(row));
    return row;
  }
  private save(row: Request) {
    this.engine.store.db.prepare('UPDATE coursework_requests SET state=?, data=? WHERE id=?').run(row.state, JSON.stringify(row), row.id);
  }
  private acceptSubmission(row: Request): void {
    const status = this.academics.extensions('web:admin', row.assignmentId);
    row.effectiveDeadline = status.students.find(student => student.studentName === row.name)?.effectiveDeadline ?? status.deadline;
    row.late = row.receivedAt > Date.parse(row.effectiveDeadline);
    const previous = this.engine.store.db.prepare(`SELECT count(*) AS total FROM coursework_requests
      WHERE assignment_id=? AND kind='submission' AND state='accepted' AND student_name=?`).get(row.assignmentId, row.name);
    row.attempt = Number(previous?.total ?? 0) + 1;
    row.state = 'accepted';
    this.save(row);
  }
  registerMail(courseId: string, mail: { id: string; receivedAt: number },
    assignmentId: string, name: string, files: { name: string; bytes: Buffer }[]) {
    this.academics.visibleAssignment(courseId, assignmentId);
    if (!this.engine.store.course(courseId)?.roster?.includes(name)) throw invalid('请选择本课程名单中的学生');
    const key = 'mail-submission:' + mail.id;
    return this.engine.store.atomic(() => {
      const { event, duplicate } = this.engine.receive({
        sourceKey: key, externalId: key, courseId, threadId: key, actorId: 'web:admin',
        channel: { kind: 'management', target: 'admin' }, text: '教师已核对的邮件作业',
        receivedAt: mail.receivedAt,
      }, true);
      if (duplicate) throw new DomainError('conflict', '这封邮件已经登记');
      const row = this.create(event, { assignmentId, name }, 'submission', {
        source: 'mail', mailId: mail.id, files: files.map((file, i) => ({ index: i + 1, name: file.name, bytes: file.bytes.length })),
      });
      files.forEach((file, i) => {
        const position = i + 1;
        if (this.submissions) this.submissions.save(row.id, position, file.name, file.bytes);
        this.engine.store.db.prepare('INSERT INTO coursework_submission_files VALUES(?,?,?,?)')
          .run(row.id, position, file.name, this.submissions ? Buffer.alloc(0) : file.bytes);
      });
      this.acceptSubmission(row);
      return row;
    });
  }
  list(courseId: string) {
    if (!this.engine.store.course(courseId)) throw new DomainError('not_found', '课程不存在');
    const db = this.engine.store.db;
    const requests = db.prepare('SELECT data FROM coursework_requests WHERE course_id=? ORDER BY rowid DESC LIMIT 300').all(courseId)
      .map(row => parse<Request>(row.data));
    const offline = this.academics.assignments(courseId).slice(-30).flatMap(assignment => this.academics.offline(assignment.id));
    return { requests, offline };
  }
  file(courseId: string, requestId: string, index: number) {
    const fromDisk = this.submissions?.read(requestId, index);
    if (fromDisk) return { name: fromDisk.name, data: fromDisk.content.toString('base64') };
    const item = this.engine.store.db.prepare(`SELECT f.name,f.content FROM coursework_submission_files f
      JOIN coursework_requests r ON f.request_id=r.id WHERE r.course_id=? AND f.request_id=? AND f.position=?`).get(courseId, requestId, index);
    if (!item || !(item.content instanceof Uint8Array)) throw new DomainError('not_found', '未找到该提交附件');
    return { name: String(item.name), data: Buffer.from(item.content).toString('base64') };
  }
  review(courseId: string, id: string, revision: number, accept: boolean, note: string) {
    return this.engine.store.atomic(() => {
      const db = this.engine.store.db;
      const saved = db.prepare('SELECT data FROM coursework_requests WHERE course_id=? AND id=?').get(courseId, id);
      if (!saved) throw new DomainError('not_found', '申请不属于本课程');
      const row = parse<Request>(saved.data);
      if (row.state !== 'pending' || row.revision !== revision) throw new DomainError('stale', '申请已处理，请刷新');
      const event = this.engine.store.event(row.eventId);
      if (!event || event.courseId !== courseId || event.actor.id !== row.actor || event.channel.kind !== 'qq-private') throw invalid('缺少学生的原始私信');
      if (accept) {
        const name = this.requireName(event, row.name);
        const bound = db.prepare('SELECT actor FROM coursework_qq_students WHERE course_id=? AND student_name=?').get(courseId, name);
        if (bound && bound.actor !== row.actor) throw new DomainError('conflict', '该姓名已关联其他 QQ，请先人工核实');
        db.prepare('INSERT OR IGNORE INTO coursework_qq_students VALUES(?,?,?)').run(courseId, row.actor, name);
        if (row.kind === 'extension') {
          const current = this.academics.extensions('web:admin', row.assignmentId);
          const student = current.students.find(item => item.studentName === row.name);
          if (!student || !row.deadline) throw invalid('延期申请数据无效');
          if (student.deadline && Date.parse(student.deadline) > Date.parse(row.deadline)) throw new DomainError('conflict', '该生已获更长延期');
          this.academics.setExtension('web:admin', row.assignmentId, row.name, {
            deadline: row.deadline, reason: note || row.reason || '', revision: student.revision, assignmentRevision: current.assignmentRevision,
          });
          row.state = 'accepted';
        } else this.acceptSubmission(row);
      } else row.state = 'declined';
      row.revision++;
      row.decisionNote = note;
      this.save(row);
      const key = 'coursework-review:' + id;
      const { event: notice } = this.engine.receive({ sourceKey: key, externalId: key, courseId, threadId: event.threadId,
        channel: event.channel, actorId: event.actor.id, text: '作业申请结果', courseworkNotice: true, receivedAt: this.engine.now() });
      const title = this.academics.assignment(row.assignmentId).title;
      this.engine.replyCoursework(notice, `「${title}」${row.kind === 'extension' ? '延期申请' : '作业提交'}${accept ? '已通过' : '未通过'}。${
        accept && row.kind === 'extension' ? '个人截止时间：' + row.deadline + '。' : ''}${note ? '教师备注：' + note : ''}`);
      return row;
    });
  }
}
