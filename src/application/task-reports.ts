import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain/model.ts';
import type { Run, Task, TaskKind } from '../domain/model.ts';
import type { Store } from '../adapters/storage/sqlite.ts';
import type { TaskEngine } from './task-engine.ts';

/**
 * Worker 完成（或阻塞）后留下的结构化事实。由程序确定性生成，不调用模型，
 * 也不写入学生原文、成绩、邮件正文或底层异常文本。
 */
export type TaskReportOutcome = 'completed' | 'waiting_teacher' | 'blocked';
export type TaskReportEvidence = { kind: 'event' | 'assignment' | 'artifact' | 'teacher_question'; id: string; revision?: number };
export type TaskReportNext = 'none' | 'review_output' | 'answer_teacher_question' | 'inspect_blocker';
export type TaskReportData = {
  kind: TaskKind;
  summary: string;
  evidence: TaskReportEvidence[];
  unresolved: string[];
  next: TaskReportNext;
};
export type TaskReportRecord = {
  id: string; taskId: string; courseId: string; revision: number; inputEpoch: number;
  runId: string; at: number; outcome: TaskReportOutcome; data: TaskReportData;
};
/** 对外投影：数据库列与 data 合并成一份完整汇报。 */
export type TaskReport = {
  taskId: string; courseId: string; kind: TaskKind; revision: number; inputEpoch: number;
  at: number; outcome: TaskReportOutcome; summary: string;
  evidence: TaskReportEvidence[]; unresolved: string[]; next: TaskReportNext;
};

const MATERIAL: TaskKind[] = ['lesson', 'scheduled'];
const SENSITIVE: TaskKind[] = ['qa', 'coursework'];
export const isMaterialTask = (kind: TaskKind) => MATERIAL.includes(kind);
export const isSensitiveReport = (kind: TaskKind) => SENSITIVE.includes(kind);

/** 对外可见的短标题：材料任务用教师目标，其余职责只用固定名称。 */
export function taskLabel(task: Task): string {
  if (isMaterialTask(task.kind)) {
    const goal = task.goal.replace(/\s+/g, ' ').trim();
    return (goal.length > 42 ? goal.slice(0, 42) + '…' : goal) || '未命名材料任务';
  }
  return task.kind === 'qa' ? '学生答疑' : task.kind === 'coursework' ? '作业邮件' : '教学事务';
}

/** 阻塞类别只做有限映射，避免异常原文进入课程级摘要。 */
export function blockedCategory(error: unknown): string {
  if (error instanceof DomainError) {
    const known: Record<string, string> = {
      forbidden: '权限或范围不符', stale: '依据已过期', invalid: '输出或参数无效',
      not_found: '依赖记录不存在', conflict: '状态冲突', unavailable: '外部能力不可用',
    };
    return known[error.code] ?? '执行失败';
  }
  const message = error instanceof Error ? error.message : '';
  if (/模型|model|timeout|超时/i.test(message)) return '模型调用失败';
  if (/配置|尚未|未配置|密钥|launcher|DSH/i.test(message)) return '缺少配置';
  return '执行失败';
}

function describe(task: Task, run: Run, outcome: TaskReportOutcome, error?: unknown): TaskReportData {
  const evidence: TaskReportEvidence[] = [];
  const origin = task.grant.originEventId;
  if (origin) evidence.push({ kind: 'event', id: origin });
  const latest = run.history.at(-1)?.event.id;
  if (latest && latest !== origin) evidence.push({ kind: 'event', id: latest });
  for (const read of run.assignmentReads ?? []) evidence.push({ kind: 'assignment', id: read.id, revision: read.revision });
  for (const artifact of task.artifacts ?? []) evidence.push({ kind: 'artifact', id: artifact.sha256 });
  if (task.teacherWait?.questionId) evidence.push({ kind: 'teacher_question', id: task.teacherWait.questionId });

  const category = blockedCategory(error);
  const material = isMaterialTask(task.kind);
  const summary = outcome === 'waiting_teacher' ? `「${taskLabel(task)}」等待教师答复`
    : outcome === 'blocked' ? `「${taskLabel(task)}」阻塞：${category}`
      : material ? `已完成「${taskLabel(task)}」` : `${taskLabel(task)}已处理`;
  const unresolved = outcome === 'waiting_teacher' ? ['教师尚未回答提问']
    : outcome === 'blocked' ? [`阻塞类别：${category}`]
      : material && (task.artifacts?.length ?? 0) > 0 ? ['产物待教师查看'] : [];
  const next: TaskReportNext = outcome === 'waiting_teacher' ? 'answer_teacher_question'
    : outcome === 'blocked' ? 'inspect_blocker'
      : material && (task.artifacts?.length ?? 0) > 0 ? 'review_output' : 'none';
  return { kind: task.kind, summary, evidence: evidence.slice(0, 6), unresolved, next };
}

