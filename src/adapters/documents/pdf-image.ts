import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const render = promisify(execFile);

/**
 * 把任意 PDF（例如学生提交的作业）的第一页或指定页渲染成 PNG。
 * 只写临时目录，失败返回 undefined；调用方必须给出“看不到”的诚实说明。
 */
export function pdfImageReader(executable: string) {
  return async (pdf: Buffer, page: number, signal: AbortSignal): Promise<string | undefined> => {
    if (!Number.isSafeInteger(page) || page < 1 || page > 200 || !pdf.length || pdf.length > 20 * 1024 * 1024) return undefined;
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), 'ta-submission-'));
      const file = join(directory, 'submission.pdf');
      await writeFile(file, pdf);
      const { stdout } = await render(executable, ['-f', String(page), '-l', String(page), '-singlefile',
        '-scale-to', '1600', '-png', file],
        { encoding: 'buffer', timeout: 15_000, maxBuffer: 8 * 1024 * 1024, signal, windowsHide: true });
      if (stdout.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return undefined;
      return 'data:image/png;base64,' + stdout.toString('base64');
    } catch {
      return undefined;
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

export type PdfImage = ReturnType<typeof pdfImageReader>;
