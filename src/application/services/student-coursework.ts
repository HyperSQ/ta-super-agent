import type { TaskEngine } from '../task-engine.ts';
import { Academics } from './academics.ts';

/**
 * 学生本人视角的作业情况：只按“课程 + 已核对的 QQ 与姓名”查询，
 * 返回提交次数、最近提交、迟交、个人延期与线下分数；永远不包含他人记录。
 */
export type StudentAssignment = {
  id: string; title: string; deadline: string; effectiveDeadline: string;
  submitted: boolean; attempts: number;
  lastSubmittedAt?: string; late?: boolean;
  score?: number; scoreMaximum?: number; scoreRegisteredAt?: string;
  extension?: { deadline: string; reason?: string };
  pendingExtension?: { deadline: string; requestedAt: number };
};
export type StudentCoursework = {
  verified: boolean;
  name?: string;
  assignments: StudentAssignment[];
  hint?: string;
};

type RequestData = { receivedAt?: number; attempt?: number; late?: boolean; deadline?: string; reason?: string;
  graded?: { assignmentRevision: number; total: number; maximum: number; at: number } };

const parse = <T>(value: unknown): T | undefined => {
  try { return JSON.parse(String(value)) as T; } catch { return undefined; }
};

export function studentCoursework(engine: TaskEngine, courseId: string, actorId: string): StudentCoursework {
  const course = engine.store.course(courseId);
  if (!course) return { verified: false, assignments: [], hint: '课程不存在。' };
  const db = engine.store.db;
  const row = db.prepare('SELECT student_name FROM coursework_qq_students WHERE course_id=? AND actor=?')
    .get(courseId, actorId) as { student_name?: string } | undefined;
  const name = row?.student_name ? String(row.student_name) : undefined;
  if (!name) {
    return {
      verified: false, assignments: [],
      hint: '还没有核对你的 QQ 与名单姓名。请让老师用 /bind 你的QQ号 姓名 绑定一次，之后就能查询自己的提交与成绩。',
    };
  }
  const visible = new Academics(engine).visibleAssignments(courseId);
  const ids = visible.map(item => item.id);
  if (!ids.length) return { verified: true, name, assignments: [] };
  const placeholders = ids.map(() => '?').join(',');
  const submissions = db.prepare(`SELECT assignment_id AS assignmentId, data FROM coursework_requests
    WHERE course_id=? AND student_name=? AND kind='submission' AND state='accepted' AND assignment_id IN (${placeholders})
    ORDER BY json_extract(data,'$.receivedAt'), rowid`).all(courseId, name, ...ids) as { assignmentId: string; data: string }[];
  const extensions = new Map<string, { deadline: string; reason?: string }>();
  for (const item of db.prepare(`SELECT assignment_id AS assignmentId, deadline, reason FROM assignment_extensions
    WHERE student_name=? AND assignment_id IN (${placeholders})`).all(name, ...ids) as { assignmentId: string; deadline: string; reason?: string }[])
    extensions.set(String(item.assignmentId), { deadline: String(item.deadline), reason: item.reason ? String(item.reason) : undefined });
  const pendingExtensions = new Map<string, { deadline: string; requestedAt: number }>();
  for (const item of db.prepare(`SELECT assignment_id AS assignmentId, data FROM coursework_requests
    WHERE course_id=? AND student_name=? AND kind='extension' AND state='pending' AND assignment_id IN (${placeholders})`).all(courseId, name, ...ids) as { assignmentId: string; data: string }[]) {
    const data = parse<RequestData>(item.data);
    if (data?.deadline) pendingExtensions.set(String(item.assignmentId), { deadline: String(data.deadline), requestedAt: Number(data.receivedAt ?? 0) });
  }
  const scores = new Map<string, { score: number; registeredAt?: string }>();
  for (const item of db.prepare(`SELECT assignment_id AS assignmentId, data FROM offline_submissions
    WHERE student_name=? AND assignment_id IN (${placeholders})`).all(name, ...ids) as { assignmentId: string; data: string }[]) {
    const data = parse<{ score?: number; registeredAt?: string }>(item.data);
    if (typeof data?.score === 'number') scores.set(String(item.assignmentId), { score: data.score, registeredAt: data.registeredAt });
  }

  const grouped = new Map<string, RequestData[]>();
  for (const item of submissions) {
    const list = grouped.get(String(item.assignmentId)) ?? [];
    const data = parse<RequestData>(item.data);
    if (data) list.push(data);
    grouped.set(String(item.assignmentId), list);
  }

  const assignments: StudentAssignment[] = visible.map(assignment => {
    const extension = extensions.get(assignment.id);
    const effectiveDeadline = extension && Date.parse(extension.deadline) > Date.parse(assignment.deadline)
      ? extension.deadline : assignment.deadline;
    const attempts = grouped.get(assignment.id) ?? [];
    const last = attempts.at(-1);
    const mailed = last?.graded?.assignmentRevision === assignment.revision ? last.graded : undefined;
    const score = scores.get(assignment.id);
    const pending = pendingExtensions.get(assignment.id);
    return {
      id: assignment.id, title: assignment.title, deadline: assignment.deadline, effectiveDeadline,
      submitted: attempts.length > 0, attempts: attempts.length,
      ...(last?.receivedAt ? { lastSubmittedAt: new Date(Number(last.receivedAt)).toISOString() } : {}),
      ...(last ? { late: last.late ?? Number(last.receivedAt ?? 0) > Date.parse(effectiveDeadline) } : {}),
      ...(mailed ? { score: mailed.total, scoreMaximum: mailed.maximum, scoreRegisteredAt: new Date(mailed.at).toISOString() } : score ? { score: score.score, ...(score.registeredAt ? { scoreRegisteredAt: String(score.registeredAt) } : {}) } : {}),
      ...(extension ? { extension } : {}),
      ...(pending ? { pendingExtension: { deadline: pending.deadline, requestedAt: pending.requestedAt } } : {}),
    };
  }).sort((a, b) => Date.parse(a.deadline) - Date.parse(b.deadline));
  return { verified: true, name, assignments };
}
