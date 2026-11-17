import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Course, Delivery, Event, Input, Task, ThreadAssignment } from '../../domain/model.ts';

/** Single backend owner; all domain changes use synchronous transactions. */
export class Store {
  db: DatabaseSync;
  private savepoint = 0;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.db.exec(readFileSync(new URL('../../../migrations/001-runtime.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('../../../migrations/002-thread-revisions.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('../../../migrations/003-academics.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('../../../migrations/004-memory.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('../../../migrations/005-private-courses.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('../../../migrations/006-teacher-work.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('../../../migrations/007-teacher-followups.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('../../../migrations/008-activities.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('../../../migrations/009-assignment-extensions.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('../../../migrations/010-teaching-media.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('../../../migrations/011-teaching-files.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('../../../migrations/012-roster-approvals.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('../../../migrations/013-coursework-intake.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('../../../migrations/014-course-mail.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('../../../migrations/015-task-continuity.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('../../../migrations/016-teacher-conversation.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('../../../migrations/017-task-reports.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('../../../migrations/018-alerts.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('../../../migrations/020-grading-batches.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('../../../migrations/021-course-content.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('../../../migrations/022-course-files.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('../../../migrations/023-submission-files.sql', import.meta.url), 'utf8'));
  }
  atomic<T>(fn: () => T): T {
    if (this.db.isTransaction) {
      const name = 'nested_' + ++this.savepoint;
      this.db.exec('SAVEPOINT ' + name);
      try { const value = fn(); this.db.exec('RELEASE ' + name); return value; }
      catch (error) { this.db.exec('ROLLBACK TO ' + name); this.db.exec('RELEASE ' + name); throw error; }
    }
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  course(id: string): Course | undefined {
    const row = this.db.prepare('SELECT * FROM courses WHERE id=?').get(id);
    const details = this.db.prepare('SELECT data FROM course_details WHERE course_id=?').get(id);
    return row ? { revision: 1, ...(details ? JSON.parse(String(details.data)) : {}), id: String(row.id), title: String(row.title), groupId: row.group_id ? String(row.group_id) : undefined, instructions: String(row.instructions) } : undefined;
  }
  courses(): Course[] { return this.db.prepare('SELECT id FROM courses ORDER BY rowid').all().map(row => this.course(String(row.id))!); }
  courseForGroup(groupId: string): Course | undefined {
    const row = this.db.prepare('SELECT id FROM courses WHERE group_id=?').get(groupId);
    return row ? this.course(String(row.id)) : undefined;
  }
  saveCourse(c: Course): void {
    this.db.prepare('INSERT INTO courses(id,title,group_id,instructions) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,group_id=excluded.group_id,instructions=excluded.instructions').run(c.id, c.title, c.groupId ?? null, c.instructions);
    this.db.prepare('INSERT INTO course_details(course_id,data) VALUES(?,?) ON CONFLICT(course_id) DO UPDATE SET data=excluded.data').run(c.id, JSON.stringify(c));
  }
  originalEvent(id: string): Event | undefined { return this.getJson('events', id); }
  event(id: string): Event | undefined {
    const event = this.originalEvent(id);
    return event ? { ...event, threadId: this.assignment(id)?.threadId ?? event.threadId } : undefined;
  }
  assignment(id: string): ThreadAssignment | undefined {
    const row = this.db.prepare('SELECT * FROM event_threads WHERE event_id=?').get(id);
    return row ? { eventId: id, threadId: String(row.thread_id), revision: Number(row.revision) } : undefined;
  }
  eventByKey(key: string): Event | undefined {
    const row = this.db.prepare('SELECT data FROM events WHERE source_key=?').get(key);
    return row ? this.event((JSON.parse(String(row.data)) as Event).id) : undefined;
  }
  saveEvent(e: Event): void {
    this.db.prepare('INSERT INTO events(id,source_key,thread_id,course_id,data) VALUES(?,?,?,?,?)').run(e.id, e.sourceKey, e.threadId, e.courseId, JSON.stringify(e));
    this.db.prepare('INSERT INTO event_threads(event_id,thread_id) VALUES(?,?)').run(e.id, e.threadId);
  }
  pendingEvents(): Event[] { return this.eventRows('SELECT id FROM events WHERE routed=0 ORDER BY rowid'); }
  routed(id: string): boolean {
    const row = this.db.prepare('SELECT routed FROM events WHERE id=?').get(id);
    return !row || Number(row.routed) !== 0;
  }
  pendingReviews(): Event[] { return this.eventRows('SELECT id FROM events WHERE routed=2 ORDER BY rowid'); }
  events(): Event[] { return this.eventRows('SELECT id FROM events ORDER BY rowid'); }
  review(id: string): void { this.db.prepare('UPDATE events SET routed=2,error=NULL WHERE id=?').run(id); }
  requeueEvent(id: string): void { this.db.prepare('UPDATE events SET routed=0,error=NULL WHERE id=?').run(id); }
  markRouted(id: string, error?: string): void { this.db.prepare('UPDATE events SET routed=1,error=? WHERE id=?').run(error ?? null, id); }
  task(id: string): Task | undefined { return this.getJson('tasks', id); }
  tasks(): Task[] { return this.jsonRows('SELECT data FROM tasks ORDER BY rowid'); }
  saveTask(t: Task): void {
    this.db.prepare('INSERT INTO tasks(id,course_id,status,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data').run(t.id, t.courseId, t.status, JSON.stringify(t));
  }
  subscribe(taskId: string, threadId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO subscriptions(task_id,thread_id) VALUES(?,?)').run(taskId, threadId);
  }
  subscribers(threadId: string): Task[] {
    return this.jsonRows('SELECT t.data FROM tasks t JOIN subscriptions s ON s.task_id=t.id WHERE s.thread_id=?', threadId);
  }
  input(taskId: string, eventId: string): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO task_inputs(task_id,event_id) VALUES(?,?)').run(taskId, eventId).changes === 1;
  }
  inputs(taskId: string, after = 0): Input[] {
    const rows = this.db.prepare('SELECT i.seq,e.data FROM task_inputs i JOIN events e ON e.id=i.event_id WHERE i.task_id=? AND i.seq>? ORDER BY e.rowid').all(taskId, after);
    return rows.map(r => ({ seq: Number(r.seq), event: this.event((JSON.parse(String(r.data)) as Event).id)! }));
  }
  delivery(id: string): Delivery | undefined { return this.getJson('deliveries', id); }
  deliveries(): Delivery[] { return this.jsonRows('SELECT data FROM deliveries ORDER BY rowid'); }
  saveDelivery(d: Delivery): void {
    this.db.prepare('INSERT INTO deliveries(id,task_id,status,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data').run(d.id, d.taskId, d.status, JSON.stringify(d));
  }
  link(channel: string, externalId: string, threadId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO reply_links(channel_key,external_id,thread_id) VALUES(?,?,?)').run(channel, externalId, threadId);
  }
  moveEvent(id: string, threadId: string): void {
    const e = this.event(id)!;
    this.db.prepare('UPDATE event_threads SET thread_id=?,revision=revision+1 WHERE event_id=?').run(threadId, id);
    // Source-message quotations follow corrected membership; sent-answer links stay historical.
    this.db.prepare('UPDATE reply_links SET thread_id=? WHERE channel_key=? AND external_id=?').run(threadId, `${e.channel.kind}:${e.channel.target}`, e.externalId);
  }
  threadForReply(channel: string, externalId: string): string | undefined {
    const row = this.db.prepare('SELECT thread_id FROM reply_links WHERE channel_key=? AND external_id=?').get(channel, externalId);
    return row ? String(row.thread_id) : undefined;
  }
  quotedText(event: Event): { text: string; author: 'bot' | 'teacher' | 'student'; imageId?: string; format?: string } | undefined {
    if (!event.quotedExternalId) return undefined;
    const channel = `${event.channel.kind}:${event.channel.target}`;
    if (this.threadForReply(channel, event.quotedExternalId) !== event.threadId) return undefined;
    const source = this.eventByKey(`qq:${channel}:${event.quotedExternalId}`);
    if (source?.courseId === event.courseId && source.threadId === event.threadId) return { text: source.text, author: source.actor.role };
    const row = this.db.prepare("SELECT d.data, m.image_id FROM deliveries d JOIN tasks t ON t.id=d.task_id LEFT JOIN teaching_replies m ON m.delivery_id=d.id WHERE t.course_id=? AND d.status='sent' AND json_extract(d.data,'$.externalId')=? AND json_extract(d.data,'$.channel.kind')=? AND json_extract(d.data,'$.channel.target')=?")
      .get(event.courseId, event.quotedExternalId, event.channel.kind, event.channel.target);
    if (!row) return undefined;
    const delivery = JSON.parse(String(row.data)) as Delivery;
    return { text: delivery.text, author: 'bot', imageId: row.image_id ? String(row.image_id) : undefined, format: delivery.format };
  }
  teachingImage(courseId: string, id: string): Buffer | undefined {
    const png = this.db.prepare('SELECT png FROM teaching_images WHERE id=? AND course_id=?').get(id, courseId)?.png;
    return png instanceof Uint8Array ? Buffer.from(png) : undefined;
  }
  saveTeachingImage(id: string, courseId: string, png: Buffer, source?: string): void {
    this.db.prepare('INSERT OR IGNORE INTO teaching_images(id,course_id,png,created_at,source) VALUES(?,?,?,?,?)').run(id, courseId, png, Date.now(), source ?? null);
  }
  audit(kind: string, data: unknown): void {
    this.db.prepare('INSERT INTO audit(at,kind,data) VALUES(?,?,?)').run(Date.now(), kind, JSON.stringify(data));
  }
  close(): void { this.db.close(); }
  teachingFile(courseId: string, id: string): { name: string; content: Buffer } | undefined {
    const row = this.db.prepare('SELECT name,content FROM teaching_files WHERE id=? AND course_id=?').get(id, courseId);
    return row?.content instanceof Uint8Array ? { name: String(row.name), content: Buffer.from(row.content) } : undefined;
  }
  private getJson<T>(table: 'tasks' | 'events' | 'deliveries', id: string): T | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);
    return row ? JSON.parse(String(row.data)) as T : undefined;
  }
  private eventRows(sql: string): Event[] { return this.db.prepare(sql).all().map(r => this.event(String(r.id))!); }
  private jsonRows<T>(sql: string, ...args: string[]): T[] {
    return this.db.prepare(sql).all(...args).map(r => JSON.parse(String(r.data)) as T);
  }
}
