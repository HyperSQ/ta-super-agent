import { randomUUID } from 'node:crypto';
import type { TaskEngine } from './task-engine.ts';
import type { Store } from '../adapters/storage/sqlite.ts';
import { currentActivity } from './activities.ts';

export type AlertRule = 'stalled_task' | 'unknown_delivery';
export type Alert = {
  id: string; courseId: string; rule: AlertRule; targetId: string;
  severity: 'warning' | 'critical'; detail: string; at: number;
};
export type WatchdogOptions = {
  now?: () => number;
  intervalMs?: number;
  stallMs?: number;
  cooldownMs?: number;
};

/**
 * 规则型 Watchdog：只看租约、阶段进展与交付回执，不调用模型，也不改动任务。
 * 告警按 (course, rule, target) 去重，冷却期内的重复扫描不会刷屏。
 */
export class Watchdog {
  private engine: TaskEngine;
  private now: () => number;
  private intervalMs: number;
  private stallMs: number;
  private cooldownMs: number;
  private lastScan = 0;

  constructor(engine: TaskEngine, options: WatchdogOptions = {}) {
    this.engine = engine;
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? 15_000;
    this.stallMs = options.stallMs ?? 180_000;
    this.cooldownMs = options.cooldownMs ?? 600_000;
  }

  tick(): Alert[] {
    const now = this.now();
    if (now - this.lastScan < this.intervalMs) return [];
    this.lastScan = now;
    return this.scan(now);
  }

  scan(now = this.now()): Alert[] {
    const raised: Alert[] = [];
    const db = this.engine.store.db;
    const lastActivity = (taskId: string, fallback: number) => {
      const row = db.prepare('SELECT max(at) AS at FROM activities WHERE task_id=?').get(taskId);
      return Number(row?.at ?? 0) || fallback;
    };
    for (const task of this.engine.store.tasks()) {
      if (task.status !== 'running') continue;
      const latest = lastActivity(task.id, task.updatedAt);
      if (now - latest < this.stallMs) continue;
      const stage = (task.checkpoint?.value as { stage?: unknown } | undefined)?.stage;
      raised.push(this.raise({
        courseId: task.courseId, rule: 'stalled_task', targetId: task.id, severity: 'warning',
        detail: `任务运行超过 ${Math.round((now - latest) / 60_000)} 分钟没有新进展${typeof stage === 'string' ? `（阶段 ${stage}）` : ''}`,
      }, now));
    }
    for (const delivery of this.engine.store.deliveries()) {
      if (delivery.status !== 'unknown') continue;
      const task = this.engine.store.task(delivery.taskId);
      if (!task) continue;
      // 刚标记为 unknown 的先留一分钟给人工核对，避免启动时刷屏。
      if (now - task.updatedAt < 60_000) continue;
      raised.push(this.raise({
        courseId: task.courseId, rule: 'unknown_delivery', targetId: delivery.id, severity: 'critical',
        detail: '外发结果未知，需要人工核对是否送达；不会自动重发',
      }, now));
    }
    return raised;
  }

  private raise(input: Omit<Alert, 'id' | 'at'>, now: number): Alert {
    const db = this.engine.store.db;
    const existing = db.prepare('SELECT * FROM alerts WHERE course_id=? AND rule=? AND target_id=?')
      .get(input.courseId, input.rule, input.targetId) as Record<string, unknown> | undefined;
    const alert: Alert = {
      id: existing ? String(existing.id) : randomUUID(), courseId: input.courseId, rule: input.rule,
      targetId: input.targetId, severity: input.severity, detail: input.detail, at: now,
    };
    if (existing && now - Number(existing.at) < this.cooldownMs) return alert;
    db.prepare('INSERT INTO alerts(id,course_id,rule,target_id,severity,detail,at) VALUES(?,?,?,?,?,?,?) ' +
      'ON CONFLICT(course_id,rule,target_id) DO UPDATE SET severity=excluded.severity,detail=excluded.detail,at=excluded.at')
      .run(alert.id, alert.courseId, alert.rule, alert.targetId, alert.severity, alert.detail, alert.at);
    currentActivity('watchdog.alert', alert.detail, { rule: alert.rule, targetId: alert.targetId, severity: alert.severity }, 'router');
    return alert;
  }
}

export function listAlerts(store: Store, courseId: string, limit = 20): Alert[] {
  const rows = store.db.prepare('SELECT * FROM alerts WHERE course_id=? ORDER BY at DESC LIMIT ?').all(courseId, limit) as Record<string, unknown>[];
  return rows.map(row => ({
    id: String(row.id), courseId: String(row.course_id), rule: String(row.rule) as AlertRule,
    targetId: String(row.target_id), severity: String(row.severity) as Alert['severity'],
    detail: String(row.detail), at: Number(row.at),
  }));
}
