import { randomUUID } from 'node:crypto';
import { DomainError } from '../../domain/model.ts';
import type { TaskEngine } from '../task-engine.ts';

export type ContentKind = 'material' | 'group-file' | 'submission';
export type ContentHit = { ref: string; kind: ContentKind; title: string; snippet: string; version: number; updatedAt: number };
export type ContentRow = {
  ref: string; kind: ContentKind; title: string; text: string; visibility: 'draft' | 'published' | 'private';
  source: string; version: number; updatedAt: number; publishedAt?: number;
};

/**
 * 课程内容层：讲义、群文件、提交进入同一张表，用稳定引用访问。
 * 学生只看 published；教师可看 draft。写入仍走各自业务入口，这里只负责索引与读取。
 */
export class CourseContent {
  private engine: TaskEngine;
  constructor(engine: TaskEngine) { this.engine = engine; }
  private db() { return this.engine.store.db; }

  /** 把课程任务的结果与产物同步进内容表；发布状态由「是否发过群」决定。 */
  reindex(courseId: string): void {
    const sent = new Set(this.engine.store.deliveries()
      .filter(delivery => delivery.status === 'sent' && delivery.channel.kind === 'qq-group')
      .map(delivery => delivery.taskId));
    const upsert = this.db().prepare(`INSERT INTO course_content(id,course_id,ref,kind,title,text,visibility,owner,source,version,published_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(ref) DO UPDATE SET title=excluded.title,text=excluded.text,visibility=excluded.visibility,
      version=excluded.version,published_at=excluded.published_at,updated_at=excluded.updated_at`);
    for (const task of this.engine.store.tasks()) {
      if (task.courseId !== courseId || ['cancelled', 'superseded'].includes(task.status)) continue;
      const published = sent.has(task.id);
      const visibility = published ? 'published' : 'draft';
      const at = this.engine.now();
      if (task.result?.trim()) {
        upsert.run(randomUUID(), courseId, `task/${task.id}/result`, 'material', task.goal.slice(0, 200),
          task.result.slice(0, 100_000), visibility, null, `task:${task.id}`, task.revision, published ? at : null, at);
      }
      for (const artifact of task.artifacts ?? []) {
        upsert.run(randomUUID(), courseId, `task/${task.id}/file/${artifact.sha256}`, 'group-file', artifact.name,
          '', visibility, null, `artifact:${task.id}:${artifact.sha256}`, task.revision, published ? at : null, at);
      }
    }
  }

  search(courseId: string, actor: string, query: string, options: { teacher?: boolean; kinds?: ContentKind[]; limit?: number } = {}): ContentHit[] {
    const term = query.trim();
    if (!term) return [];
    this.reindex(courseId);
    const kinds = options.kinds?.length ? options.kinds : ['material', 'group-file', 'submission'];
    const like = '%' + term.replace(/[%_]/g, match => '\\' + match) + '%';
    const scope = options.teacher ? '1=1' : "(visibility='published' OR (visibility='private' AND owner=?))";
    const params = options.teacher ? [] : [actor];
    const rows = this.db().prepare(`SELECT ref,kind,title,text,version,updated_at AS updatedAt,visibility,owner FROM course_content
      WHERE course_id=? AND revoked_at IS NULL AND kind IN (${kinds.map(() => '?').join(',')})
      AND ${scope}
      AND (title LIKE ? ESCAPE '\\' OR text LIKE ? ESCAPE '\\')
      ORDER BY (title LIKE ? ESCAPE '\\') DESC, updated_at DESC LIMIT ?`)
      .all(courseId, ...kinds, ...params, like, like, like, Math.min(Math.max(options.limit ?? 8, 1), 20)) as
      { ref: string; kind: ContentKind; title: string; text: string; version: number; updatedAt: number; visibility: string; owner: string | null }[];
    return rows.map(row => ({
      ref: row.ref, kind: row.kind, title: row.title, version: row.version, updatedAt: row.updatedAt,
      snippet: snippet(row.text || row.title, term),
    }));
  }

  open(courseId: string, actor: string, ref: string, options: { teacher?: boolean } = {}): ContentRow {
    const row = this.db().prepare(`SELECT ref,kind,title,text,visibility,source,version,updated_at AS updatedAt,published_at AS publishedAt,owner
      FROM course_content WHERE course_id=? AND ref=? AND revoked_at IS NULL`).get(courseId, ref) as
      (ContentRow & { visibility: ContentRow['visibility']; owner?: string | null }) | undefined;
    if (!row) throw new DomainError('not_found', '找不到这条课程内容');
    if (row.visibility === 'draft' && !options.teacher) throw new DomainError('forbidden', '这份内容还没有发布，学生暂时看不到');
    if (row.visibility === 'private' && row.owner !== actor) throw new DomainError('forbidden', '只能查看自己的提交');
    return row;
  }
}

function snippet(text: string, term: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(term.toLowerCase());
  if (at < 0) return flat.slice(0, 160);
  return flat.slice(Math.max(0, at - 60), at + term.length + 100);
}
