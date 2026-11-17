import { readFileSync } from 'node:fs';
import type { TaskEngine } from '../task-engine.ts';
import { DomainError } from '../../domain/model.ts';

export type SubmissionFile = { index: number; name: string; bytes: number; content: Buffer };
export type StudentSubmission = {
  verified: boolean;
  name?: string;
  assignment?: { id: string; title: string; deadline: string };
  attempt?: number;
  submittedAt?: string;
  late?: boolean;
  files: SubmissionFile[];
  hint?: string;
};

type RequestData = { receivedAt?: number; attempt?: number; late?: boolean; files?: { index: number; name: string; bytes: number }[] };

const parse = <T>(value: unknown): T | undefined => {
  try { return JSON.parse(String(value)) as T; } catch { return undefined; }
};

/**
 * 学生本人最近一次已登记的提交（含附件内容），用于答疑时查看实际作答。
 * 只按“课程 + 已核对 QQ + 学生可见作业”查询，不返回他人记录。
 */
export function studentSubmission(engine: TaskEngine, courseId: string, actorId: string, assignmentId: string): StudentSubmission {
  const db = engine.store.db;
  const binding = db.prepare('SELECT student_name FROM coursework_qq_students WHERE course_id=? AND actor=?')
    .get(courseId, actorId) as { student_name?: string } | undefined;
  const name = binding?.student_name ? String(binding.student_name) : undefined;
  if (!name) return { verified: false, files: [], hint: '还没有核对你的 QQ 与名单姓名，暂时不能查看提交内容。' };
  const assignmentRow = db.prepare("SELECT data FROM coursework_assignments WHERE course_id=? AND id=? AND json_extract(data,'$.studentVisible')=1")
    .get(courseId, assignmentId) as { data: string } | undefined;
  if (!assignmentRow) throw new DomainError('not_found', '找不到这份已发布的作业');
  const assignment = parse<{ id: string; title: string; deadline: string }>(assignmentRow.data)!;
  const row = db.prepare(`SELECT id, data FROM coursework_requests
    WHERE course_id=? AND assignment_id=? AND student_name=? AND kind='submission' AND state='accepted'
    ORDER BY json_extract(data,'$.receivedAt') DESC, rowid DESC LIMIT 1`)
    .get(courseId, assignmentId, name) as { id: string; data: string } | undefined;
  if (!row) return { verified: true, name, assignment, files: [], hint: '这份作业还没有你已登记的提交。' };
  const request = parse<RequestData>(row.data);
  const disk = db.prepare('SELECT position,name,bytes,path FROM coursework_submission_paths WHERE request_id=? ORDER BY position')
    .all(String(row.id)) as { position: number; name: string; bytes: number; path: string }[];
  const legacy = disk.length ? [] : db.prepare('SELECT position, name, content FROM coursework_submission_files WHERE request_id=? ORDER BY position')
    .all(String(row.id)) as { position: number; name: string; content: Uint8Array }[];
  const files: SubmissionFile[] = disk.flatMap(file => {
    try {
      const content = readFileSync(file.path);
      return [{ index: file.position, name: file.name, bytes: content.length, content }];
    } catch { return []; }
  });
  if (!files.length) files.push(...legacy.map(file => ({
    index: Number(file.position), name: String(file.name), bytes: file.content.byteLength,
    content: Buffer.from(file.content),
  })));
  return {
    verified: true, name, assignment,
    attempt: Number(request?.attempt ?? 1),
    ...(request?.receivedAt ? { submittedAt: new Date(Number(request.receivedAt)).toISOString() } : {}),
    late: !!request?.late,
    files,
  };
}
