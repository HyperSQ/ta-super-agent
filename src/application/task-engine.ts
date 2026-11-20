import { randomUUID } from 'node:crypto';
import { DomainError, channelKey } from '../domain/model.ts';
import type { AssignmentRead, Channel, Course, Delivery, Event, Grant, ReplyAction, Run, Task, TaskKind, ThreadCorrection } from '../domain/model.ts';
import { Store } from '../adapters/storage/sqlite.ts';
import { Policy } from '../security/policy.ts';
import { MemoryRepository } from '../adapters/storage/memory.ts';
import { activity, currentActivity } from './activities.ts';
import { recordTaskChange } from './task-memory.ts';
import { recordTaskReport, type TaskReportOutcome } from './task-reports.ts';
import { RouterSessions } from './router-sessions.ts';
import { conversationOwner, teacherAssistantEvent } from './teacher-conversation.ts';

/** 只对可安全重放的瞬态错误退避；外部发送与权限错误不重试。 */
export function transientError(error: unknown): boolean {
  if (error instanceof DomainError) return error.code === 'unavailable';
  const message = error instanceof Error ? error.message : '';
  if (/未配置模型/.test(message)) return false;
  return /HTTP (?:429|5\d\d)|超时|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|socket hang up|模型请求失败：HTTP 5/i.test(message);
}

