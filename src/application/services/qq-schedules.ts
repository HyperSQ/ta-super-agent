import { randomUUID } from 'node:crypto';
import { DomainError } from '../../domain/model.ts';
import type { Course, Event, WeeklyTask } from '../../domain/model.ts';
import type { TaskEngine } from '../task-engine.ts';
import { queueScheduleRun, scheduledTools, scheduleFields, weeklyTasks } from '../weekly-lesson.ts';
import { teacherThread } from '../teacher-conversation.ts';

export type QQScheduleCapabilities = { dshAvailable: boolean; groupSending: boolean };
const missing = () => new DomainError('not_found', '本课程没有这个定时任务，请先查现有任务。');

export class ScheduleOperations {
  private engine: TaskEngine;
  private capabilities: QQScheduleCapabilities;
  constructor(engine: TaskEngine, capabilities: QQScheduleCapabilities) {
    this.engine = engine;
    this.capabilities = capabilities;
  }

  list(course: Course, scheduleId?: unknown) {
    const tasks = weeklyTasks(course);
    const plan = tasks.find(item => item.id === scheduleId);
    if (scheduleId !== undefined && !plan) throw missing();
    return { revision: course.revision ?? 1, plan, tasks: plan ? undefined : tasks.map(({ prompt, ...item }) => ({
      ...item, promptPreview: prompt.slice(0, 200),
    })), availableTools: scheduledTools, ...this.capabilities,
      hasGroup: !!course.groupId };
  }

  save(event: Event, course: Course, args: Record<string, unknown>) {
    const tasks = weeklyTasks(course);
    const prior = args.scheduleId === undefined ? undefined : tasks.find(plan => plan.id === args.scheduleId);
    if (args.scheduleId !== undefined && !prior) throw missing();
    if (!prior && tasks.length >= 24) throw new DomainError('conflict', '每门课最多配置 24 个定时任务。');
    const operator = teacherThread(event).actor;
    const row: Record<string, unknown> = { enabled: true, tools: [], ...prior, id: prior?.id ?? randomUUID() };
    for (const key of ['title', 'prompt', 'weekday', 'time', 'enabled', 'tools', 'worker'])
      if (Object.hasOwn(args, key)) row[key] = args[key];
    if (args.askTeacherForProgress === true) {
      if (!operator.startsWith('qq:')) throw new DomainError('invalid', '没有关联的教师 QQ，无法启用自动询问进度。');
      row.teacherQQ = operator.slice(3);
    } else if (args.askTeacherForProgress === false) delete row.teacherQQ;
    const plan = scheduleFields(this.engine, row, this.capabilities.dshAvailable, prior);
    if (!prior && tasks.some(item => item.title.normalize('NFKC').trim() === plan.title.normalize('NFKC')))
      throw new DomainError('conflict', '本课程有同名定时任务，请查到原任务后编辑。');
    if (plan.enabled && plan.tools.includes('send_group_file') && !prior?.tools.includes('send_group_file') && !this.capabilities.groupSending)
      throw new DomainError('unavailable', '服务器未开启 QQ 发送。');
    const run = args.run;
    if (run !== undefined) this.checkRun(course, plan, run);
    const current = this.engine.updateCourse(event.actor.id, { ...course, weeklyLesson: undefined,
      weeklyTasks: prior ? tasks.map(item => item.id === prior.id ? plan : item) : [...tasks, plan],
    }, course.revision ?? 1);
    const message = plan.enabled
      ? `已${prior ? '更新' : '登记'}「${plan.title}」，每周${'日一二三四五六'[plan.weekday]} ${plan.time}（北京时间）。`
      : `「${plan.title}」已${prior?.enabled ? '暂停' : '保存为停用'}。`;
    if (run !== undefined) return message + '\n' + this.queue(event, current, plan, run);
    return message + (!course.groupId && plan.tools.includes('send_group_file') ? ' 绑定课程 QQ 群后才能执行发文件。' : '');
  }

  run(event: Event, course: Course, args: Record<string, unknown>) {
    const plan = weeklyTasks(course).find(item => item.id === args.scheduleId);
    if (!plan) throw missing();
    const mode = args.mode ?? 'now';
    this.checkRun(course, plan, mode);
    return this.queue(event, course, plan, mode);
  }

  private requireGroupSending(course: Course) {
    if (!this.capabilities.groupSending || !course.groupId)
      throw new DomainError('unavailable', '当前课程未绑定 QQ 群，或服务器未开启 QQ 发送。');
  }

  private checkRun(course: Course, plan: WeeklyTask, mode: unknown): asserts mode is 'first' | 'now' {
    if (mode !== 'first' && mode !== 'now') throw new DomainError('invalid', '请选择首次运行或立即运行。');
    if (plan.worker === 'dsh' && !this.capabilities.dshAvailable) throw new DomainError('unavailable', '服务器尚未启用 DSH Worker。');
    if (plan.tools.includes('send_group_file')) this.requireGroupSending(course);
  }

  private queue(event: Event, course: Course, plan: WeeklyTask, mode: unknown) {
    const source = mode === 'first' ? `qq:first:${course.id}:${plan.id}` : 'qq:' + event.id;
    const { duplicate } = queueScheduleRun(this.engine, course, plan, source);
    return duplicate ? `「${plan.title}」已登记过这次运行。`
      : `「${plan.title}」已进入执行队列。可在工作台「运行任务」查看进度和产物。`;
  }
}
