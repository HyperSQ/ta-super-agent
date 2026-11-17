import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Entry = {
  id: string; type: string; section?: string; number: string; page: number; endPage: number;
  printedPage?: string; text: string; ambiguous?: boolean; endIsSoft?: boolean;
  sourceSpans: { page: number; start: number; end: number }[];
};
export type ExactReference = {
  label: string; bookId: string; page: number; endPage: number; printedPage?: string;
  text: string; needsVisualVerification: boolean;
};
export type ReferenceResult = { requested: string[]; found: ExactReference[]; unresolved: string[] };
export type TextbookSection = { bookId: string; id: string; title: string; page: number; endPage: number;
  topics: { title: string; page: number }[]; excerpts: { page: number; text: string }[] };

const digest = (raw: Buffer) => createHash('sha256').update(raw).digest('hex');
const compact = (text: string) => text.normalize('NFKC').replace(/\s+/g, '');
const sectionPattern = /(?:第\s*)?(\d{1,3})\s*[.．-]\s*(\d{1,3})\s*(?:节|(?=\s*(?:习题|[tT]\s*\d|第\s*\d+\s*题)))/g;
export function sectionIds(text: string): string[] {
  const input = text.normalize('NFKC');
  const numeric = [...input.matchAll(/(?<!\d)(?:第\s*)?(\d{1,3})\s*章\s*(?:第\s*)?(\d{1,3})\s*节|(?:§\s*|习题\s*|(?:^|[^\d.])(?=\d{1,3}\s*\.\s*\d{1,3}\s*节))(\d{1,3})\s*\.\s*(\d{1,3})(?![.\d])/gu)];
  const ids = numeric.map(match => Number(match[1] ?? match[3]) + '.' + Number(match[2] ?? match[4]));
  if (!ids.length) {
    const bare = /(?:^|(?:讲到|完成|复习|进度)[：:\s]*)\s*(\d{1,3})\s*\.\s*(\d{1,3})(?![\d.])(?=$|[，。；,;\s])/u.exec(input);
    if (bare) ids.push(Number(bare[1]) + '.' + Number(bare[2]));
  }
  return [...new Set(ids)];
}

