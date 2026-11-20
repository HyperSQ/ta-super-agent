import type { TaskEngine } from '../application/task-engine.ts';
import type { Event, Task, TaskKind, TaskStatus } from '../domain/model.ts';
import { currentReports, isSensitiveReport, taskLabel } from '../application/task-reports.ts';
import { courseInbox } from '../application/services/inbox.ts';

/**
 * 课程计划：下次路由时给 Router 的事实集合。
 * 只包含教师可见的任务与去敏后的汇报；学生私聊任务、一次性回执和确认码不进入这里。
 */
export type PlanTask = {
  id: string; kind: TaskKind; status: TaskStatus; revision: number; inputEpoch: number;
  title: string; question?: string;
};
export type PlanReport = { taskId: string; kind: TaskKind; outcome: string; summary: string; at: number; next: string };
export type PlanPending = { type: 'waiting_teacher' | 'blocked' | 'review_output'; taskId: string; title: string };
export type CoursePlan = {
  course: { id: string; title: string };
  tasks: PlanTask[];
  reports: PlanReport[];
  pending: PlanPending[];
  counts: { waitingTeacher: number; blocked: number; paused: number; queued: number; running: number; sensitiveReports: number; inbox: number };
};

const RANK: Record<string, number> = { waiting_teacher: 0, blocked: 1, paused: 2, queued: 3, running: 4 };
const STATUS_TEXT: Record<string, string> = {
  waiting_teacher: '等待教师答复', blocked: '阻塞', paused: '已暂停', queued: '排队中', running: '运行中', completed: '已完成',
};
export const statusText = (status: string) => STATUS_TEXT[status] ?? status;

function visible(engine: TaskEngine, task: Task): boolean {
  const origin = task.grant.originEventId ? engine.store.originalEvent(task.grant.originEventId) : undefined;
  if (!origin) return true;
  // 学生私聊里的任务不进入教师计划；群内答疑仍可通过计数体现。
  return !(origin.actor.role === 'student' && origin.channel.kind === 'qq-private');
}

export function buildRouterContext(engine: TaskEngine, event: Event): CoursePlan | undefined {
  const course = engine.store.course(event.courseId);
  if (!course) return undefined;
  const store = engine.store;
  const owned = store.tasks().filter(task => task.courseId === course.id && !task.grant.purpose && visible(engine, task));
  const open = owned.filter(task => task.status in RANK)
    .sort((a, b) => (RANK[a.status] - RANK[b.status]) || (a.createdAt - b.createdAt));
  const tasks: PlanTask[] = open.slice(0, 8).map(task => {
    const question = task.teacherWait?.questionId ? store.event(task.teacherWait.questionId)?.text : undefined;
    return {
      id: task.id, kind: task.kind, status: task.status, revision: task.revision, inputEpoch: task.inputEpoch,
      title: taskLabel(task), ...(question ? { question: question.replace(/\s+/g, ' ').slice(0, 80) } : {}),
    };
  });

  const reports: PlanReport[] = [];
  let sensitive = 0;
  for (const report of currentReports(store, course.id, 12)) {
    if (report.at < (course.teacherHistoryStartAt ?? 0)) continue;
    const task = store.task(report.taskId);
    if (!task || !visible(engine, task)) continue;
    if (isSensitiveReport(report.data.kind)) { sensitive++; continue; }
    if (reports.length >= 6) continue;
    reports.push({ taskId: report.taskId, kind: report.data.kind, outcome: report.outcome,
      summary: report.data.summary.slice(0, 120), at: report.at, next: report.data.next });
  }

  const pending: PlanPending[] = [
    ...tasks.filter(task => task.status === 'waiting_teacher')
      .map(task => ({ type: 'waiting_teacher' as const, taskId: task.id, title: task.title })),
    ...tasks.filter(task => task.status === 'blocked')
      .map(task => ({ type: 'blocked' as const, taskId: task.id, title: task.title })),
    ...reports.filter(report => report.next === 'review_output')
      .map(report => ({ type: 'review_output' as const, taskId: report.taskId, title: report.summary })),
  ];

  const counts = {
    waitingTeacher: tasks.filter(task => task.status === 'waiting_teacher').length,
    blocked: tasks.filter(task => task.status === 'blocked').length,
    paused: tasks.filter(task => task.status === 'paused').length,
    queued: tasks.filter(task => task.status === 'queued').length,
    running: tasks.filter(task => task.status === 'running').length,
    sensitiveReports: sensitive,
    inbox: courseInbox(engine, course.id, { limit: 1 }).counts.total,
  };
  const plan: CoursePlan = { course: { id: course.id, title: course.title }, tasks, reports, pending, counts };

  // 控制进入模型的体积：先丢汇报，再丢低优先级任务，最后截断待处理列表。
  const size = () => JSON.stringify(plan).length;
  while (size() > 4000 && plan.reports.length) plan.reports.pop();
  while (size() > 4000 && plan.tasks.length > 4) plan.tasks.pop();
  while (size() > 4000 && plan.pending.length > 6) plan.pending.pop();
  return plan;
}

/** 教师问「还有什么没做完」时的确定性回答；不调用模型，也不包含确认码、邮箱或成绩。 */
export function formatCoursePlan(plan: CoursePlan): string {
  const lines: string[] = [];
  const total = plan.pending.length;
  lines.push(total ? `「${plan.course.title}」当前 ${total} 项待处理：` : `「${plan.course.title}」当前没有待处理事项。`);
  for (const item of plan.pending.slice(0, 6)) {
    const task = plan.tasks.find(candidate => candidate.id === item.taskId);
    const detail = item.type === 'review_output' ? item.title : `${statusText(task?.status ?? item.type)} · ${task?.title ?? item.title}`;
    lines.push(`· ${detail}（任务 ${item.taskId}${task ? '，版本 ' + task.revision : ''}）`);
  }
  if (total > 6) lines.push(`…另有 ${total - 6} 项，可在工作台「运行任务」查看。`);
  // 暂停与排队中的任务也算「没做完」，否则教师会以为课程没有在办的事。
  const unfinished = plan.tasks.filter(task => ['paused', 'queued', 'running'].includes(task.status));
  for (const task of unfinished.slice(0, 4))
    lines.push(`· ${statusText(task.status)} · ${task.title}（任务 ${task.id}，版本 ${task.revision}）`);
  if (plan.counts.inbox > total) lines.push(`待办收件箱共 ${plan.counts.inbox} 项，可在工作台「待办」逐个处理。`);
  const done = plan.reports.filter(report => report.outcome === 'completed').slice(0, 3);
  if (done.length) lines.push('最近完成：' + done.map(report => report.summary).join('；'));
  if (plan.counts.sensitiveReports)
    lines.push(`另有 ${plan.counts.sensitiveReports} 条学生答疑／作业邮件汇报，内容只在工作台受控入口显示。`);
  lines.push('要说「继续」或修改，直接用任务 ID 或任务标题，我不会凭印象挑任务。');
  return lines.join('\n');
}
