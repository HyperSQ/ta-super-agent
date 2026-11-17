import { AsyncLocalStorage } from 'node:async_hooks';
import type { Store } from '../adapters/storage/sqlite.ts';

export type ActivityNode = 'intake' | 'router' | 'worker' | 'tools' | 'memory' | 'outbox';
type Scope = { courseId: string; eventId: string; taskId?: string; runId?: string; node: ActivityNode };
const active = new AsyncLocalStorage<{ store: Store; scope: Scope }>();
const sensitiveField = /^(?:authorization|.*password|.*secret|.*api_?key|.*access_?token|admin_?token|llbot_?token|data_?url|image_?url|reasoning_?content)$/i;

function payloadOf(value: unknown): string {
  const serialized = JSON.stringify(value ?? null, (key, item: unknown) => {
    if (sensitiveField.test(key)) return '[已省略]';
    if (typeof item !== 'string') return item;
    const text = item.replace(/data:[\w/+.-]+;base64,[A-Za-z0-9+/=]+/gi, '[图像数据已省略]')
      .replace(/\bBearer\s+[\w.:-]+|\bsk-[\w-]{8,}/gi, '[凭据已省略]');
    return text.length > 24_000 ? text.slice(0, 24_000) + '\n[字段已截断]' : text;
  });
  return serialized.length > 120_000 ? JSON.stringify({ preview: serialized.slice(0, 120_000), truncated: true }) : serialized;
}

export function activity(store: Store, scope: Scope, kind: string, label: string, payload?: unknown): void {
  try {
    store.db.prepare('INSERT INTO activities(at,course_id,event_id,task_id,run_id,node,kind,label,payload) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(Date.now(), scope.courseId, scope.eventId, scope.taskId ?? null, scope.runId ?? null, scope.node, kind, label, payloadOf(payload));
  } catch (error) {
    console.error('活动记录写入失败', error instanceof Error ? error.name : 'unknown');
  }
}

export function inActivity<T>(store: Store, scope: Scope, operation: () => T): T {
  return active.run({ store, scope }, operation);
}

export function currentActivity(kind: string, label: string, payload?: unknown, node?: ActivityNode): void {
  const context = active.getStore();
  if (context) activity(context.store, { ...context.scope, node: node ?? context.scope.node }, kind, label, payload);
}

const metadata = 'seq,at,event_id AS eventId,task_id AS taskId,run_id AS runId,node,kind,label';
export function activityPage(store: Store, course: string, before: number, event?: string) {
  const rows = event
    ? store.db.prepare(`SELECT ${metadata} FROM activities WHERE course_id=? AND event_id=? AND seq<? ORDER BY seq DESC LIMIT 61`).all(course, event, before)
    : store.db.prepare(`SELECT ${metadata} FROM activities WHERE course_id=? AND seq<? ORDER BY seq DESC LIMIT 61`).all(course, before);
  const entries = rows.slice(0, 60);
  return { entries, next: rows.length > 60 ? entries.at(-1)?.seq : undefined };
}

export function activityDetail(store: Store, course: string, seq: number) {
  const row = store.db.prepare(`SELECT ${metadata},payload FROM activities WHERE course_id=? AND seq=?`).get(course, seq);
  return row && { ...row, payload: JSON.parse(String(row.payload)) };
}
