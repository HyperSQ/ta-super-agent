import { createHash, randomUUID } from 'node:crypto';
import type { Store } from './sqlite.ts';
import type { MemoryCard, MemoryJob, MemoryRead } from '../../domain/memory.ts';
import type { Run } from '../../domain/model.ts';
import { channelKey } from '../../domain/model.ts';

/** Methods compose inside the caller's Store transaction. Indexes never authorize reads. */
export class MemoryRepository {
  store: Store;
  constructor(store: Store) { this.store = store; }
  get(id: string): MemoryCard | undefined {
    const row = this.store.db.prepare('SELECT data FROM memories WHERE id=?').get(id);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  list(courseId: string, subjectId?: string): MemoryCard[] {
    const rows = subjectId === undefined
      ? this.store.db.prepare('SELECT data FROM memories WHERE course_id=? ORDER BY rowid DESC').all(courseId)
      : this.store.db.prepare('SELECT data FROM memories WHERE course_id=? AND subject_id=? ORDER BY rowid DESC').all(courseId, subjectId);
    return rows.map(row => JSON.parse(String(row.data)));
  }
  valid(card: MemoryCard): boolean {
    return card.status === 'active' && card.sources.length > 0
      && (card.dependencies ?? card.sources).every(source => this.store.assignment(source.eventId)?.revision === source.threadRevision)
      && card.sources.every(source => {
      const event = this.store.event(source.eventId);
      return !!event && event.courseId === card.courseId && channelKey(event.channel) === channelKey(card.channel)
        && this.store.assignment(source.eventId)?.revision === source.threadRevision && event.text.includes(source.quote);
    });
  }
  validReads(reads: MemoryRead[] = []): boolean {
    return reads.every(read => { const card = this.get(read.id); return !!card && card.revision === read.revision && this.valid(card); });
  }
  save(card: MemoryCard): void {
    this.store.db.prepare('INSERT INTO memories(id,course_id,subject_id,status,revision,data) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,revision=excluded.revision,data=excluded.data')
      .run(card.id, card.courseId, card.subjectId, card.status, card.revision, JSON.stringify(card));
    this.store.db.prepare('DELETE FROM memory_sources WHERE memory_id=?').run(card.id);
    for (const source of card.dependencies ?? card.sources) this.store.db.prepare('INSERT INTO memory_sources(memory_id,event_id,thread_revision) VALUES(?,?,?)').run(card.id, source.eventId, source.threadRevision);
    // A changed card must be encoded again, even if its vector is still physically present.
    this.store.db.prepare('DELETE FROM memory_vectors WHERE memory_id=?').run(card.id);
  }
  enqueue(run: Run, teaching: string): void {
    const events = run.history.slice(-40).map(input => ({ event: input.event, threadRevision: this.store.assignment(input.event.id)!.revision }));
    const newEventIds = run.inputs.map(input => input.event.id);
    const subjects = [...new Set(events.filter(e => e.event.actor.role === 'student' && newEventIds.includes(e.event.id)).map(e => e.event.actor.id))];
    for (const subjectId of subjects) {
      const job: MemoryJob = {
        id: createHash('sha256').update(JSON.stringify([run.task.id, run.revision, run.throughSeq, subjectId])).digest('hex'),
        taskId: run.task.id, taskRevision: run.revision, courseRevision: run.course.revision ?? 1,
        courseId: run.course.id, subjectId, channel: run.task.grant.channel!,
        events, teaching: teaching.slice(0, 1800), anchors: run.knowledgeAnchors ?? [], createdAt: Date.now(), newEventIds,
      };
      if (!job.channel || job.channel.kind === 'management') continue;
      this.store.db.prepare('INSERT OR IGNORE INTO memory_jobs(id,status,data) VALUES(?,?,?)').run(job.id, 'pending', JSON.stringify(job));
    }
  }
  jobValid(job: MemoryJob): boolean {
    return this.store.task(job.taskId)?.revision === job.taskRevision
      && (this.store.course(job.courseId)?.revision ?? 1) === job.courseRevision
      && job.events.every(source => this.store.assignment(source.event.id)?.revision === source.threadRevision);
  }
  claim(): MemoryJob | undefined {
    return this.store.atomic(() => {
      const row = this.store.db.prepare("SELECT id,data FROM memory_jobs WHERE status='pending' ORDER BY rowid LIMIT 1").get();
      if (!row) return undefined;
      this.store.db.prepare("UPDATE memory_jobs SET status='running',attempts=attempts+1 WHERE id=?").run(String(row.id));
      return JSON.parse(String(row.data));
    });
  }
  settle(id: string, status: 'done' | 'failed' | 'invalidated', error?: string): void {
    this.store.db.prepare('UPDATE memory_jobs SET status=?,error=? WHERE id=?').run(status, error ?? null, id);
  }
  recover(): void { this.store.db.prepare("UPDATE memory_jobs SET status='pending' WHERE status='running'").run(); }
  invalidateEvents(eventIds: string[]): void {
    for (const id of eventIds) {
      const rows = this.store.db.prepare('SELECT memory_id FROM memory_sources WHERE event_id=?').all(id);
      for (const row of rows) {
        const card = this.get(String(row.memory_id))!;
        if (card.status !== 'active') continue;
        card.status = 'invalidated'; card.revision++; card.updatedAt = Date.now(); this.save(card);
        this.store.audit('memory.invalidated', { memoryId: card.id, eventId: id, revision: card.revision });
      }
    }
    // In-flight extraction also rechecks dependencies before committing.
    const jobs = this.store.db.prepare("SELECT id,data FROM memory_jobs WHERE status IN ('pending','running')").all();
    for (const row of jobs) {
      const job = JSON.parse(String(row.data)) as MemoryJob;
      if (job.events.some(e => eventIds.includes(e.event.id))) this.settle(job.id, 'invalidated');
    }
  }
  vector(card: MemoryCard, fingerprint: string): number[] | undefined {
    const row = this.store.db.prepare('SELECT data FROM memory_vectors WHERE memory_id=? AND revision=? AND fingerprint=?').get(card.id, card.revision, fingerprint);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  saveVector(card: MemoryCard, fingerprint: string, vector: number[]): void {
    const current = this.get(card.id);
    if (!current || current.revision !== card.revision || !this.valid(current)) return;
    this.store.db.prepare('INSERT INTO memory_vectors(memory_id,revision,fingerprint,data) VALUES(?,?,?,?) ON CONFLICT(memory_id) DO UPDATE SET revision=excluded.revision,fingerprint=excluded.fingerprint,data=excluded.data')
      .run(card.id, card.revision, fingerprint, JSON.stringify(vector));
  }
  newId(): string { return randomUUID(); }
}
