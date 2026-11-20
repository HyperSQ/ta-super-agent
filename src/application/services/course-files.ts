import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { DomainError } from '../../domain/model.ts';
import type { TaskEngine } from '../task-engine.ts';
import { artifactPublished, publishedDeliveries } from './publication.ts';

export type FileEntry = { path: string; name: string; bytes: number; visibility: 'draft' | 'published'; source: string };
export type FileRoots = { artifacts: string; group: string };

/**
 * 课程文件层：只登记「逻辑 path → 服务器上的文件」，不复制原文件。
 * path 以 group/ 开头的是群文件，其余是任务产物；读取时校验落在对应根目录内。
 */
export class CourseFiles {
  private engine: TaskEngine;
  private roots: FileRoots;
  constructor(engine: TaskEngine, roots: string | FileRoots) {
    this.engine = engine;
    this.roots = typeof roots === 'string' ? { artifacts: roots, group: roots } : roots;
    mkdirSync(this.roots.group, { recursive: true });
  }

  private db() { return this.engine.store.db; }
  private rootFor(path: string) { return path.startsWith('group/') ? this.roots.group : this.roots.artifacts; }

  sync(courseId: string): void {
    const published = publishedDeliveries(this.engine.store.deliveries(), this.engine.store.course(courseId)?.groupId);
    this.db().prepare("DELETE FROM course_files WHERE course_id=? AND source LIKE 'task:%'").run(courseId);
    for (const task of this.engine.store.tasks()) {
      if (task.courseId !== courseId || !task.artifacts?.length || task.memoryContextInvalidated ||
          ['cancelled', 'superseded'].includes(task.status)) continue;
      for (const artifact of task.artifacts) {
        const visibility = artifactPublished(artifact, published) ? 'published' : 'draft';
        const real = join(this.roots.artifacts, courseId, task.id, 'artifacts', artifact.name);
        if (!existsSync(real)) continue;
        this.register(courseId, `${task.id}/artifacts/${artifact.name}`, artifact.name, statSync(real).size,
          artifact.sha256, visibility, `task:${task.id}`);
      }
    }
  }

  /** 写入一条文件引用；群文件、邮件附件、提交都走这里。 */
  register(courseId: string, path: string, name: string, bytes: number, sha256: string,
    visibility: FileEntry['visibility'], source: string): void {
    this.db().prepare(`INSERT INTO course_files(course_id,path,name,bytes,sha256,visibility,source,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(course_id,path) DO UPDATE SET name=excluded.name,bytes=excluded.bytes,
      sha256=excluded.sha256,visibility=excluded.visibility,source=excluded.source,updated_at=excluded.updated_at`)
      .run(courseId, path, name, bytes, sha256, visibility, source, this.engine.now());
  }

  list(courseId: string, teacher = false): FileEntry[] {
    this.sync(courseId);
    return this.db().prepare(`SELECT path,name,bytes,visibility,source FROM course_files WHERE course_id=?
      ${teacher ? '' : "AND visibility='published'"} ORDER BY updated_at DESC, path`).all(courseId) as FileEntry[];
  }

  read(courseId: string, path: string, teacher = false): FileEntry & { content: Buffer } {
    this.sync(courseId);
    const row = this.db().prepare('SELECT path,name,bytes,visibility,source,sha256 FROM course_files WHERE course_id=? AND path=?')
      .get(courseId, path) as (FileEntry & { sha256: string }) | undefined;
    if (!row) throw new DomainError('not_found', '找不到这个文件');
    if (row.visibility === 'draft' && !teacher) throw new DomainError('forbidden', '这份文件还没有发布，学生暂时看不到');
    const root = this.rootFor(row.path);
    const grouped = row.path.startsWith('group/');
    const base = realpathSync(grouped ? root : join(root, courseId));
    let real: string;
    try { real = realpathSync(grouped ? join(root, row.path) : join(root, courseId, row.path)); }
    catch { throw new DomainError('not_found', '文件已不在服务器上'); }
    if (real !== base && !real.startsWith(base + sep)) throw new DomainError('forbidden', '文件路径越界');
    const content = readFileSync(real);
    const { sha256, ...entry } = row;
    if (createHash('sha256').update(content).digest('hex') !== sha256) throw new DomainError('stale', '文件内容已更新，需要重新发布');
    return { ...entry, content };
  }
}
