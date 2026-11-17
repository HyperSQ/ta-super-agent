import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskEngine } from '../task-engine.ts';

/**
 * 学生提交附件：正文写到课程文件目录，数据库只记 path/sha/大小。
 * 旧数据没有 path 时由读取方回退到 blob。
 */
export class SubmissionFiles {
  private engine: TaskEngine;
  private root: string;
  constructor(engine: TaskEngine, root: string) { this.engine = engine; this.root = root; }

  save(requestId: string, position: number, name: string, bytes: Buffer) {
    const sha = createHash('sha256').update(bytes).digest('hex');
    const safe = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'file';
    const dir = join(this.root, requestId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${position}-${safe}`);
    writeFileSync(path, bytes);
    this.engine.store.db.prepare(`INSERT INTO coursework_submission_paths(request_id,position,name,bytes,path,sha256)
      VALUES(?,?,?,?,?,?) ON CONFLICT(request_id,position) DO UPDATE SET name=excluded.name,bytes=excluded.bytes,path=excluded.path,sha256=excluded.sha256`)
      .run(requestId, position, name, bytes.length, path, sha);
    return { path, sha };
  }

  read(requestId: string, position: number): { name: string; content: Buffer } | undefined {
    const row = this.engine.store.db.prepare('SELECT name,path FROM coursework_submission_paths WHERE request_id=? AND position=?')
      .get(requestId, position) as { name: string; path: string } | undefined;
    if (!row) return undefined;
    try { return { name: row.name, content: readFileSync(row.path) }; }
    catch { return undefined; }
  }

  paths(requestId: string) {
    return this.engine.store.db.prepare('SELECT position,name,bytes,path FROM coursework_submission_paths WHERE request_id=? ORDER BY position')
      .all(requestId) as { position: number; name: string; bytes: number; path: string }[];
  }
}
