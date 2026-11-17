import { createHash } from 'node:crypto';
import type { TaskEngine } from '../task-engine.ts';

/**
 * P3 的「可审阅候选」：只根据既有事实给出建议与理由，不创建任务、不发消息、不自动执行。
 * 教师在工作台「待办」页看到候选后，仍从原入口决定是否行动。
 */
export type ProposalRule = 'coursework_backlog' | 'mail_backlog' | 'memory_failures' | 'stalled_task';
export type Proposal = {
  id: string; rule: ProposalRule; title: string; reason: string; count: number;
  entry: 'coursework' | 'course-mail' | 'memory' | 'tasks'; at: number;
};

const id = (rule: ProposalRule, key: string) => `${rule}-${createHash('sha256').update(rule + ':' + key).digest('hex').slice(0, 10)}`;

export function buildProposals(engine: TaskEngine, courseId: string, options: { now?: number; stallMs?: number } = {}): Proposal[] {
  const now = options.now ?? engine.now();
  const stallMs = options.stallMs ?? 180_000;
  if (!engine.store.course(courseId)) return [];
  const db = engine.store.db;
  const proposals: Proposal[] = [];
  const count = (row: Record<string, unknown> | undefined) => Number(row?.n ?? 0);

  const coursework = count(db.prepare("SELECT count(*) AS n FROM coursework_requests WHERE course_id=? AND state='pending'").get(courseId));
  if (coursework)
    proposals.push({
      id: id('coursework_backlog', courseId), rule: 'coursework_backlog', count: coursework,
      title: `有 ${coursework} 份提交或延期等待核对`, reason: '未核对的提交会影响迟交判定与成绩登记', entry: 'coursework', at: now,
    });

  const mail = count(db.prepare("SELECT count(*) AS n FROM course_mail_messages WHERE course_id=? AND json_extract(data,'$.state')='pending'").get(courseId));
  if (mail)
    proposals.push({
      id: id('mail_backlog', courseId), rule: 'mail_backlog', count: mail,
      title: `有 ${mail} 封作业邮件等待核对`, reason: '邮件在核对前不会进入正式提交记录，也不会自动回信', entry: 'course-mail', at: now,
    });

  const memory = count(db.prepare("SELECT count(*) AS n FROM memory_jobs WHERE json_extract(data,'$.courseId')=? AND status='failed'").get(courseId));
  if (memory)
    proposals.push({
      id: id('memory_failures', courseId), rule: 'memory_failures', count: memory,
      title: `有 ${memory} 个记忆提取任务失败`, reason: '失败的学习记忆不会影响已发答复，但会降低后续解释的针对性', entry: 'memory', at: now,
    });

  const stalled: { id: string; title: string; minutes: number }[] = [];
  for (const task of engine.store.tasks()) {
    if (task.courseId !== courseId || task.status !== 'running') continue;
    const row = db.prepare('SELECT max(at) AS at FROM activities WHERE task_id=?').get(task.id);
    const latest = Number(row?.at ?? 0) || task.updatedAt;
    if (now - latest < stallMs) continue;
    stalled.push({ id: task.id, title: task.kind === 'lesson' || task.kind === 'scheduled' ? task.goal.slice(0, 40) : task.kind, minutes: Math.round((now - latest) / 60_000) });
  }
  for (const task of stalled.slice(0, 3))
    proposals.push({
      id: id('stalled_task', task.id), rule: 'stalled_task', count: 1,
      title: `任务「${task.title}」已 ${task.minutes} 分钟没有进展`, reason: '可能卡在模型调用或工具步骤；可在运行任务里查看阶段并决定是否暂停重试', entry: 'tasks', at: now,
    });

  return proposals;
}
