import { randomUUID } from 'node:crypto';
import type { TaskEngine } from './task-engine.ts';

export type RouterSession = { id: string; courseId: string; threadId: string; summary: string; revision: number };
export type RouterTurn = { role: 'user' | 'assistant'; content: string; at: number };

/**
 * 常驻 Router 会话：按「课程 + 线程」保留有限的协调上下文与决策记录。
 * 不是全量聊天记录：只留最近若干轮和决策摘要，正文仍从 events 读取。
 */
export class RouterSessions {
  private engine: TaskEngine;
  private cache = new Map<string, RouterSession>();
  constructor(engine: TaskEngine) { this.engine = engine; }
  private db() { return this.engine.store.db; }

  ensure(courseId: string, threadId: string): RouterSession {
    const key = courseId + '\0' + threadId;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const now = this.engine.now();
    this.db().prepare(`INSERT OR IGNORE INTO router_sessions(id,course_id,thread_id,summary,revision,created_at,updated_at)
      VALUES(?,?,?,'',1,?,?)`).run(randomUUID(), courseId, threadId, now, now);
    const row = this.db().prepare('SELECT id,course_id AS courseId,thread_id AS threadId,summary,revision FROM router_sessions WHERE course_id=? AND thread_id=?')
      .get(courseId, threadId) as RouterSession;
    this.cache.set(key, row);
    return row;
  }

  append(session: RouterSession, role: RouterTurn['role'], content: string): void {
    const text = content.replace(/\s+/g, ' ').trim().slice(0, 2000);
    if (!text) return;
    const next = (this.db().prepare('SELECT coalesce(max(seq),0)+1 AS seq FROM router_messages WHERE session_id=?').get(session.id) as { seq: number }).seq;
    this.db().prepare('INSERT INTO router_messages(session_id,seq,role,content,created_at) VALUES(?,?,?,?,?)')
      .run(session.id, next, role, text, this.engine.now());
    this.db().prepare('UPDATE router_sessions SET updated_at=? WHERE id=?').run(this.engine.now(), session.id);
    // 只保留最近 80 条，避免会话表无限增长。
    this.db().prepare(`DELETE FROM router_messages WHERE session_id=? AND seq<=?`).run(session.id, Math.max(0, next - 80));
  }

  recent(session: RouterSession, limit = 12): RouterTurn[] {
    const rows = this.db().prepare('SELECT role,content,created_at AS at FROM router_messages WHERE session_id=? ORDER BY seq DESC LIMIT ?')
      .all(session.id, Math.min(Math.max(limit, 1), 30)) as RouterTurn[];
    return rows.reverse();
  }

  record(courseId: string, eventId: string | undefined, action: string, taskId: string | undefined, reason: string): void {
    this.db().prepare('INSERT INTO router_decisions(id,course_id,event_id,action,task_id,reason,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(randomUUID(), courseId, eventId ?? null, action, taskId ?? null, reason.slice(0, 500), this.engine.now());
  }

  decisions(courseId: string, limit = 20) {
    return this.db().prepare('SELECT action,task_id AS taskId,reason,created_at AS at FROM router_decisions WHERE course_id=? ORDER BY created_at DESC LIMIT ?')
      .all(courseId, Math.min(Math.max(limit, 1), 100));
  }
}
