import { createHash } from 'node:crypto';
import type { TaskEngine } from '../task-engine.ts';
import type { Task } from '../../domain/model.ts';

/**
 * 教师待办收件箱：把散落在各业务表里的「等教师处理」聚合成一份只读列表。
 * 不返回确认码、邮件正文、附件内容或凭据；确认动作仍走各自原入口。
 */
export type InboxKind = 'teacher_draft' | 'coursework' | 'roster' | 'mail' | 'grading' | 'memory_job' | 'task' | 'alert';
export type InboxEntry = 'qq' | 'coursework' | 'course-mail' | 'memory' | 'tasks' | 'activities';
export type InboxItem = {
  kind: InboxKind; id: string; createdAt: number; title: string; status: string;
  entry: InboxEntry; detail?: string;
};
export type InboxCounts = Record<InboxKind, number> & { total: number };
export type Inbox = { items: InboxItem[]; counts: InboxCounts };

const text = (value: unknown, limit: number) =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
const json = <T>(value: unknown): T | undefined => {
  try { return JSON.parse(String(value)) as T; } catch { return undefined; }
};
const TTL_DRAFT = 30 * 60_000;
const TTL_ROSTER = 10 * 60_000;

function emptyCounts(): InboxCounts {
  return { total: 0, teacher_draft: 0, coursework: 0, roster: 0, mail: 0, grading: 0, memory_job: 0, task: 0, alert: 0 };
}

function taskTitle(task: Task): string {
  if (task.kind === 'lesson' || task.kind === 'scheduled') return text(task.goal, 40) || '材料任务';
  return task.kind === 'qa' ? '学生答疑' : task.kind === 'coursework' ? '作业邮件' : '教学事务';
}

