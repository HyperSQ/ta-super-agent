import { DomainError } from '../../domain/model.ts';
import type { TaskEngine } from '../task-engine.ts';

const date = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' });

export function weeklyReport(engine: TaskEngine, courseId: string, through = engine.now()) {
  const course = engine.store.course(courseId);
  if (!course) throw new DomainError('not_found', '课程不存在');
  const from = through - 7 * 86_400_000;
  const rows = engine.store.db.prepare(`
    SELECT a.id AS assignmentId, json_extract(a.data,'$.title') AS title,
      sum(CASE WHEN r.kind='submission' AND r.state='accepted' THEN 1 ELSE 0 END) AS accepted,
      count(DISTINCT CASE WHEN r.kind='submission' AND r.state='accepted' THEN r.student_name END) AS students,
      sum(CASE WHEN r.kind='submission' AND r.state='accepted' AND json_extract(r.data,'$.late')=1 THEN 1 ELSE 0 END) AS late,
      sum(CASE WHEN r.kind='submission' AND r.state='pending' THEN 1 ELSE 0 END) AS pending,
      sum(CASE WHEN r.kind='extension' AND r.state='accepted' THEN 1 ELSE 0 END) AS approvedExtensions
    FROM coursework_requests r JOIN coursework_assignments a ON a.id=r.assignment_id AND a.course_id=r.course_id
    WHERE r.course_id=? AND json_extract(r.data,'$.receivedAt')>? AND json_extract(r.data,'$.receivedAt')<=?
    GROUP BY a.id ORDER BY a.rowid
  `).all(courseId, from, through);
  const offline = engine.store.db.prepare(`
    SELECT count(*) AS total FROM offline_submissions s JOIN coursework_assignments a ON a.id=s.assignment_id
    WHERE a.course_id=? AND julianday(json_extract(s.data,'$.registeredAt'))>julianday(?) AND
      julianday(json_extract(s.data,'$.registeredAt'))<=julianday(?)
  `).get(courseId, new Date(from).toISOString(), new Date(through).toISOString());
  return {
    course: course.title, from, through, offlineRegistrations: Number(offline?.total ?? 0),
    assignments: rows.map(row => ({ id: String(row.assignmentId), title: String(row.title), accepted: Number(row.accepted),
      students: Number(row.students), late: Number(row.late), pending: Number(row.pending), approvedExtensions: Number(row.approvedExtensions) })),
  };
}

export function formatWeeklyReport(report: ReturnType<typeof weeklyReport>, limit = 20): string {
  const lines = [report.course + ' · 助教周报草稿', date.format(report.from) + ' 至 ' + date.format(report.through) + '（北京时间）'];
  for (const a of report.assignments.slice(0, limit)) {
    lines.push(`· ${a.title}：已登记 ${a.accepted} 次（${a.students} 人，其中迟交 ${a.late} 次），待核对 ${a.pending} 份，已批准延期 ${a.approvedExtensions} 项。`);
  }
  if (!report.assignments.length) lines.push('本期没有邮件或 QQ 作业申请记录。');
  if (report.assignments.length > limit) lines.push(`另有 ${report.assignments.length - limit} 份作业有记录，可在工作台核对完整明细。`);
  lines.push(`本期新增或更新的线下登记共 ${report.offlineRegistrations} 条，单独计数。`);
  return lines.join('\n');
}
