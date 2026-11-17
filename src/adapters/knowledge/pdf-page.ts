import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const render = promisify(execFile);
export type PageReader = (bookId: string, page: number, signal: AbortSignal) => Promise<string>;

/** Poppler renders only an original page from an installed textbook package. */
export function textbookPageReader(library: string, executable: string): PageReader {
  return async (bookId, page, signal) => {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(bookId) || !Number.isSafeInteger(page) || page < 1) throw new Error('教材页无效');
    const root = await realpath(library);
    const directory = await realpath(join(root, bookId));
    if (dirname(directory) !== root) throw new Error('教材目录超出资料库');
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    if (manifest.id !== bookId || manifest.sourceFile !== 'source.pdf' || page > manifest.pageCount
      || !/^[a-f0-9]{64}$/.test(manifest.sourceSHA256)) throw new Error('原始教材或页码未通过校验');
    const source = await realpath(join(directory, 'source.pdf'));
    if (dirname(source) !== directory || (await stat(source)).size > 64 * 1024 * 1024) throw new Error('PDF 不可读取');
    if (createHash('sha256').update(await readFile(source, { signal })).digest('hex') !== manifest.sourceSHA256) throw new Error('PDF 校验失败');
    const { stdout } = await render(executable, ['-f', String(page), '-l', String(page), '-singlefile', '-scale-to', '1800', '-png', source],
      { encoding: 'buffer', timeout: 15_000, maxBuffer: 2 * 1024 * 1024, signal, windowsHide: true });
    if (stdout.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('PDF 页图不可用');
    return 'data:image/png;base64,' + stdout.toString('base64');
  };
}
