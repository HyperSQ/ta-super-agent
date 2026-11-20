import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain/model.ts';
import type { TaskEngine } from './task-engine.ts';
import type { CourseMail } from './services/course-mail.ts';
import { teacherContact } from './services/teacher-inquiry.ts';

export type BatchItem = {
  messageId: string; studentName: string; assignmentId: string; assignmentTitle: string;
  subject: string; receivedAt: number; total: number; maximum: number; fingerprint?: string;
  points: { id: string; score: number; max: number; comment: string }[];
};
export type GradingBatch = {
  id: string; courseId: string; nodeAt: number; status: 'pending' | 'sending' | 'approved' | 'rejected' | 'stale' | 'interrupted';
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
  private lastScan?: number;
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

  tick(now = this.engine.now()): GradingBatch[] {
    return this.engine.store.atomic(() => {
      const created: GradingBatch[] = [];
      for (const course of this.engine.store.courses()) {
        const assignments = this.engine.store.db.prepare(
          "SELECT json_extract(data,'$.deadline') AS deadline FROM coursework_assignments WHERE course_id=? AND json_extract(data,'$.studentVisible')=1")
          .all(course.id) as { deadline: string }[];
        const due = [...new Set(assignments.map(assignment => Date.parse(assignment.deadline))
          .filter(deadline => Number.isFinite(deadline) && deadline <= now))].sort((a, b) => a - b);
        if (!due.length) continue;
        const claimed = new Set<string>();
        const previous = this.list(course.id);
        for (const batch of previous) if (['pending', 'sending', 'rejected'].includes(batch.status)) {
          for (const item of batch.items) claimed.add(item.messageId + ':' + item.fingerprint);
        }
        const candidates = this.mail.batchCandidates(course.id, due[due.length - 1])
          .filter(item => !claimed.has(item.id + ':' + item.fingerprint));
        const byNode = new Map<number, typeof candidates>();
        for (const item of candidates) {
          const node = due.find(deadline => deadline >= item.receivedAt);
          if (node === undefined) continue;
          const bucket = byNode.get(node) ?? [];
          bucket.push(item);
          byNode.set(node, bucket);
        }
        for (const [nodeAt, items] of byNode) created.push(this.build(course.id, nodeAt, now, items));
      }
      return created;
    });
  }

  scan(now = this.engine.now()): void {
    if (this.lastScan !== undefined && now - this.lastScan < 15_000) return;
    this.tick(now);
    this.lastScan = now;
  }

  recover(): void {
    const rows = this.engine.store.db.prepare("SELECT data FROM grading_batches WHERE status='sending' OR status='pending'")
      .all() as { data: string }[];
    for (const row of rows) {
      const batch = parse<GradingBatch>(row.data);
      if (batch.status === 'sending') this.update({ ...batch, status: 'interrupted' });
      else if (batch.items.some(item => !item.fingerprint)) this.update({ ...batch, status: 'stale' });
    }
  }

  private build(courseId: string, nodeAt: number, now: number, candidates: ReturnType<CourseMail['batchCandidates']>): GradingBatch {
    const batch: GradingBatch = {
      id: randomUUID(), courseId, nodeAt, status: 'pending', createdAt: now,
      items: candidates.map(item => ({
        messageId: item.id, studentName: item.studentName, assignmentId: item.assignmentId,
        assignmentTitle: item.assignmentTitle, subject: item.subject, receivedAt: item.receivedAt, fingerprint: item.fingerprint,
        total: item.draft.total, maximum: item.draft.maximum,
        points: item.draft.points.map(point => ({ id: point.id, score: point.score, max: point.max, comment: point.comment })),
      })),
    };
    this.engine.store.db.prepare('INSERT INTO grading_batches(id,course_id,node_at,status,data,created_at) VALUES(?,?,?,?,?,?)')
      .run(batch.id, courseId, nodeAt, batch.status, JSON.stringify(batch), now);
    this.notify(batch);
    return batch;
  }

  async approve(courseId: string, id: string): Promise<{ batch: GradingBatch; sent: number; failed: number }> {
    const batch = this.engine.store.atomic(() => {
      const pending = this.batch(courseId, id);
      if (pending.status !== 'pending') throw new DomainError('stale', '这批批改已经处理或正在发送');
      const current = new Map(this.mail.batchCandidates(courseId, pending.nodeAt).map(item => [item.id, item.fingerprint]));
      if (pending.items.some(item => !item.fingerprint || current.get(item.messageId) !== item.fingerprint)) {
        this.update({ ...pending, status: 'stale' });
        return undefined;
      }
      const sending: GradingBatch = { ...pending, status: 'sending', approvedAt: this.engine.now(), sent: 0, failed: [] };
      this.update(sending);
      return sending;
    });
    if (!batch) throw new DomainError('stale', '批改草稿已变更，请刷新待办并复核新批次');
    let sent = 0;
    const failed: string[] = [];
    for (const item of batch.items) {
      try {
        await this.mail.reply(courseId, item.messageId, feedback(item), item.fingerprint);
        sent++;
      } catch { failed.push(item.studentName || item.messageId); }
      this.update({ ...batch, sent, failed });
    }
    const updated: GradingBatch = { ...batch, status: 'approved', sent, failed };
    this.update(updated);
    return { batch: updated, sent, failed: failed.length };
  }

  reject(courseId: string, id: string): GradingBatch {
    return this.engine.store.atomic(() => {
      const batch = this.batch(courseId, id);
      if (batch.status !== 'pending') throw new DomainError('stale', '这批批改已经处理或正在发送');
      const updated: GradingBatch = { ...batch, status: 'rejected' };
      this.update(updated);
      return updated;
    });
  }

  private update(batch: GradingBatch): void {
    this.engine.store.db.prepare('UPDATE grading_batches SET status=?,approved_at=?,data=? WHERE course_id=? AND id=?')
      .run(batch.status, batch.approvedAt ?? null, JSON.stringify(batch), batch.courseId, batch.id);
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