/** Uses the AI-chat package's section/number keys and verified source spans. */
export class TextbookReferences {
  private root: string;
  private cache = new Map<string, Entry[]>();
  constructor(root: string) { this.root = root; }
  sections(bookIds: string[], id: string): TextbookSection[] {
    if (!/^\d{1,3}\.\d{1,3}$/.test(id)) return [];
    return [...new Set(bookIds)].flatMap(bookId => {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(bookId)) return [];
      try {
        const dir = join(this.root, bookId);
        const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
        const index = JSON.parse(readFileSync(join(dir, 'references.json'), 'utf8'));
        const raw = readFileSync(join(dir, 'pages.json'));
        if (manifest.id !== bookId || index.bookId !== bookId || index.schemaVersion !== 1 || !manifest.sourceSHA256 ||
            index.sourceSHA256 !== manifest.sourceSHA256 || index.pagesSHA256 !== digest(raw)) return [];
        const pages = JSON.parse(raw.toString()) as { page: number; text: string }[];
        const toc = manifest.toc as { level: number; title: string; page: number }[];
        if (!Array.isArray(toc)) return [];
        const heading = '\\n\\s*§\\s*' + id.replace('.', '\\s*\\.\\s*') + '\\s*\\n';
        const start = pages.find(row => new RegExp(heading, 'u').test('\n' + row.text));
        if (!start) return [];
        const candidates = toc.map((entry, i) => ({ entry, i })).filter(({ entry }) =>
          entry.level === 2 && entry.page === start.page && compact(start.text).includes(compact('§' + id + entry.title)));
        if (candidates.length !== 1) return [];
        const { entry, i } = candidates[0];
        const following = toc.slice(i + 1);
        const boundary = following.find(item => item.level <= entry.level);
        const exercise = following.find(item => compact(item.title) === '习题' + id && (!boundary || item.page < boundary.page));
        const endPage = exercise?.page ?? (boundary ? boundary.page - 1 : pages.at(-1)?.page ?? start.page);
        if (endPage < start.page) return [];
        const topics = following.slice(0, boundary ? following.indexOf(boundary) : undefined)
          .filter(item => item.level === 3 && item.page <= endPage && !item.title.startsWith('习题')).map(({ title, page }) => ({ title, page }));
        const wanted = [...new Set([start.page, ...topics.map(topic => topic.page), endPage])].slice(0, 7);
        const excerpts = wanted.flatMap(page => {
          const row = pages.find(item => item.page === page);
          if (!row) return [];
          const headingStart = page === start.page ? ('\n' + row.text).search(new RegExp(heading, 'u')) : 0;
          const text = ('\n' + row.text).slice(Math.max(0, headingStart)).split(new RegExp('\\n\\s*习题\\s*' + id.replace('.', '\\.') + '\\s*\\n', 'u'))[0].trim();
          return text ? [{ page, text: text.slice(0, 2100) }] : [];
        });
        return [{ bookId, id, title: entry.title, page: start.page, endPage, topics, excerpts }];
      } catch { return []; }
    });
  }
  private load(bookId: string): Entry[] {
    const cached = this.cache.get(bookId);
    if (cached) return cached;
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(bookId)) return [];
    try {
      const dir = join(this.root, bookId);
      const index = JSON.parse(readFileSync(join(dir, 'references.json'), 'utf8'));
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
      const raw = readFileSync(join(dir, 'pages.json'));
      if (index.schemaVersion !== 1 || index.bookId !== bookId || manifest.id !== bookId || !manifest.sourceSHA256
        || index.sourceSHA256 !== manifest.sourceSHA256 || index.pagesSHA256 !== digest(raw)) return [];
      const pages = new Map<number, string>(JSON.parse(raw.toString()).map((p: { page: number; text: string }) => [p.page, p.text]));
      const entries = (index.entries as Entry[]).filter(e => {
        if (typeof e.text !== 'string' || !e.text.trim() || !Array.isArray(e.sourceSpans) || !e.sourceSpans.length) return false;
        const spans = e.sourceSpans.map(s => {
          const text = pages.get(s.page);
          return typeof text === 'string' && Number.isInteger(s.start) && Number.isInteger(s.end)
            && s.start >= 0 && s.end > s.start && s.end <= text.length ? text.slice(s.start, s.end) : '';
        });
        return spans.every(Boolean) && compact(spans.join('')) === compact(e.text);
      });
      this.cache.set(bookId, entries);
      return entries;
    } catch { return []; }
  }

  lookup(bookIds: string[], latest: string, earlier: string[] = []): ReferenceResult {
    const input = latest.normalize('NFKC');
    const previous = earlier.join('\n').normalize('NFKC');
    const section = [...previous.matchAll(sectionPattern)].at(-1);
    const earlierSections = [...new Set([...previous.matchAll(sectionPattern)].map(m => m[1] + '.' + m[2]))];
    const currentSections = [...input.matchAll(sectionPattern)];
    const requests: { type: string; section?: string; number: string; label: string }[] = [];
    for (const match of input.matchAll(/(?:\bT\s*(\d{1,3})\b|第\s*(\d{1,3})\s*题)/gi)) {
      const nearest = currentSections.filter(s => s.index! <= match.index!).at(-1) ?? (!currentSections.length && earlierSections.length === 1 ? section : undefined);
      const id = nearest ? nearest[1] + '.' + nearest[2] : undefined;
      const number = String(Number(match[1] ?? match[2]));
      requests.push({ type: 'exercise', section: id, number, label: (id ? id + ' ' : '') + 'T' + number });
    }
    const types: Record<string, string> = { 定理: 'theorem', 定义: 'definition', 引理: 'lemma', 推论: 'corollary', 命题: 'proposition', 例: 'example' };
    for (const match of input.matchAll(/(定理|定义|引理|推论|命题|例)\s*(\d+(?:[.-]\d+)+)/g)) {
      const number = match[2].replaceAll('-', '.');
      requests.push({ type: types[match[1]], number, label: match[1] + number });
    }
    const result: ReferenceResult = { requested: [], found: [], unresolved: [] };
    for (const q of requests) {
      if (result.requested.includes(q.label)) continue;
      result.requested.push(q.label);
      const hits = q.type === 'exercise' && !q.section ? [] : [...new Set(bookIds)].flatMap(bookId => this.load(bookId)
        .filter(e => e.type === q.type && e.number.replaceAll('-', '.') === q.number && (q.type !== 'exercise' || e.section === q.section))
        .map(entry => ({ bookId, entry })));
      if (hits.length !== 1 || hits[0].entry.ambiguous) { result.unresolved.push(q.label); continue; }
      const { bookId, entry } = hits[0];
      result.found.push({ label: q.label, bookId, page: entry.page, endPage: entry.endPage,
        printedPage: entry.printedPage, text: entry.text.slice(0, 4000), needsVisualVerification: true });
    }
    return result;
  }
}