/** 必须由 finish/fail 在已有事务内调用；同一任务同一次运行只写一份。 */
export function recordTaskReport(engine: TaskEngine, run: Run, outcome: TaskReportOutcome,
  options: { task?: Task; error?: unknown } = {}): void {
  const task = options.task ?? engine.store.task(run.task.id);
  if (!task || task.grant.purpose) return;
  const data = describe(task, run, outcome, options.error);
  engine.store.db.prepare('INSERT INTO task_reports(id,course_id,task_id,revision,input_epoch,run_id,at,outcome,data) ' +
    'VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id,run_id) DO NOTHING')
    .run(randomUUID(), task.courseId, task.id, run.revision, run.inputEpoch, run.lease, engine.now(), outcome, JSON.stringify(data));
}

type Row = { id: string; course_id: string; task_id: string; revision: number; input_epoch: number; run_id: string; at: number; outcome: string; data: string };
const record = (row: Row): TaskReportRecord => ({
  id: String(row.id), taskId: String(row.task_id), courseId: String(row.course_id),
  revision: Number(row.revision), inputEpoch: Number(row.input_epoch), runId: String(row.run_id),
  at: Number(row.at), outcome: String(row.outcome) as TaskReportOutcome, data: JSON.parse(String(row.data)) as TaskReportData,
});

export function courseReports(store: Store, courseId: string, limit = 24): TaskReportRecord[] {
  return (store.db.prepare('SELECT * FROM task_reports WHERE course_id=? ORDER BY at DESC, rowid DESC LIMIT ?')
    .all(courseId, limit) as Row[]).map(record);
}

/** 只保留仍对应当前任务状态的汇报：任务去重、版本与输入纪元一致、未被取消或替代。 */
export function currentReports(store: Store, courseId: string, limit = 6): TaskReportRecord[] {
  const tasks = new Map(store.tasks().filter(task => task.courseId === courseId).map(task => [task.id, task]));
  const seen = new Set<string>();
  const current: TaskReportRecord[] = [];
  for (const report of courseReports(store, courseId, limit * 6)) {
    const task = tasks.get(report.taskId);
    if (!task || seen.has(task.id)) continue;
    if (['cancelled', 'superseded'].includes(task.status)) continue;
    if (task.revision !== report.revision || task.inputEpoch !== report.inputEpoch) continue;
    if (task.memoryContextInvalidated) continue;
    seen.add(task.id);
    current.push(report);
    if (current.length >= limit) break;
  }
  return current;
}

export function latestReport(store: Store, taskId: string): TaskReportRecord | undefined {
  const row = store.db.prepare('SELECT * FROM task_reports WHERE task_id=? ORDER BY at DESC, rowid DESC LIMIT 1').get(taskId) as Row | undefined;
  return row ? record(row) : undefined;
}

export const reportView = (record: TaskReportRecord): TaskReport => ({
  taskId: record.taskId, courseId: record.courseId, kind: record.data.kind, revision: record.revision,
  inputEpoch: record.inputEpoch, at: record.at, outcome: record.outcome, summary: record.data.summary,
  evidence: record.data.evidence, unresolved: record.data.unresolved, next: record.data.next,
});
