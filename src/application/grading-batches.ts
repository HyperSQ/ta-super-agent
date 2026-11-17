import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain/model.ts';
import type { TaskEngine } from './task-engine.ts';
import type { CourseMail } from './services/course-mail.ts';
import { teacherContact } from './services/teacher-inquiry.ts';

export type BatchItem = {
  messageId: string; studentName: string; assignmentId: string; assignmentTitle: string;
  subject: string; receivedAt: number; total: number; maximum: number;
  points: { id: string; score: number; max: number; comment: string }[];
};
export type GradingBatch = {
  id: string; courseId: string; nodeAt: number; status: 'pending' | 'approved' | 'rejected';
  items: BatchItem[]; createdAt: number; approvedAt?: number; sent?: number; failed?: string[];
};
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;

/**
 * 每个作业截止时间是一个审核节点。节点到点后，把节点前所有已批改、
 * 尚未回信的提交（跨作业）累积成一批，教师一次审核，程序统一回信。
 */
export class GradingBatches {
  private engine: TaskEngine;
  private mail: CourseMail;
  constructor(engine: TaskEngine, mail: CourseMail) { this.engine = engine; this.mail = mail; }

  list(courseId: string): GradingBatch[] {
    return (this.engine.store.db.prepare('SELECT data FROM grading_batches WHERE course_id=? ORDER BY node_at DESC, created_at DESC')
      .all(courseId) as { data: string }[]).map(row => parse<GradingBatch>(row.data));
  }

  batch(courseId: string, id: string): GradingBatch {
    const row = this.engine.store.db.prepare('SELECT data FROM grading_batches WHERE course_id=? AND id=?').get(courseId, id) as { data: string } | undefined;
    if (!row) throw new DomainError('not_found', '批改批次不存在');
    return parse<GradingBatch>(row.data);
  }

  /** 运行时每拍调用；同一节点只处理一次，没有可审的提交就只记节点。 */
  tick(now = this.engine.now()): GradingBatch[] {
    const created: GradingBatch[] = [];
    for (const course of this.engine.store.courses()) {
      const assignments = this.engine.store.db.prepare(
        "SELECT id,json_extract(data,'$.deadline') AS deadline FROM coursework_assignments WHERE course_id=?").all(course.id) as { id: string; deadline: string }[];
      for (const assignment of assignments) {
        const nodeAt = Date.parse(assignment.deadline);
        if (!Number.isFinite(nodeAt) || nodeAt > now) continue;
        const marked = this.engine.store.db.prepare(
          'INSERT OR IGNORE INTO grading_nodes(course_id,node_at,created_at) VALUES(?,?,?)').run(course.id, nodeAt, now);
        if (!marked.changes) continue;
        const batch = this.build(course.id, nodeAt, now);
        if (batch) created.push(batch);
      }
    }
    return created;
  }

  private build(courseId: string, nodeAt: number, now: number): GradingBatch | undefined {
    const used = new Set<string>();
    for (const batch of this.list(courseId)) for (const item of batch.items) used.add(item.messageId);
    const candidates = this.mail.batchCandidates(courseId, nodeAt).filter(item => !used.has(item.id));
    if (!candidates.length) return undefined;
    const batch: GradingBatch = {
      id: randomUUID(), courseId, nodeAt, status: 'pending', createdAt: now,
      items: candidates.map(item => ({
        messageId: item.id, studentName: item.studentName, assignmentId: item.assignmentId,
        assignmentTitle: item.assignmentTitle, subject: item.subject, receivedAt: item.receivedAt,
        total: item.draft.total, maximum: item.draft.maximum,
        points: item.draft.points.map(point => ({ id: point.id, score: point.score, max: point.max, comment: point.comment })),
      })),
    };
    this.engine.store.atomic(() => {
      this.engine.store.db.prepare('INSERT INTO grading_batches(id,course_id,node_at,status,data,created_at) VALUES(?,?,?,?,?,?)')
        .run(batch.id, courseId, nodeAt, batch.status, JSON.stringify(batch), now);
      this.notify(batch);
    });
    return batch;
  }

  async approve(courseId: string, id: string): Promise<{ batch: GradingBatch; sent: number; failed: number }> {
    const batch = this.batch(courseId, id);
    if (batch.status !== 'pending') throw new DomainError('stale', '这批批改已经处理');
    let sent = 0;
    const failed: string[] = [];
    for (const item of batch.items) {
      try {
        await this.mail.reply(courseId, item.messageId, feedback(item));
        sent++;
      } catch { failed.push(item.studentName || item.messageId); }
    }
    const updated: GradingBatch = { ...batch, status: 'approved', approvedAt: this.engine.now(), sent, failed };
    this.engine.store.db.prepare('UPDATE grading_batches SET status=?,approved_at=?,data=? WHERE course_id=? AND id=?')
      .run('approved', updated.approvedAt!, JSON.stringify(updated), courseId, id);
    return { batch: updated, sent, failed: failed.length };
  }

  reject(courseId: string, id: string): GradingBatch {
    const batch = this.batch(courseId, id);
    if (batch.status !== 'pending') throw new DomainError('stale', '这批批改已经处理');
    const updated: GradingBatch = { ...batch, status: 'rejected' };
    this.engine.store.db.prepare('UPDATE grading_batches SET status=?,data=? WHERE course_id=? AND id=?')
      .run('rejected', JSON.stringify(updated), courseId, id);
    return updated;
  }

  pending(courseId: string): GradingBatch[] { return this.list(courseId).filter(batch => batch.status === 'pending'); }

  private notify(batch: GradingBatch) {
    const course = this.engine.store.course(batch.courseId);
    if (!course) return;
    const teacher = teacherContact(this.engine, course);
    if (!teacher) return;
    const names = [...new Set(batch.items.map(item => item.studentName))];
    const text = `「${course.title}」有 ${batch.items.length} 份批改待在 ${new Date(batch.nodeAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} 节点审核：` +
      names.slice(0, 8).join('、') + (names.length > 8 ? ` 等 ${names.length} 人` : '') +
      `。回复「通过批改 ${batch.id}」统一回信，或「驳回批改 ${batch.id}」。`;
    const key = `grading-batch:${batch.id}`;
    const event = this.engine.receive({
      sourceKey: key, externalId: key, threadId: key, courseId: batch.courseId,
      actorId: 'qq:' + teacher, channel: { kind: 'qq-private', target: teacher },
      receivedAt: this.engine.now(), text: '批改批次待审核',
    }).event;
    this.engine.replyToTeacher(event, text);
  }
}

function feedback(item: BatchItem): string {
  const lines = item.points.map(point => `${point.id}：${point.score}/${point.max}${point.comment ? '，' + point.comment : ''}`);
  return `批改结果：${item.total}/${item.maximum}\n` + lines.join('\n') + '\n\n如对结果有疑问，直接回复这封邮件。';
}
