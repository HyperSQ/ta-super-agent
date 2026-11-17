import { Router } from '../agents/router.ts';
import { TaskRunner } from './task-runner.ts';
import { DeliveryOutbox } from './delivery-outbox.ts';
import { TaskEngine } from './task-engine.ts';
import type { ThreadClassifier } from '../agents/thread-classifier.ts';
import type { MemoryUpdater } from './memory-updater.ts';
import { inActivity, currentActivity } from './activities.ts';
import { WeeklyLesson } from './weekly-lesson.ts';
import type { Watchdog } from './watchdog.ts';
import type { Event } from '../domain/model.ts';

export type RuntimeOptions = {
  /** 同线程待处理自然语言的合并窗口；0 表示不合并（默认）。 */
  batchMs?: number;
  now?: () => number;
  watchdog?: Watchdog;
  batches?: { tick(now?: number): unknown };
};

export class Runtime {
  engine: TaskEngine; router: Router; runner: TaskRunner; outbox: DeliveryOutbox;
  private routing = new Set<string>();
  private routeScopes = new Set<string>();
  private routeJobs = new Set<Promise<void>>();
  private controller = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private sending?: Promise<void>;
  private reviewing = new Set<string>();
  private batches = new Map<string, { at: number; events: Event[] }>();
  private batched = new Set<string>();
  private flushing = 0;
  private batchMs: number;
  private now: () => number;
  classifier?: ThreadClassifier;
  memoryUpdater?: MemoryUpdater;
  watchdog?: Watchdog;
  gradingBatches?: { tick(now?: number): unknown };
  private weekly: WeeklyLesson;
  constructor(engine: TaskEngine, router: Router, runner: TaskRunner, outbox: DeliveryOutbox,
    classifier?: ThreadClassifier, memoryUpdater?: MemoryUpdater, options: RuntimeOptions = {}) {
    this.engine = engine; this.router = router; this.runner = runner; this.outbox = outbox;
    this.classifier = classifier;
    this.memoryUpdater = memoryUpdater;
    this.batchMs = options.batchMs ?? 0;
    this.now = options.now ?? Date.now;
    this.watchdog = options.watchdog;
    this.gradingBatches = options.batches;
    this.weekly = new WeeklyLesson(engine, router.model);
  }
  start(): void {
    this.engine.recover(); this.tick();
    this.timer = setInterval(() => this.tick(), 100);
  }
  tick(): void {
    if (this.controller.signal.aborted) return;
    this.engine.recoverRuns();
    this.engine.refreshMemoryContexts();
    this.weekly.tick();
    this.watchdog?.tick();
    try { this.gradingBatches?.tick(this.now()); } catch (error) { this.engine.store.audit('grading.batch_failed', { error: error instanceof Error ? error.message : '批改批次失败' }); }
    this.reviewPending();
    this.schedulePending();
    // 刚冲刷过一批时让出这一拍，等批量路由把输入放进同一任务后再让 Runner 领取。
    if (this.flushing === 0) this.runner.tick();
    this.memoryUpdater?.tick();
    if (!this.sending) {
      this.sending = this.outbox.tick().catch(error => { this.engine.store.audit('delivery.failed', { error: error instanceof Error ? error.message : '交付失败' }); }).finally(() => { this.sending = undefined; });
    }
  }
  private reviewPending(): void {
    if (!this.classifier) return;
    for (const event of this.engine.store.pendingReviews()) {
      if (this.reviewing.size >= 2) break;
      if (this.reviewing.has(event.id)) continue;
      this.reviewing.add(event.id);
      const job = inActivity(this.engine.store, { node: 'router', courseId: event.courseId, eventId: event.id }, async () => {
        currentActivity('review.start', '开始线程复核');
        await this.classifier!.reconsider(event.id, this.controller.signal);
        currentActivity('review.finish', '结束线程复核', this.engine.store.assignment(event.id));
      }).catch(error => {
        if (!this.controller.signal.aborted) {
          this.engine.store.markRouted(event.id, error instanceof Error ? error.message : '线程复核失败');
          this.engine.store.audit('thread.review_failed', { eventId: event.id });
        }
      }).finally(() => { this.reviewing.delete(event.id); this.routeJobs.delete(job); });
      this.routeJobs.add(job);
    }
  }
  private immediate(event: Event): boolean {
    // 教师消息与显式命令不延迟；只合并学生的自然语言。
    if (this.engine.policy.isTeacher(event.actor.id)) return true;
    return /^\/(?:task|lesson|thread)\b/u.test(event.text);
  }
  private schedulePending(): void {
    const now = this.now();
    const ready: Event[] = [];
    for (const event of this.engine.store.pendingEvents()) {
      if (this.routing.has(event.id) || this.batched.has(event.id)) continue;
      if (this.batchMs <= 0 || this.immediate(event)) { ready.push(event); continue; }
      const key = event.courseId + '\0' + event.threadId;
      const batch = this.batches.get(key) ?? { at: now, events: [] };
      if (!this.batches.has(key)) this.batches.set(key, batch);
      batch.events.push(event);
      this.batched.add(event.id);
    }
    for (const event of ready) this.scheduleRoute(event);
    if (this.batchMs <= 0 || !this.batches.size || this.routing.size >= 4) return;
    for (const [key, batch] of [...this.batches]) {
      if (now - batch.at < this.batchMs) continue;
      this.batches.delete(key);
      for (const event of batch.events) this.batched.delete(event.id);
      this.scheduleBatch(batch.events);
    }
  }
  private scheduleRoute(event: Event): void {
    if (this.routing.size >= 4) return;
    const scope = this.engine.policy.isTeacher(event.actor.id) ? `teacher-course:${event.courseId}` : `thread:${event.threadId}`;
    if (this.routeScopes.has(scope)) return;
    this.routing.add(event.id);
    this.routeScopes.add(scope);
    const job = inActivity(this.engine.store, { node: 'router', courseId: event.courseId, eventId: event.id }, async () => {
      currentActivity('route.start', '进入 Router');
      try {
        await this.router.route(event, this.controller.signal);
        currentActivity('route.finish', 'Router 处理完成');
      } catch (error) {
        currentActivity('route.error', 'Router 处理失败', { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }).catch(error => {
      if (!this.controller.signal.aborted) {
        this.engine.store.markRouted(event.id, error instanceof Error ? error.message : '路由失败');
        this.engine.store.audit('routing.failed', { eventId: event.id, error: error instanceof Error ? error.message : '路由失败' });
      }
    }).finally(() => { this.routing.delete(event.id); this.routeScopes.delete(scope); this.routeJobs.delete(job); });
    this.routeJobs.add(job);
  }
  private scheduleBatch(events: Event[]): void {
    if (!events.length) return;
    const first = [...events].sort((a, b) => a.receivedAt - b.receivedAt)[0];
    const scope = `thread:${first.threadId}`;
    if (this.routeScopes.has(scope)) {
      // 该线程正在路由：下一拍重新入批，避免并发重复处理。
      for (const event of events) this.batched.delete(event.id);
      return;
    }
    this.routeScopes.add(scope);
    for (const event of events) this.routing.add(event.id);
    this.flushing++;
    const job = inActivity(this.engine.store, { node: 'router', courseId: first.courseId, eventId: first.id }, async () => {
      currentActivity('route.batch', 'Router 批量处理', { eventIds: events.map(event => event.id) });
      await this.router.routeBatch(events, this.controller.signal);
    }).catch(error => {
      if (!this.controller.signal.aborted) {
        for (const event of events) this.engine.store.markRouted(event.id, error instanceof Error ? error.message : '路由失败');
        this.engine.store.audit('routing.failed', { eventId: first.id, error: error instanceof Error ? error.message : '路由失败', batch: events.length });
      }
    }).finally(() => {
      for (const event of events) this.routing.delete(event.id);
      this.routeScopes.delete(scope);
      this.routeJobs.delete(job);
      this.flushing = Math.max(0, this.flushing - 1);
    });
    this.routeJobs.add(job);
  }
  async stop(): Promise<void> {
    clearInterval(this.timer); this.controller.abort(new Error('服务停止'));
    await Promise.all([...this.routeJobs, this.runner.stop(), this.sending, this.memoryUpdater?.stop(), this.weekly.stop()]);
  }
}
