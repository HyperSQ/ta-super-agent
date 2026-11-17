import { randomUUID } from 'node:crypto';
import { DomainError } from '../../domain/model.ts';
import type { Assignment, AssignmentImage, OfflineSubmission } from '../../domain/model.ts';
import { TaskEngine } from '../task-engine.ts';

export class Academics {
  engine: TaskEngine;
  constructor(engine: TaskEngine) { this.engine = engine; }
  assignments(courseId: string): Assignment[] {
    if (!this.engine.store.course(courseId)) throw new DomainError('not_found', '课程不存在');
    return this.engine.store.db.prepare("SELECT json_remove(data,'$.images') AS data FROM coursework_assignments WHERE course_id=? ORDER BY rowid").all(courseId).map(r => JSON.parse(String(r.data)));
  }
  assignment(id: string): Assignment {
    const row = this.engine.store.db.prepare('SELECT data FROM coursework_assignments WHERE id=?').get(id);
    if (!row) throw new DomainError('not_found', '作业不存在');
    return JSON.parse(String(row.data));
  }
  saveAssignment(actorId: string, value: { id?: string; courseId: string; title: string; instructions: string; deadline: string; gradingPolicy: string; revision?: number; images?: unknown; studentVisible?: boolean }): Assignment {
    this.authorize(actorId);
    const images = value.images === undefined ? undefined : this.images(value.images);
    return this.engine.store.atomic(() => {
      if (!this.engine.store.course(value.courseId)) throw new DomainError('not_found', '课程不存在');
      const old = value.id ? this.assignment(value.id) : undefined;
      if (old && (old.courseId !== value.courseId || old.revision !== value.revision)) throw new DomainError('stale', '作业已修改，请刷新后保存');
      const deadline = this.date(value.deadline);
      const result: Assignment = { ...value, images: images ?? old?.images ?? [], studentVisible: value.studentVisible ?? old?.studentVisible ?? false,
        id: old?.id ?? randomUUID(), deadline, revision: (old?.revision ?? 0) + 1, createdAt: old?.createdAt ?? new Date().toISOString() };
      this.engine.store.db.prepare('INSERT INTO coursework_assignments(id,course_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(result.id, result.courseId, JSON.stringify(result));
      const summary = ({ images, ...assignment }: Assignment) => ({ ...assignment, images: images?.map(image => image.name) });
      this.engine.store.audit('assignment.saved', { actorId, before: old && summary(old), after: summary(result) });
      return result;
    });
  }
  visibleAssignments(courseId: string): Pick<Assignment, 'id' | 'title' | 'deadline' | 'revision'>[] {
    return this.assignments(courseId).filter(a => a.studentVisible === true)
      .map(({ id, title, deadline, revision }) => ({ id, title, deadline, revision }));
  }
  visibleAssignment(courseId: string, id: string): Assignment {
    const row = this.engine.store.db.prepare("SELECT data FROM coursework_assignments WHERE course_id=? AND id=? AND json_extract(data,'$.studentVisible')=1").get(courseId, id);
    if (!row) throw new DomainError('not_found', '未找到本课程学生可见的这份作业');
    return JSON.parse(String(row.data));
  }
  extensions(actorId: string, assignmentId: string) {
    this.authorize(actorId);
    const assignment = this.assignment(assignmentId);
    const roster = this.engine.store.course(assignment.courseId)?.roster ?? [];
    const extensions = this.engine.store.db.prepare(
      'SELECT student_name AS studentName, deadline, reason, revision FROM assignment_extensions WHERE assignment_id=?',
    ).all(assignmentId);
    const saved = new Map(extensions.map(row => [String(row.studentName), row]));
    return {
      deadline: assignment.deadline,
      assignmentRevision: assignment.revision,
      students: [...new Set([...roster, ...extensions.filter(row => row.deadline).map(row => String(row.studentName))])].map(studentName => {
        const row = saved.get(studentName);
        const deadline = row?.deadline ? String(row.deadline) : null;
        return { studentName, deadline, reason: String(row?.reason ?? ''), revision: Number(row?.revision ?? 0),
          effectiveDeadline: deadline && Date.parse(deadline) > Date.parse(assignment.deadline) ? deadline : assignment.deadline };
      }),
    };
  }
  setExtension(actorId: string, assignmentId: string, studentName: string, value: { deadline: string | null; reason: string; revision: number; assignmentRevision: number }) {
    this.authorize(actorId);
    return this.engine.store.atomic(() => {
      const before = this.extensions(actorId, assignmentId);
      const old = before.students.find(student => student.studentName === studentName);
      if (!old) throw new DomainError('not_found', '该学生不在这门课的名单或延期记录中');
      if (before.assignmentRevision !== value.assignmentRevision || old.revision !== value.revision) throw new DomainError('stale', '作业或延期记录已修改，请刷新');
      const deadline = value.deadline === null ? null : this.date(value.deadline);
      if (deadline && Date.parse(deadline) <= Date.parse(before.deadline)) throw new DomainError('invalid', '个人截止时间须晚于全班截止时间');
      if (!deadline && !old.deadline) throw new DomainError('conflict', '该学生没有待撤销的延期');
      const reason = deadline ? value.reason.trim() : '';
      if (reason.length > 500) throw new DomainError('invalid', '延期备注最多 500 字');
      this.engine.store.db.prepare(`INSERT INTO assignment_extensions (assignment_id,student_name,deadline,reason,revision) VALUES (?,?,?,?,?)
        ON CONFLICT(assignment_id,student_name) DO UPDATE SET deadline=excluded.deadline,reason=excluded.reason,revision=excluded.revision`)
        .run(assignmentId, studentName, deadline, reason, old.revision + 1);
      this.engine.store.audit(deadline ? 'extension.saved' : 'extension.revoked', { actorId, assignmentId, studentName, previous: old, deadline, reason });
      return this.extensions(actorId, assignmentId);
    });
  }
  offline(assignmentId: string): OfflineSubmission[] {
    this.assignment(assignmentId);
    return this.engine.store.db.prepare('SELECT data FROM offline_submissions WHERE assignment_id=? ORDER BY student_name').all(assignmentId).map(r => {
      const { studentName, score, registeredAt, revision, actorId } = JSON.parse(String(r.data)) as OfflineSubmission;
      return { assignmentId, studentName, score, registeredAt, revision, actorId };
    });
  }
  register(actorId: string, assignmentId: string, students: { name: string; revision: number; score: number }[]): OfflineSubmission[] {
    this.authorize(actorId);
    if (!students.length || students.length > 500 || new Set(students.map(s => s.name)).size !== students.length || students.some(s => !s.name.trim() || s.name.length > 100 || !Number.isSafeInteger(s.revision) || s.revision < 0)) throw new DomainError('invalid', '姓名须唯一，单次1至500人，需提供登记版本');
    if (students.some(s => !Number.isFinite(s.score) || s.score < 0)) throw new DomainError('invalid', '分数须为非负数字');
    return this.engine.store.atomic(() => {
      const existing = new Map(this.offline(assignmentId).map(s => [s.studentName, s]));
      const records = students.map(s => {
        const name = s.name.trim(), old = existing.get(name);
        if ((old?.revision ?? 0) !== s.revision) throw new DomainError('stale', `${name}的登记已变化，请刷新`);
        return { assignmentId, studentName: name, score: s.score, registeredAt: new Date().toISOString(), revision: s.revision + 1, actorId };
      });
      if (new Set(records.map(r => r.studentName)).size !== records.length) throw new DomainError('invalid', '姓名去除空格后重复');
      for (const record of records) this.writeOffline(record);
      this.engine.store.audit('offline.registered', { actorId, records, previous: records.map(r => existing.get(r.studentName)) });
      return records;
    });
  }
  remove(actorId: string, assignmentId: string, name: string, revision: number): void {
    this.authorize(actorId);
    this.engine.store.atomic(() => {
      const record = this.offline(assignmentId).find(s => s.studentName === name);
      if (!record) throw new DomainError('not_found', '登记不存在');
      if (record.revision !== revision) throw new DomainError('stale', '登记已变化，请刷新');
      this.engine.store.db.prepare('DELETE FROM offline_submissions WHERE assignment_id=? AND student_name=?').run(assignmentId, name);
      this.engine.store.audit('offline.removed', { actorId, record });
    });
  }
  private writeOffline(record: OfflineSubmission): void {
    this.engine.store.db.prepare('INSERT INTO offline_submissions(assignment_id,student_name,data) VALUES(?,?,?) ON CONFLICT(assignment_id,student_name) DO UPDATE SET data=json_patch(offline_submissions.data,excluded.data)').run(record.assignmentId, record.studentName, JSON.stringify(record));
  }
  private images(value: unknown): AssignmentImage[] {
    if (!Array.isArray(value) || value.length > 3) throw new DomainError('invalid', '一份作业最多添加 3 张图片');
    return value.map(image => {
      if (!image || typeof image.name !== 'string' || !image.name.trim() || image.name.length > 255 || typeof image.dataUrl !== 'string' || image.dataUrl.length > 1048608) {
        throw new DomainError('invalid', '每张图片不得超过 768 KB');
      }
      const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.dataUrl);
      if (!match) throw new DomainError('invalid', '图片须为 PNG、JPEG 或 WebP');
      const bytes = Buffer.from(match[2], 'base64');
      const valid = match[1] === 'png' ? bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
        : match[1] === 'jpeg' ? bytes.subarray(0, 3).toString('hex') === 'ffd8ff'
        : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
      if (!valid || bytes.length > 768 * 1024 || bytes.toString('base64') !== match[2]) throw new DomainError('invalid', '图片内容或大小无效');
      return { name: image.name.trim(), dataUrl: image.dataUrl };
    });
  }
  private authorize(id: string): void { if (!this.engine.policy.isTeacher(id)) throw new DomainError('forbidden', '仅教师可编辑课程与登记'); }
  private date(value: string): string { if (!/(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new DomainError('invalid', '时间须包含时区'); return new Date(value).toISOString(); }
}
