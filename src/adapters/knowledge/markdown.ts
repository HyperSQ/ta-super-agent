import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DomainError } from '../../domain/model.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const heading = /^## (\d{1,3}\.\d{1,3})[ \t]+(.{1,100})$/gm;
const exercise = /^### T(\d{1,3})(?=\s|$)/gm;

export function importMarkdownTextbook(root: string, courseId: string, markdown: string) {
  const source = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  const title = /^# ([^\n]{1,100})$/.exec(source.split('\n')[0])?.[1]?.trim();
  if (!title || source.length > 120_000 || source.includes('\0')) throw new DomainError('invalid', '请使用 UTF-8 Markdown，首行为 # 书名，最多 120,000 字');
  const sections = [...source.matchAll(heading)];
  if (!sections.length || sections.length > 60 || new Set(sections.map(section => section[1])).size !== sections.length)
    throw new DomainError('invalid', '请使用唯一的二级标题编号，如 ## 1.1 自注意力');
  const sourceSHA256 = hash(source);
  const id = 'course-' + hash(courseId).slice(0, 16) + '-' + sourceSHA256.slice(0, 20);
  const pages = [], toc = [], chunks = [], entries = [];
  for (const [index, section] of sections.entries()) {
    const page = index + 1, name = section[2].trim(), sectionId = section[1];
    const content = source.slice(section.index + section[0].length, sections[index + 1]?.index).trim();
    if (!content || content.length > 12_000) throw new DomainError('invalid', `第 ${sectionId} 节需要正文，单节限 12,000 字`);
    const text = `§${sectionId}\n${name}\n\n${content}`;
    pages.push({ page, text });
    toc.push({ level: 2, title: name, page });
    for (let offset = 0; offset < text.length; offset += 2800)
      chunks.push({ id: `${page}-${offset}`, text: `${name}\n${text.slice(offset, offset + 3000)}`, page, chapter: `${sectionId} ${name}` });
    const headings = [...text.matchAll(exercise)];
    if (new Set(headings.map(item => item[1])).size !== headings.length) throw new DomainError('invalid', `第 ${sectionId} 节含重复题号`);
    for (const [position, item] of headings.entries()) {
      const start = item.index, question = text.slice(start, headings[position + 1]?.index).trimEnd();
      if (question.length > 4000) throw new DomainError('invalid', `第 ${sectionId} 节 T${item[1]} 超过 4,000 字`);
      entries.push({ id: `${sectionId}-T${item[1]}`, type: 'exercise', section: sectionId, number: String(Number(item[1])),
        page, endPage: page, text: question, sourceSpans: [{ page, start, end: start + question.length }] });
    }
  }
  const target = join(root, id);
  if (!existsSync(target)) {
    mkdirSync(root, { recursive: true });
    const temporary = mkdtempSync(join(root, '.import-'));
    try {
      const pagesText = JSON.stringify(pages);
      const files = { 'source.md': source, 'pages.json': pagesText, 'chunks.json': JSON.stringify(chunks),
        'manifest.json': JSON.stringify({ id, title, sourceSHA256, toc, sourceKind: 'markdown', needsVisualVerification: false }),
        'references.json': JSON.stringify({ schemaVersion: 1, bookId: id, sourceSHA256, pagesSHA256: hash(pagesText), entries }) };
      for (const [name, value] of Object.entries(files)) writeFileSync(join(temporary, name), value, { mode: 0o640 });
      renameSync(temporary, target);
    } finally { if (existsSync(temporary)) rmSync(temporary, { recursive: true }); }
  }
  if (hash(readFileSync(join(target, 'source.md'), 'utf8')) !== sourceSHA256) throw new DomainError('conflict', '已导入教材的源文件校验失败');
  return { id, title, sections: pages.length, exercises: entries.length };
}
