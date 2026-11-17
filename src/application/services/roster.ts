import { randomBytes } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { DomainError } from '../../domain/model.ts';
import type { TaskEngine } from '../task-engine.ts';

export const rosterFileLimit = 2 * 1024 * 1024;
const headers = /^(?:学生姓名|姓名|学生名单|name|student name)$/i;
const invalid = (message: string) => new DomainError('invalid', message);

function names(input: unknown): string[] {
  if (!Array.isArray(input) || !input.length || input.length > 2000 ||
      input.some(value => typeof value !== 'string' || !value.trim() || value.trim().length > 100 || /[\u0000-\u001f]/.test(value.trim()))) {
    throw invalid('请提供 1–2000 个有效姓名');
  }
  return [...new Set(input.map((value: string) => value.trim()))];
}
function delimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [[]];
  let field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else if (quoted || !field) quoted = !quoted;
      else field += c;
    } else if (!quoted && (c === delimiter || c === '\n' || c === '\r')) {
      rows.at(-1)!.push(field); field = '';
      if (c !== delimiter) { if (c === '\r' && text[i + 1] === '\n') i++; rows.push([]); }
    } else field += c;
  }
  if (quoted) throw invalid('表格中的引号没有闭合');
  rows.at(-1)!.push(field);
  return rows;
}
function zipXml(source: Buffer): Map<string, string> {
  const end = source.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > source.length) throw invalid('XLSX 文件无效');
  const entries = source.readUInt16LE(end + 10);
  const xml = new Map<string, string>();
  let pos = source.readUInt32LE(end + 16);
  for (let i = 0; i < entries && pos + 46 <= end; i++) {
    if (source.readUInt32LE(pos) !== 0x02014b50) throw invalid('XLSX 文件目录无效');
    const length = source.readUInt16LE(pos + 28), name = source.toString('utf8', pos + 46, pos + 46 + length);
    const method = source.readUInt16LE(pos + 10), size = source.readUInt32LE(pos + 20), local = source.readUInt32LE(pos + 42);
    pos += 46 + length + source.readUInt16LE(pos + 30) + source.readUInt16LE(pos + 32);
    if (!/^xl\/(?:sharedStrings|workbook|worksheets\/sheet\d+)\.xml$/.test(name)) continue;
    if (xml.size >= 24 || local + 30 > end || source.readUInt32LE(local) !== 0x04034b50) throw invalid('XLSX 工作表无效');
    const at = local + 30 + source.readUInt16LE(local + 26) + source.readUInt16LE(local + 28);
    if (at + size > end || source.readUInt32LE(local + 22) > 3_000_000) throw invalid('XLSX 工作表过大或无效');
    const bytes = source.subarray(at, at + size);
    if (method !== 0 && method !== 8) throw invalid('XLSX 压缩方式不受支持');
    xml.set(name, (method === 0 ? bytes : inflateRawSync(bytes, { maxOutputLength: 3_000_000 })).toString('utf8'));
  }
  return xml;
}
function xmlText(value: string): string {
  return [...value.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(match => match[1].replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, token => {
    const known: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
    if (known[token]) return known[token];
    const code = token.startsWith('&#x') ? parseInt(token.slice(3), 16) : parseInt(token.slice(2), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : token;
  })).join('');
}
function findNames(rows: string[][], allowSingle: boolean): string[] | undefined {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const columns = rows[i].flatMap((value, index) => headers.test(value.trim()) ? [index] : []);
    if (columns.length > 1) throw invalid('发现多列姓名，请保留一列「姓名」');
    if (columns.length) return rows.slice(i + 1).map(row => row[columns[0]]?.trim()).filter(Boolean);
  }
  if (allowSingle && rows.every(row => row.length <= 1)) return rows.flat().map(x => x.trim()).filter(Boolean);
}
export function parseRosterFile(filename: string, bytes: Buffer, allowHeaderless = true): string[] {
  if (!bytes.length || bytes.length > rosterFileLimit) throw invalid('名单文件须在 2 MiB 以内');
  if (/\.xlsx$/i.test(filename)) {
    let xml: Map<string, string>;
    try { xml = zipXml(bytes); } catch { throw invalid('无法读取 XLSX，请另存为标准 XLSX 或 UTF-8 CSV'); }
    const strings = [...(xml.get('xl/sharedStrings.xml') ?? '').matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map(m => xmlText(m[1]));
    const found = [...xml].filter(([name]) => name.includes('/worksheets/')).map(([, sheet]) => {
      const rows = [...sheet.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)].map(row => {
        const cells: string[] = [];
        for (const cell of row[1].matchAll(/<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          if (!cell[2]) continue;
          const column = /\br="([A-Z]{1,3})\d+"/.exec(cell[1])?.[1];
          if (!column) continue;
          const i = [...column].reduce((sum, c) => sum * 26 + c.charCodeAt(0) - 64, 0) - 1;
          const idx = /<v>(\d+)<\/v>/.exec(cell[2])?.[1];
          cells[i] = /\bt="s"/.test(cell[1]) && idx !== undefined ? strings[Number(idx)] ?? '' : xmlText(cell[2]);
        }
        return cells;
      });
      return findNames(rows, false);
    }).filter(item => item !== undefined);
    if (found.length !== 1) throw invalid('XLSX 须有且仅有一个表含「姓名」列');
    return names(found[0]);
  }
  if (!/\.(csv|tsv|txt)$/i.test(filename)) throw invalid('请发 XLSX、CSV、TSV 或每行一个姓名的 TXT');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw invalid('名单文本请另存为 UTF-8'); }
  const detected = findNames(delimited(text, /\.tsv$/i.test(filename) || (/\.txt$/i.test(filename) && text.includes('\t')) ? '\t' : ','), allowHeaderless);
  if (!detected) throw invalid('名单须包含「姓名」列');
  return names(detected);
}

