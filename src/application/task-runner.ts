import type { Worker } from '../agents/workers/qa-worker.ts';
import { TaskEngine } from './task-engine.ts';
import type { Run } from '../domain/model.ts';
import { workerProfile } from '../domain/model.ts';
import type { RunGuard } from '../ports/qq-access.ts';
import { inActivity, currentActivity } from './activities.ts';
import { taskHandoff } from './task-memory.ts';

export class TaskRunner {
  engine: TaskEngine; worker: Worker; concurrency: number;
  active = new Map<string, { controller: AbortController; promise: Promise<void>; run: Run }>();
  guard?: RunGuard;
  constructor(engine: TaskEngine, worker: Worker, concurrency = 3, guard?: RunGuard) {
    this.engine = engine; this.worker = worker; this.concurrency = concurrency;
    this.guard = guard;
    engine.onControl = id => this.active.get(id)?.controller.abort(new Error('任务控制已更新'));
  }
  tick(): void {
    for (const task of this.engine.store.tasks()) {
      if (this.active.size >= this.concurrency) break;
      if (task.status !== 'queued' || this.active.has(task.id)) continue;
      if (task.kind === 'teaching-affairs' && [...this.active.values()].some(({ run }) =>
        run.task.kind === task.kind && run.task.courseId === task.courseId)) continue;
      const origin = task.grant.originEventId && this.engine.store.event(task.grant.originEventId);
      if (origin && origin.scheduledWorker === 'dsh' &&
        [...this.active.values()].some(({ run }) => run.history[0]?.event.scheduledWorker === 'dsh')) continue;
      const run = this.engine.claim(task.id);
      if (!run) continue;
      const controller = new AbortController();
      // Even an adapter ignoring cancellation cannot commit a result from an invalid run.
      const eventId = run.history.at(-1)?.event.id ?? task.grant.originEventId ?? task.id;
      const promise = Promise.resolve().then(() => inActivity(this.engine.store, { node: 'worker', courseId: task.courseId, eventId, taskId: task.id, runId: run.lease }, async () => {
        const renewal = setInterval(() => {
          try { this.engine.renew(run); }
          catch (error) { controller.abort(error); }
        }, 30_000);
        try {
          if (this.guard) await this.guard.authorizeRun(run, controller.signal);
          controller.signal.throwIfAborted();
          const handoff = taskHandoff(this.engine, run);
          currentActivity('worker.start', 'Worker 开始运行', { kind: task.kind, profile: workerProfile(task.kind, task.grant.purpose),
            goal: task.goal, revision: run.revision, inputEventIds: run.inputs.map(input => input.event.id),
            handoff: { origin: handoff.origin?.eventId, latestInput: handoff.latestInput?.eventId, changes: handoff.recentChanges.map(change => change.eventId),
              previousRevision: handoff.previousOutput?.revision } });
          let committed = false;
          const complete = (result: Parameters<TaskEngine['finish']>[1]) => {
            controller.signal.throwIfAborted();
            this.engine.finish(run, result, { source: 'worker' });
            committed = true;
          };
          const result = await this.worker({ run, signal: controller.signal, handoff,
            checkpoint: value => this.engine.checkpoint(run, value), complete });
          if (!committed) complete(result);
          currentActivity('worker.finish', 'Worker 提交结果', result);
        } catch (error) {
          this.engine.fail(run, error);
          currentActivity('worker.error', 'Worker 运行失败', { error: error instanceof Error ? error.message : String(error), cancelled: controller.signal.aborted });
        }
        finally { clearInterval(renewal); }
      })).finally(() => { this.active.delete(task.id); });
      this.active.set(task.id, { controller, promise, run });
    }
  }
  async idle(): Promise<void> { await Promise.all([...this.active.values()].map(a => a.promise)); }
  async stop(): Promise<void> {
    for (const a of this.active.values()) { this.engine.release(a.run); a.controller.abort(new Error('服务停止')); }
    await this.idle();
  }
}
