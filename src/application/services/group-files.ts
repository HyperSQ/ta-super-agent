import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Event } from '../../domain/model.ts';
import type { QQAttachmentReader } from '../../adapters/qq/attachments.ts';
import type { CourseFiles } from './course-files.ts';

/**
 * 群文件落盘：收到群上传通知后下载一次，按 sha256 存进课程文件目录，
 * 之后 worker 用 list_course_files / read_course_file 直接读，不再回 QQ 下载。
 */
export class GroupFiles {
  private files: CourseFiles;
  private root: string;
  private read?: QQAttachmentReader;
  constructor(files: CourseFiles, root: string, read?: QQAttachmentReader) {
    this.files = files; this.root = root; this.read = read;
  }

  async ingest(event: Event, signal?: AbortSignal): Promise<boolean> {
    if (!this.read || event.channel.kind !== 'qq-group') return false;
    const attachment = event.attachments?.find(item => item.kind === 'file');
    if (!attachment) return false;
    const bytes = await this.read(event.channel, attachment, signal);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const name = attachment.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'file';
    const dir = join(this.root, 'group', sha);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), bytes);
    this.files.register(event.courseId, `group/${sha}/${name}`, attachment.name, bytes.length, sha,
      'published', `group:${attachment.fileId ?? ''}`);
    return true;
  }
}