export function courseInbox(engine: TaskEngine, courseId: string, options: { now?: number; limit?: number } = {}): Inbox {
  const now = options.now ?? engine.now();
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const db = engine.store.db;
  const items: InboxItem[] = [];

  // 1. 教师事务草稿：pending 且未过期；不返回确认码。
  const drafts = db.prepare(`SELECT d.event_id AS eventId, d.data AS data, d.expires_at AS expiresAt, e.data AS eventData
    FROM teacher_work_drafts d JOIN events e ON e.id=d.event_id
    WHERE d.course_id=? AND d.status='pending' AND d.expires_at>?`).all(courseId, now) as Record<string, unknown>[];
  for (const row of drafts) {
    const draft = json<{ change?: { action?: string; fields?: { title?: string }; assignment?: { title?: string } } }>(row.data);
    const change = draft?.change ?? {};
    const name = text(change.fields?.title, 40) || text(change.assignment?.title, 40);
    const action = change.action;
    const label = action === 'edit' ? '修改作业' : action === 'scores' ? '登记成绩' : '新建作业';
    items.push({
      kind: 'teacher_draft', id: String(row.eventId), status: 'pending',
      createdAt: Number(json<{ receivedAt?: number }>(row.eventData)?.receivedAt ?? Number(row.expiresAt) - TTL_DRAFT),
      title: `待确认：${label}${name ? `「${name}」` : ''}`,
      entry: 'qq', detail: '在原 QQ 会话或助教对话回复确认；确认码不在此页显示。',
    });
  }

  // 2. 学生提交与延期申请：只取 pending。
  const requests = db.prepare(`SELECT r.id, r.kind, r.student_name AS studentName, e.data AS eventData
    FROM coursework_requests r JOIN events e ON e.id=r.event_id
    WHERE r.course_id=? AND r.state='pending'`).all(courseId) as Record<string, unknown>[];
  for (const row of requests) {
    const kind = String(row.kind);
    items.push({
      kind: 'coursework', id: String(row.id), status: 'pending',
      createdAt: Number(json<{ receivedAt?: number }>(row.eventData)?.receivedAt ?? 0),
      title: `${kind === 'extension' ? '延期申请待审批' : '作业提交待核对'} · ${text(row.studentName, 40) || '未知学生'}`,
      entry: 'coursework',
    });
  }

  // 3. 名单变更：未过期；确认码换成不可逆展示 ID。
  const roster = db.prepare('SELECT id, data, expires FROM roster_approvals WHERE course_id=? AND expires>?')
    .all(courseId, now) as Record<string, unknown>[];
  for (const row of roster) {
    const names = json<{ names?: unknown[] }>(row.data)?.names ?? [];
    items.push({
      kind: 'roster', id: 'roster-' + createHash('sha256').update(String(row.id)).digest('hex').slice(0, 12),
      status: 'pending', createdAt: Number(row.expires) - TTL_ROSTER,
      title: `名单变更待确认 · 移除 ${names.length} 人`, entry: 'qq',
      detail: '用教师 QQ 回复助教给出的一次性指令；指令不在此页显示。',
    });
  }

  // 4. 作业邮件：沿用 CourseMail 的状态判断，pending 才进入收件箱。
  const mails = db.prepare('SELECT id, received_at AS receivedAt, data FROM course_mail_messages WHERE course_id=? ORDER BY received_at DESC LIMIT 100')
    .all(courseId) as Record<string, unknown>[];
  for (const row of mails) {
    const message = json<{ state?: string; subject?: string }>(row.data);
    if (message?.state !== 'pending') continue;
    const subject = text(message.subject, 60);
    items.push({
      kind: 'mail', id: String(row.id), status: 'pending', createdAt: Number(row.receivedAt),
      title: `作业邮件待核对${subject ? `：${subject}` : ''}`, entry: 'course-mail',
    });
  }

  // 5. 批改批次：每个截止节点一批，教师一次审核后统一回信。
  const grading = db.prepare(`SELECT id,node_at AS nodeAt,status,data FROM grading_batches WHERE course_id=?
    AND (status IN ('pending','interrupted') OR (status='approved' AND json_array_length(data,'$.failed')>0))`)
    .all(courseId) as Record<string, unknown>[];
  for (const row of grading) {
    const batch = json<{ items?: { studentName?: string }[]; failed?: string[] }>(row.data);
    const pending = row.status === 'pending';
    const names = (batch?.items ?? []).map(item => item.studentName).filter((name): name is string => !!name);
    items.push({
      kind: 'grading', id: String(row.id), status: String(row.status), createdAt: Number(row.nodeAt),
      title: pending ? `批改待审核：${names.length} 份` : row.status === 'interrupted' ? '批改回信中断，需核对' : `批改回信有 ${batch?.failed?.length ?? 0} 份需核对`,
      entry: 'course-mail',
      detail: pending ? names.slice(0, 8).join('、') + (names.length > 8 ? ` 等 ${names.length} 人` : '') || undefined
        : '请在课程邮箱核对各邮件的发送回执。',
    });
  }

  // 6. 记忆提取失败：只有需要人工重试的失败项进入「系统异常」。
  const memory = db.prepare("SELECT id, error FROM memory_jobs WHERE json_extract(data,'$.courseId')=? AND status='failed'")
    .all(courseId) as Record<string, unknown>[];
  for (const row of memory) {
    items.push({
      kind: 'memory_job', id: String(row.id), status: 'failed', createdAt: 0,
      title: '记忆提取失败，可重试', entry: 'memory', detail: text(row.error, 80) || undefined,
    });
  }

  // 6. 等待教师答复的任务。
  for (const task of engine.store.tasks()) {
    if (task.courseId !== courseId || task.status !== 'waiting_teacher' || task.grant.purpose) continue;
    items.push({
      kind: 'task', id: task.id, status: 'waiting_teacher', createdAt: task.updatedAt,
      title: `等待教师答复 · ${taskTitle(task)}`, entry: 'tasks',
    });
  }

  // 7. Watchdog 告警（P2），并入系统异常区域。
  const alerts = db.prepare('SELECT id, rule, target_id AS targetId, severity, detail, at FROM alerts WHERE course_id=? ORDER BY at DESC LIMIT 100')
    .all(courseId) as Record<string, unknown>[];
  for (const row of alerts) {
    items.push({
      kind: 'alert', id: String(row.id), status: String(row.severity), createdAt: Number(row.at),
      title: text(row.detail, 80) || '监督告警', entry: 'tasks',
    });
  }

  const counts = emptyCounts();
  for (const item of items) { counts[item.kind]++; counts.total++; }
  items.sort((a, b) => b.createdAt - a.createdAt || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return { items: items.slice(0, limit), counts };
}