export class Roster {
  private engine: TaskEngine;
  constructor(engine: TaskEngine) { this.engine = engine; }
  private course(actor: string, courseId: string) {
    if (!this.engine.policy.isTeacher(actor)) throw new DomainError('forbidden', '仅教师可管理名单');
    const course = this.engine.store.course(courseId);
    if (!course) throw new DomainError('not_found', '课程不存在');
    return course;
  }
  list(actor: string, courseId: string) {
    const course = this.course(actor, courseId);
    return { title: course.title, names: course.roster ?? [] };
  }
  add(actor: string, courseId: string, input: unknown) {
    return this.engine.store.atomic(() => {
      const course = this.course(actor, courseId);
      const current = new Set(course.roster);
      const added = names(input).filter(name => !current.has(name));
      if (current.size + added.length > 2000) throw invalid('课程名单最多 2000 人');
      if (added.length) this.engine.updateCourse(actor, { ...course, roster: [...current, ...added] }, course.revision ?? 1);
      return { added: added.length, total: current.size + added.length };
    });
  }
  prepare(actor: string, courseId: string, input: unknown) {
    const course = this.course(actor, courseId);
    const selected = names(input);
    if (selected.some(name => !course.roster?.includes(name))) throw invalid('待删除的姓名必须全部与当前名单一致');
    const code = randomBytes(8).toString('hex');
    const db = this.engine.store.db;
    db.prepare('DELETE FROM roster_approvals WHERE expires<=?').run(this.engine.now());
    db.prepare('INSERT INTO roster_approvals VALUES(?,?,?,?,?)').run(code, courseId, actor, this.engine.now() + 10 * 60_000,
      JSON.stringify({ revision: course.revision ?? 1, names: selected }));
    return { code, course: course.title, names: selected };
  }
  confirm(actor: string, courseId: string, code: string) {
    return this.engine.store.atomic(() => {
      const course = this.course(actor, courseId);
      const db = this.engine.store.db;
      const row = db.prepare('SELECT data FROM roster_approvals WHERE id=? AND course_id=? AND actor=? AND expires>?').get(code, courseId, actor, this.engine.now());
      if (!row) throw invalid('确认码已使用、过期或不属于当前教师与课程');
      const plan = JSON.parse(String(row.data)) as { revision: number; names: string[] };
      if (plan.revision !== (course.revision ?? 1)) throw new DomainError('stale', '课程已变动，请重新确认删除');
      const removed = new Set(plan.names);
      this.engine.updateCourse(actor, { ...course, roster: (course.roster ?? []).filter(name => !removed.has(name)) }, plan.revision);
      db.prepare('DELETE FROM roster_approvals WHERE id=?').run(code);
      return { removed: removed.size };
    });
  }
}