export class TaskEngine {
  store: Store;
  policy: Policy;
  now: () => number;
  onControl?: (taskId: string) => void;
  reviewFeedback = false;
  memory: MemoryRepository;
  constructor(store: Store, policy: Policy, now = Date.now) { this.store = store; this.policy = policy; this.now = now; this.memory = new MemoryRepository(store); }
  createCourse(actorId: string, course: Course): void {
    this.store.atomic(() => {
      if (!this.policy.isTeacher(actorId)) throw new DomainError('forbidden', '只有教师可以创建课程');
      if (this.store.course(course.id) || (course.groupId && this.store.courseForGroup(course.groupId))) throw new DomainError('conflict', '课程ID或群号已存在');
      this.store.saveCourse(course); this.store.audit('course.created', { actorId, courseId: course.id });
    });
  }
  updateCourse(actorId: string, course: Course, expectedRevision: number): Course {
    const changed: string[] = [];
    const result = this.store.atomic(() => {
      if (!this.policy.isTeacher(actorId)) throw new DomainError('forbidden', '只有教师可以修改课程');
      const old = this.store.course(course.id);
      if (!old) throw new DomainError('not_found', '课程不存在');
      if ((old.revision ?? 1) !== expectedRevision) throw new DomainError('stale', '课程已被修改，请刷新后保存');
      const other = course.groupId ? this.store.courseForGroup(course.groupId) : undefined;
      if (other && other.id !== course.id) throw new DomainError('conflict', '群号已绑定其他课程');
      const progressChanged = old.progress !== course.progress;
      const next: Course = { ...course, teacherHistoryStartAt: old.teacherHistoryStartAt, progressAt: progressChanged ? this.now() : old.progressAt,
        progressSource: progressChanged ? 'teacher' : old.progressSource, progressEvidence: progressChanged ? undefined : old.progressEvidence,
        revision: expectedRevision + 1 };
      this.store.saveCourse(next);
      for (const task of this.store.tasks()) {
        if (task.courseId !== course.id || task.kind !== 'qa' || task.grant.purpose === 'teacher-work' || ['cancelled', 'superseded'].includes(task.status)) continue;
        task.revision++; task.inputEpoch++;
        delete task.lease; delete task.leaseUntil; delete task.checkpoint;
        // Do not re-send historical answers merely because a teacher edits a course.
        if (!['completed', 'paused'].includes(task.status)) { task.status = 'queued'; delete task.result; delete task.error; }
        this.store.saveTask(task); this.withdraw(task.id); changed.push(task.id);
      }
      this.store.audit('course.updated', { actorId, before: old, after: next });
      return next;
    });
    for (const id of changed) this.onControl?.(id);
    return result;
  }
  /** One transaction stores source facts, reply mapping, and subscriber inputs. */
  receive(input: Omit<Event, 'id' | 'actor'> & { actorId: string }, passive = false): { event: Event; duplicate: boolean; subscribed: boolean } {
    return this.store.atomic(() => {
      const old = this.store.eventByKey(input.sourceKey);
      if (old) return { event: old, duplicate: true, subscribed: true };
      const course = this.store.course(input.courseId);
      if (!course) throw new DomainError('not_found', '课程不存在');
      const { actorId, ...data } = input;
      this.assertCourseChannel(input.courseId, input.channel, actorId);
      const owner = conversationOwner(course, this.policy, actorId, data.channel, data.assistantSurface);
      const event: Event = { ...data, conversationOwner: owner, id: randomUUID(),
        actor: { id: actorId, role: this.policy.isTeacher(actorId) ? 'teacher' : 'student' } };
      this.store.saveEvent(event);
      activity(this.store, { courseId: event.courseId, eventId: event.id, node: 'intake' }, 'received', '接收消息', event);
      if (passive) {
        this.store.markRouted(event.id);
        return { event, duplicate: false, subscribed: false };
      }
      this.store.link(channelKey(event.channel), event.externalId, event.threadId);
      if (this.reviewFeedback && !this.policy.isTeacher(actorId) && /串台|分错.*线|不是.*(?:题|问题)|我问的是|另一个问题|\/thread\b/u.test(event.text)) {
        this.store.review(event.id);
        return { event, duplicate: false, subscribed: false };
      }
      let subscribed = false;
      // Teacher messages may be controls: classify them before exposing to Workers.
      for (const task of this.policy.isTeacher(actorId) ? [] : this.store.subscribers(event.threadId)) {
        if (task.courseId !== event.courseId || ['cancelled', 'superseded'].includes(task.status)) continue;
        // Subscription deliveries remain data, including strings that look like commands.
        this.addInput(task, event);
        subscribed = true;
      }
      if (subscribed && !this.policy.isTeacher(actorId)) this.store.markRouted(event.id);
      if (subscribed) activity(this.store, { courseId: event.courseId, eventId: event.id, node: 'intake' }, 'subscription', '送入已订阅的任务', { threadId: event.threadId });
      return { event, duplicate: false, subscribed };
    });
  }
  createTask(eventId: string, kind: TaskKind, goal: string, purpose?: Grant['purpose']): Task {
    return this.store.atomic(() => {
      const event = this.requiredEvent(eventId);
      this.assertCourseChannel(event.courseId, event.channel, event.actor.id);
      if (purpose && (kind !== 'qa' || (event.channel.kind !== 'qq-private' && !(purpose === 'teacher-work' && teacherAssistantEvent(event)))))
        throw new DomainError('forbidden', '此回执只允许用于私聊或教师工作台');
      if (kind !== 'qa' || purpose === 'teacher-work') this.policy.requireTeacher(event);
      this.policy.validateWorkerSource(kind, event);
      const existing = this.store.tasks().find(t => t.grant.originEventId === eventId && t.status !== 'superseded');
      if (existing) return existing;
      const at = this.now();
      const task: Task = {
        id: randomUUID(), courseId: event.courseId, kind,
        goal: kind === 'qa' && !this.policy.isTeacher(event.actor.id) ? event.text : goal,
        revision: 1, inputEpoch: 0, consumedSeq: 0, status: 'queued',
        grant: { kind, courseId: event.courseId, requester: event.actor.id, originEventId: event.id, channel: event.channel, ...(purpose ? { purpose } : {}) },
        createdAt: at, updatedAt: at,
      };
      this.store.saveTask(task);
      if (kind === 'qa' && purpose !== 'teacher-work' && purpose !== 'student-work' && event.dsh?.kind !== 'assignment.announce' && event.dsh?.kind !== 'group.send') this.store.subscribe(task.id, event.threadId);
      this.addInput(task, event);
      this.store.markRouted(event.id);
      this.store.audit('task.created', { eventId, taskId: task.id, kind });
      currentActivity('task.created', '创建任务', { taskId: task.id, kind, goal });
      return this.requiredTask(task.id);
    });
  }
  replyToTeacher(event: Event, text: string, format?: 'text'): void {
    const task = this.createTask(event.id, 'qa', '教师私信业务回执', 'teacher-work');
    const run = this.claim(task.id);
    if (run) this.finish(run, format ? { action: 'send', format, content: [text] } : text);
  }
  replyCoursework(event: Event, text: string): void {
    if (event.actor.role !== 'student' || event.channel.kind !== 'qq-private') throw new DomainError('forbidden', '作业回执仅用于学生私信');
    const task = this.createTask(event.id, 'qa', '作业业务回执', 'student-work');
    const run = this.claim(task.id);
    if (run) this.finish(run, { action: 'send', format: 'text', content: [text] });
  }
  deliverFollowup(eventId: string): void {
    this.store.atomic(() => {
      const event = this.requiredEvent(eventId);
      for (const task of this.store.subscribers(event.threadId)) {
        if (task.courseId === event.courseId && !['cancelled', 'superseded'].includes(task.status)) this.addInput(task, event);
      }
      this.store.markRouted(eventId);
      currentActivity('followup', '转交给现有任务', { eventId, threadId: event.threadId });
    });
  }
  control(eventId: string, taskId: string, action: 'revise' | 'pause' | 'resume' | 'cancel', expectedRevision: number, goal?: string): Task {
    const result = this.store.atomic(() => {
      const event = this.requiredEvent(eventId);
      this.policy.requireTeacher(event);
      const task = this.requiredTask(taskId);
      if (event.courseId !== task.courseId) throw new DomainError('forbidden', '控制指令不属于该课程');
      if (task.revision !== expectedRevision) throw new DomainError('stale', '任务已更新，请读取当前版本');
      if (['cancelled', 'superseded'].includes(task.status)) throw new DomainError('conflict', '取消或已替代的任务不能恢复，请新建任务');
      if (action === 'revise' && !goal?.trim()) throw new DomainError('invalid', '修改目标不能为空');
      if (task.kind === 'teaching-affairs' || task.kind === 'coursework') {
        if (action === 'revise') throw new DomainError('invalid', '此任务绑定原始业务记录，请通过该业务入口更新');
        if (task.status === 'completed' && action !== 'cancel') throw new DomainError('conflict', '已完成的业务任务不可重复执行');
      }
      recordTaskChange(this.store, task, event, action, this.now());
      task.revision++;
      if (action === 'revise') { task.goal = goal!.trim(); task.status = task.status === 'paused' ? 'paused' : 'queued'; }
      if (action === 'pause') task.status = 'paused';
      if (action === 'resume') task.status = 'queued';
      if (action === 'cancel') task.status = 'cancelled';
      if (action === 'revise' || action === 'cancel') {
        delete task.dshSession; delete task.teacherWait; delete task.artifacts;
      }
      if (action === 'resume' && task.teacherWait && !task.teacherWait.answerId) task.status = 'waiting_teacher';
      delete task.lease; delete task.leaseUntil; delete task.result; delete task.error;
      delete task.replyAction; delete task.assignmentReads;
      task.updatedAt = this.now();
      this.store.saveTask(task);
      this.withdraw(taskId);
      this.store.markRouted(eventId);
      this.store.audit(`task.${action}`, { taskId, eventId, revision: task.revision });
      currentActivity('task.control', '执行任务控制', { taskId, action, revision: task.revision });
      return task;
    });
    this.onControl?.(taskId);
    return result;
  }
  claim(taskId: string, leaseMs = 120_000): Run | undefined {
    return this.store.atomic(() => {
      const task = this.requiredTask(taskId);
      if (task.status !== 'queued') return undefined;
      if ((task.retryAt ?? 0) > this.now()) return undefined;
      try { this.assertTaskScope(task); }
      catch (error) { task.status = 'blocked'; task.error = (error as Error).message; this.store.saveTask(task); return undefined; }
      const history = this.store.inputs(taskId);
      const inputs = history.filter(i => i.seq > task.consumedSeq);
      task.status = 'running'; task.lease = randomUUID(); task.leaseUntil = this.now() + leaseMs;
      delete task.retryAt; delete task.error;
      task.updatedAt = this.now(); this.store.saveTask(task);
      return { task, inputs, history, course: this.store.course(task.courseId)!, lease: task.lease, revision: task.revision, inputEpoch: task.inputEpoch, throughSeq: Math.max(task.consumedSeq, ...history.map(i => i.seq)) };
    });
  }
  checkpoint(run: Run, value: unknown): void {
    this.store.atomic(() => {
      const task = this.assertRun(run);
      task.checkpoint = { revision: run.revision, value };
      this.store.saveTask(task);
    });
  }
  updateDSH(run: Run, update: (task: Task) => void): void {
    this.store.atomic(() => {
      const task = this.assertRun(run);
      update(task);
      task.updatedAt = this.now();
      this.store.saveTask(task);
    });
  }
  recordTeacherAnswer(question: Event, answer: Event): void {
    this.store.atomic(() => {
      const task = this.store.tasks().find(item => item.courseId === answer.courseId && item.teacherWait?.questionId === question.id);
      if (!task?.teacherWait || task.teacherWait.answerId || !['running','waiting_teacher','paused','queued'].includes(task.status)) return;
      task.teacherWait.answerId = answer.id;
      if (task.status === 'waiting_teacher') task.status = 'queued';
      task.updatedAt = this.now();
      this.store.saveTask(task);
      this.store.audit('task.teacher_answer', { taskId: task.id, answerId: answer.id });
    });
  }
  renew(run: Run, leaseMs = 120_000): void {
    this.store.atomic(() => {
      const task = this.assertRun(run);
      task.leaseUntil = this.now() + leaseMs;
      this.store.saveTask(task);
    });
  }
  private validAssignments(courseId: string, reads: AssignmentRead[] = []): boolean {
    const row = this.store.db.prepare("SELECT 1 FROM coursework_assignments WHERE course_id=? AND id=? AND json_extract(data,'$.studentVisible')=1 AND json_extract(data,'$.revision')=?");
    return reads.every(read => !!row.get(courseId, read.id, read.revision));
  }
  bindMemoryContext(run: Run): void {
    this.store.atomic(() => {
      const task = this.assertRun(run);
      task.memoryReads = run.memoryReads ?? [];
      task.memoryContextInvalidated = false;
      this.store.saveTask(task);
    });
  }
  /** Uses the same version/lease control path as teacher edits; historical answers aren't resent. */
  refreshMemoryContexts(): void {
    const changed = this.store.atomic(() => {
      const ids: string[] = [];
      for (const task of this.store.tasks()) {
        if (task.memoryContextInvalidated || !task.memoryReads?.length || this.memory.validReads(task.memoryReads)
          || ['cancelled', 'superseded'].includes(task.status)) continue;
        task.memoryContextInvalidated = true; task.revision++; task.inputEpoch++;
        delete task.lease; delete task.leaseUntil; delete task.checkpoint;
        if (task.status === 'running') task.status = 'queued';
        if (task.status !== 'completed') { delete task.result; delete task.error; }
        else task.error = '所用记忆已修订，此结果保留为历史版本';
        this.store.saveTask(task); this.withdraw(task.id); ids.push(task.id);
        this.store.audit('task.memory_invalidated', { taskId: task.id, memoryReads: task.memoryReads });
      }
      return ids;
    });
    for (const id of changed) this.onControl?.(id);
  }
  finish(run: Run, result: string | ReplyAction, options: { source?: 'worker' | 'receipt' } = {}): void {
    this.store.atomic(() => {
      const task = this.assertRun(run);
      delete task.attempts; delete task.retryAt;
      if (task.kind === 'scheduled' && task.teacherWait &&
          task.teacherWait.questionId !== (run.task.teacherWait?.answerId ? run.task.teacherWait.questionId : undefined)) {
        task.status = task.teacherWait.answerId ? 'queued' : 'waiting_teacher';
        task.result = typeof result === 'string' ? result : undefined;
        task.updatedAt = this.now();
        delete task.lease; delete task.leaseUntil;
        this.store.saveTask(task);
        this.store.audit('task.teacher_wait', { taskId: task.id, questionId: task.teacherWait.questionId });
        // 已回答直接回队时不记等待汇报；真正停在 waiting_teacher 才留一份。
        if (options.source === 'worker' && task.status === 'waiting_teacher') {
          this.reportRun(run, task, 'waiting_teacher');
        }
        return;
      }
      delete task.teacherWait;
      const action = typeof result === 'string' ? undefined : result;
      const silent = action?.action === 'silent';
      const parts = typeof result === 'string' ? [result] : result.action === 'silent' ? []
        : result.format === 'text' ? result.content : [result.content];
      if (!silent && (!parts.length || parts.length > 3 || parts.some(part => !part.trim()))) throw new DomainError('invalid', '回复内容无效');
      const text = parts.join('\n');
      task.status = 'completed'; task.result = silent ? undefined : text; task.consumedSeq = run.throughSeq;
      task.replyAction = action;
      task.assignmentReads = run.assignmentReads;
      task.memoryReads = run.memoryReads ?? [];
      task.memoryContextInvalidated = false;
      delete task.lease; delete task.leaseUntil;
      this.store.saveTask(task);
      const replyEvent = run.history.at(-1)?.event;
      let afterDeliveryId: string | undefined;
      if ((task.kind === 'qa' || task.kind === 'teaching-affairs') && replyEvent && task.grant.channel && task.grant.channel.kind !== 'management') for (const part of parts) {
        const delivery: Delivery = { id: randomUUID(), taskId: task.id, revision: task.revision, inputEpoch: task.inputEpoch,
          replyEventId: replyEvent.id, threadId: replyEvent.threadId, channel: task.grant.channel, text: part,
          format: action?.action === 'send' ? action.format : undefined, afterDeliveryId, status: 'pending',
          ...(replyEvent.courseworkNotice || replyEvent.scheduled === 'progress-request' || replyEvent.dsh?.kind === 'teacher.ask' || replyEvent.dsh?.kind === 'assignment.announce' || replyEvent.dsh?.kind === 'group.send' ? { announcement: true } : {}),
          ...(replyEvent.dsh?.kind === 'group.send' && replyEvent.dsh.imageId ? { imageId: replyEvent.dsh.imageId } : {}),
          ...(replyEvent.dsh?.kind === 'group.send' && replyEvent.dsh.fileId ? { fileId: replyEvent.dsh.fileId } : {}) };
        this.store.saveDelivery(delivery);
        activity(this.store, { node: 'outbox', courseId: task.courseId, eventId: replyEvent.id, taskId: task.id, runId: run.lease },
          'delivery.queued', '加入交付队列', { deliveryId: delivery.id, channel: delivery.channel, format: delivery.format });
        afterDeliveryId = delivery.id;
      }
      this.store.audit('task.completed', { taskId: task.id, revision: task.revision, silent });
      if (task.kind === 'qa' && !silent && !task.grant.purpose && !replyEvent?.dsh) this.memory.enqueue(run, text);
      // 汇报只属于 Worker 实际提交；同步业务回执走各自原路径。
      if (options.source === 'worker') this.reportRun(run, task, 'completed');
    });
  }
  private reportRun(run: Run, task: Task, outcome: TaskReportOutcome, error?: unknown): void {
    const report = recordTaskReport(this, run, outcome, { task, error });
    const origin = task.grant.originEventId ? this.store.event(task.grant.originEventId) : run.history[0]?.event;
    if (!report || !origin) return;
    const sessions = new RouterSessions(this);
    sessions.append(sessions.forEvent(origin), 'assistant', `[${outcome}] ${report.summary}`);
  }
  fail(run: Run, error: unknown): void {
    this.store.atomic(() => {
      const task = this.requiredTask(run.task.id);
      if (task.status !== 'running' || task.lease !== run.lease) return;
      // New data invalidates an old result, but must not discard the new input.
      const stale = task.inputEpoch !== run.inputEpoch || (error instanceof DomainError && error.code === 'stale');
      const attempts = (task.attempts ?? 0) + 1;
      const retry = !stale && attempts < 3 && transientError(error);
      task.status = stale || retry ? 'queued' : 'blocked';
      if (stale) { delete task.attempts; delete task.retryAt; }
      if (retry) {
        task.attempts = attempts;
        task.retryAt = this.now() + [5_000, 20_000, 60_000][attempts - 1];
      }
      task.error = stale ? undefined : (error instanceof Error ? error.message : '执行失败');
      delete task.lease; delete task.leaseUntil; this.store.saveTask(task);
      this.store.audit('task.run_ended', { taskId: task.id, status: task.status, error: task.error, attempts: task.attempts, retryAt: task.retryAt });
      // 旧租约、输入变化或重新排队的运行不产生当前汇报；只有真正 blocked 才写。
      if (task.status === 'blocked') this.reportRun(run, task, 'blocked', error);
    });
  }
  release(run: Run): void {
    this.store.atomic(() => {
      const task = this.requiredTask(run.task.id);
      if (task.status !== 'running' || task.lease !== run.lease) return;
      task.status = 'queued'; delete task.lease; delete task.leaseUntil; this.store.saveTask(task);
    });
  }
  recover(): void {
    this.recoverRuns();
    this.memory.recover();
    this.store.atomic(() => {
      // Never automatically resend an external call interrupted by process death.
      for (const d of this.store.deliveries()) if (d.status === 'sending') { d.status = 'unknown'; d.error = '发送执行中服务中断，需核对外部回执'; this.store.saveDelivery(d); }
    });
  }
  recoverRuns(): void {
    this.store.atomic(() => {
      for (const task of this.store.tasks()) {
        if (task.status === 'running' && (task.leaseUntil ?? 0) <= this.now()) {
          task.status = 'queued'; delete task.lease; delete task.leaseUntil; this.store.saveTask(task);
        }
      }
    });
  }
  claimDelivery(id: string): Delivery | undefined {
    return this.store.atomic(() => {
      const d = this.store.delivery(id);
      if (!d || d.status !== 'pending' || (d.retryAt ?? 0) > this.now()) return undefined;
      const task = this.requiredTask(d.taskId);
      try { this.assertTaskScope(task); }
      catch (error) { d.status = 'withdrawn'; d.error = (error as Error).message; this.store.saveDelivery(d); return undefined; }
      if (task.status !== 'completed' || task.revision !== d.revision || task.inputEpoch !== d.inputEpoch || !this.memory.validReads(task.memoryReads) || !this.validAssignments(task.courseId, task.assignmentReads)) {
        d.status = 'withdrawn'; this.store.saveDelivery(d); return undefined;
      }
      if (d.afterDeliveryId) {
        const previous = this.store.delivery(d.afterDeliveryId);
        if (!previous || previous.status === 'unknown' || previous.status === 'withdrawn') {
          d.status = 'withdrawn'; d.error = '前一条消息未确认送达'; this.store.saveDelivery(d); return undefined;
        }
        if (previous.status !== 'sent' || (previous.sentAt ?? 0) + 1200 > this.now()) return undefined;
      }
      if (!task.grant.channel || channelKey(d.channel) !== channelKey(task.grant.channel)) throw new DomainError('forbidden', '交付超出任务渠道范围');
      const event = this.requiredEvent(d.replyEventId);
      if (event.courseId !== task.courseId || channelKey(event.channel) !== channelKey(d.channel)) throw new DomainError('forbidden', '回复事件不属于交付渠道');
      d.status = 'sending'; delete d.retryAt; this.store.saveDelivery(d); return d;
    });
  }
  /** Recheck at the transport boundary, including changes during asynchronous member lookup. */
  assertDeliveryTarget(d: Delivery, event: Event): void {
    const task = this.requiredTask(d.taskId);
    this.assertTaskScope(task);
    if (task.status !== 'completed' || task.revision !== d.revision || task.inputEpoch !== d.inputEpoch || !this.memory.validReads(task.memoryReads) || !this.validAssignments(task.courseId, task.assignmentReads)) throw new DomainError('stale', '交付依据已变化');
    if (!task.grant.channel || channelKey(d.channel) !== channelKey(task.grant.channel)
      || event.courseId !== task.courseId || channelKey(event.channel) !== channelKey(d.channel) || event.id !== d.replyEventId) throw new DomainError('forbidden', '交付目标不属于该任务');
    this.assertCourseChannel(task.courseId, d.channel, event.actor.id);
  }
  rejectDelivery(id: string, error: string, retry = false): void {
    this.store.atomic(() => {
      const delivery = this.store.delivery(id);
      if (!delivery || delivery.status !== 'sending') return;
      delivery.status = retry ? 'pending' : 'withdrawn'; delivery.error = error;
      if (retry) delivery.retryAt = this.now() + 5000;
      this.store.saveDelivery(delivery);
      this.store.audit(retry ? 'delivery.access_deferred' : 'delivery.access_denied', { deliveryId: id, error });
    });
  }
  assertCourseChannel(courseId: string, channel: Channel, actorId: string): void {
    const course = this.store.course(courseId);
    if (!course) throw new DomainError('not_found', '课程不存在');
    if (channel.kind === 'qq-group' && (!course.groupId || course.groupId !== channel.target)) throw new DomainError('forbidden', '目标群不在该课程当前群聊白名单内');
    if (channel.kind === 'qq-private') {
      if (!/^\d+$/.test(channel.target) || actorId !== 'qq:' + channel.target) throw new DomainError('forbidden', '私信只能回复真实发信者');
      if (!this.policy.isTeacher(actorId) && !course.groupId) throw new DomainError('forbidden', '课程尚未绑定群，不能授权学生私信');
    }
  }
  assertTaskScope(task: Task): void {
    this.policy.validateGrant(task);
    const origin = task.grant.originEventId ? this.store.event(task.grant.originEventId) : undefined;
    if (!origin || !task.grant.channel || origin.courseId !== task.courseId || origin.actor.id !== task.grant.requester
      || channelKey(origin.channel) !== channelKey(task.grant.channel)) throw new DomainError('forbidden', '任务授权与原始来源不一致');
    this.assertCourseChannel(task.courseId, task.grant.channel, origin.actor.id);
    if (origin.assistantSurface && origin.conversationOwner !== conversationOwner(this.store.course(task.courseId)!, this.policy,
      origin.actor.id, origin.channel, origin.assistantSurface)) throw new DomainError('forbidden', '课程教师身份已变更，请重新发送请求');
    this.policy.validateWorkerSource(task.kind, origin);
  }
  settleDelivery(id: string, result: { externalId: string; png?: Buffer } | { fileUploaded: true; externalFileId?: string } | { error: string }): void {
    this.store.atomic(() => {
      const d = this.store.delivery(id);
      if (!d || d.status !== 'sending') return;
      if ('externalId' in result) {
        d.status = 'sent'; d.externalId = result.externalId; d.sentAt = this.now();
        const event = this.requiredEvent(d.replyEventId);
        if (result.png) {
          const imageId = d.imageId ?? d.id;
          this.store.saveTeachingImage(imageId, event.courseId, result.png);
          this.store.db.prepare('INSERT INTO teaching_replies(delivery_id,image_id) VALUES(?,?)').run(d.id, imageId);
        }
        this.store.link(channelKey(d.channel), result.externalId, d.threadId ?? this.store.originalEvent(event.id)!.threadId);
      } else if ('fileUploaded' in result) {
        d.status = 'sent'; d.sentAt = this.now(); d.externalFileId = result.externalFileId;
        if (d.fileId) this.store.db.prepare('UPDATE teaching_files SET content=NULL WHERE id=?').run(d.fileId);
      } else { d.status = 'unknown'; d.error = result.error; }
      this.store.saveDelivery(d);
    });
  }
  /** Rebuild only QA membership; classification never changes author, grant or teaching policy. */
  reclassify(plan: ThreadCorrection): { threadId: string; changedTaskIds: string[] } {
    const result = this.store.atomic(() => {
      const feedback = this.requiredEvent(plan.feedbackEventId);
      const teacher = this.policy.isTeacher(feedback.actor.id);
      if (!plan.reason.trim() || !plan.moves.length || plan.moves.length > 20 || new Set(plan.moves.map(m => m.eventId)).size !== plan.moves.length) throw new DomainError('invalid', '需提供原因和1至20条不重复消息');
      const selected = plan.moves.map(m => {
        const event = this.requiredEvent(m.eventId), assignment = this.store.assignment(m.eventId)!;
        if (assignment.revision !== m.revision) throw new DomainError('stale', '消息线程归属已更新');
        if (!teacher && event.actor.id !== feedback.actor.id) throw new DomainError('forbidden', '学生反馈只能调整自己的消息');
        return event;
      });
      const scope = selected[0];
      for (const event of [...selected, feedback]) {
        if (event.courseId !== scope.courseId || (channelKey(event.channel) !== channelKey(scope.channel) && !(teacher && event.id === feedback.id && event.channel.kind === 'management'))) throw new DomainError('forbidden', '线程纠正不能跨课程或跨渠道');
      }
      const target = plan.targetEventId ? this.requiredEvent(plan.targetEventId) : undefined;
      if (target) {
        if (selected.some(e => e.id === target.id)) throw new DomainError('invalid', '目标锚点不能同时被移动');
        if (target.courseId !== scope.courseId || channelKey(target.channel) !== channelKey(scope.channel)) throw new DomainError('forbidden', '目标线程不在允许范围');
        if (this.store.assignment(target.id)!.revision !== plan.targetRevision) throw new DomainError('stale', '目标锚点归属已更新');
      }
      const threadId = target?.threadId ?? randomUUID();
      if (selected.every(e => e.threadId === threadId)) throw new DomainError('invalid', '消息已经属于目标线程');
      const movedIds = new Set(selected.map(e => e.id));
      const recipients = this.store.subscribers(threadId).filter(t => !['cancelled', 'superseded'].includes(t.status));
      const sources = this.store.tasks().filter(t => this.store.inputs(t.id).some(i => movedIds.has(i.event.id)));
      if ([...sources, ...recipients].some(t => t.kind !== 'qa' || t.grant.purpose === 'teacher-work')) throw new DomainError('forbidden', '线程分类只能重建答疑上下文，不能改动其他业务任务');
      const history = selected.map(e => ({ eventId: e.id, from: this.store.assignment(e.id)!, to: threadId }));
      for (const e of selected) this.store.moveEvent(e.id, threadId);
      this.memory.invalidateEvents([...movedIds]);
      const affected = new Map([...sources, ...recipients].map(t => [t.id, t]));
      for (const task of affected.values()) {
        for (const id of movedIds) this.store.db.prepare('DELETE FROM task_inputs WHERE task_id=? AND event_id=?').run(task.id, id);
        if (recipients.some(t => t.id === task.id)) for (const e of selected) this.store.input(task.id, e.id);
        const remaining = this.store.inputs(task.id);
        const stopped = ['cancelled', 'superseded'].includes(task.status);
        const rootMoved = !!task.grant.originEventId && movedIds.has(task.grant.originEventId) && !recipients.some(t => t.id === task.id);
        task.revision++; task.inputEpoch++; task.consumedSeq = 0; task.updatedAt = this.now();
        delete task.lease; delete task.leaseUntil; delete task.result; delete task.checkpoint; delete task.error;
        if (!stopped && (rootMoved || !remaining.length)) {
          task.status = 'superseded';
          // Preserve immutable authorization; recreate remaining conversation as a new task.
          for (const input of remaining) this.store.requeueEvent(input.event.id);
        } else if (!stopped && task.status !== 'paused') task.status = 'queued';
        this.store.saveTask(task); this.withdraw(task.id);
      }
      for (const e of selected) {
        if (recipients.length) this.store.markRouted(e.id);
        else this.store.requeueEvent(e.id);
      }
      const record = { moves: history, changedTaskIds: [...affected.keys()], feedbackActor: feedback.actor.id };
      this.store.db.prepare('INSERT INTO thread_changes(id,feedback_event_id,at,reason,data) VALUES(?,?,?,?,?)').run(randomUUID(), feedback.id, this.now(), plan.reason, JSON.stringify(record));
      this.store.audit('thread.reclassified', record);
      return { threadId, changedTaskIds: [...affected.keys()] };
    });
    for (const id of result.changedTaskIds) this.onControl?.(id);
    this.refreshMemoryContexts();
    return result;
  }
  private addInput(task: Task, event: Event): void {
    if (!task.grant.channel || channelKey(task.grant.channel) !== channelKey(event.channel)) throw new DomainError('forbidden', '订阅跨越渠道范围');
    if (!this.store.input(task.id, event.id)) return;
    task.inputEpoch++; task.updatedAt = this.now();
    if (task.status === 'completed' || task.status === 'blocked') task.status = 'queued';
    this.store.saveTask(task); this.withdraw(task.id);
  }
  private withdraw(taskId: string): void {
    for (const d of this.store.deliveries()) if (d.taskId === taskId && d.status === 'pending') { d.status = 'withdrawn'; this.store.saveDelivery(d); }
  }
  private assertRun(run: Run): Task {
    const task = this.requiredTask(run.task.id);
    this.assertTaskScope(task);
    if (!this.memory.validReads(run.memoryReads)) throw new DomainError('stale', '读取的学生记忆已修订，重新构造上下文');
    if (!this.validAssignments(task.courseId, run.assignmentReads)) throw new DomainError('stale', '读取的作业已修订或撤回，重新获取资料');
    if (task.status !== 'running' || task.revision !== run.revision || task.inputEpoch !== run.inputEpoch || task.lease !== run.lease || (task.leaseUntil ?? 0) <= this.now() || (this.store.course(task.courseId)?.revision ?? 1) !== (run.course.revision ?? 1)) throw new DomainError('stale', '运行已失效，拒绝旧结果');
    return task;
  }
  private requiredTask(id: string): Task { const t = this.store.task(id); if (!t) throw new DomainError('not_found', '任务不存在'); return t; }
  private requiredEvent(id: string): Event { const e = this.store.event(id); if (!e) throw new DomainError('not_found', '事件不存在'); return e; }
}
