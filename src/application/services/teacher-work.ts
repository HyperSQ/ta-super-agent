import { randomBytes } from 'node:crypto';
import { DomainError } from '../../domain/model.ts';
import type { Assignment, Course, Event } from '../../domain/model.ts';
import type { Model } from '../../ports/model.ts';
import type { TaskEngine } from '../task-engine.ts';
import { Academics } from './academics.ts';
import type { TextbookReferences } from '../../adapters/knowledge/references.ts';
import type { TaskHandoff } from '../task-memory.ts';
import { teacherAssistantEvent, teacherThread } from '../teacher-conversation.ts';

type Fields = Pick<Assignment, 'title' | 'instructions' | 'deadline' | 'gradingPolicy'>;
type Target = { id: string; title: string; revision: number };
type Change = { action: 'create'; fields: Fields }
  | { action: 'edit'; assignment: Target; fields: Partial<Fields> }
  | { action: 'scores'; assignment: Target; students: { name: string; score: number; revision: number }[] };
type Draft = { courseRevision: number; change: Change };
type Reply = (text: string) => void;
const confirmation = /^\/?(确认|取消)\s+([0-9a-f]{8})$/i;
const fieldLabels = { title: '名称', instructions: '题目与提交要求', deadline: '截止时间', gradingPolicy: '评分标准' };
const formatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const weekdayNames = '一二三四五六日';

function nextWeekDeadline(text: string, now: number): string | undefined {
  const day = /(?:^|\n|[，,]\s*)下周([一二三四五六日天])(?:截止)?[。！!]?$/.exec(text.trim())?.[1];
  if (!day) return undefined;
  const china = new Date(now + 8 * 3600_000);
  const weekday = (china.getUTCDay() + 6) % 7;
  china.setUTCDate(china.getUTCDate() + 7 - weekday + weekdayNames.indexOf(day === '天' ? '日' : day));
  return china.toISOString().slice(0, 10) + 'T23:59:00+08:00';
}

export function isTeacherWork(text: string): boolean {
  return /^\/?(?:确认|取消)\s+[0-9a-f]{8}$/i.test(text) || /^\/(?:作业|成绩)(?:\s|$)/.test(text)
    || /(?:新建|新增|添加|布置|创建|修改|更改|改一下|更新|调整).{0,24}作业|作业.{0,32}(?:改为|改到|改成|改一下|改|登记|录入|记分|\d+(?:\.\d+)?\s*分)|(?:登记|录入|记一下|补录|更正|改).{0,24}(?:分数|成绩|作业)/s.test(text);
}

function invalid(message: string): never { throw new DomainError('invalid', message); }

function fieldsFrom(value: Record<string, unknown>): Partial<Fields> {
  const fields: Partial<Fields> = {};
  for (const key of Object.keys(fieldLabels) as (keyof Fields)[]) {
    const raw = value[key];
    if (raw === undefined) continue;
    if (typeof raw !== 'string' || raw.length > (key === 'title' ? 120 : 1200)) invalid(fieldLabels[key] + '格式无效或过长，请缩短后重发。');
    const text = raw.trim();
    if (key === 'title' && !text) invalid('请提供作业名称。');
    if (key === 'deadline' && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(text) || !Number.isFinite(Date.parse(text)))) {
      invalid('请写明截止日期和时间，例如 2026-11-20 20:00。');
    }
    fields[key] = text;
  }
  return fields;
}

export class TeacherWork {
  private engine: TaskEngine;
  private model: Model;
  private academics: Academics;
  private references?: TextbookReferences;
  constructor(engine: TaskEngine, model: Model, references?: TextbookReferences) {
    this.engine = engine;
    this.model = model;
    this.academics = new Academics(engine);
    this.references = references;
  }

  private pending(event: Event): string[] {
    const { actor, thread } = teacherThread(event);
    const query = this.engine.store.db.prepare('SELECT data FROM teacher_work_followups WHERE course_id=? AND actor_id=? AND thread_id=? AND expires_at>?');
    const row = query.get(event.courseId, actor, thread, this.engine.now()) ??
      query.get(event.courseId, event.actor.id, event.threadId, this.engine.now());
    return row ? JSON.parse(String(row.data)) as string[] : [];
  }
  acceptsFollowup(event: Event): boolean {
    if (event.channel.kind !== 'qq-private' && !teacherAssistantEvent(event)) return false;
    const { actor, thread } = teacherThread(event);
    const hasWork = this.pending(event).length || this.engine.store.tasks().some(task => {
      if (task.kind !== 'teaching-affairs' || task.courseId !== event.courseId || !['queued', 'running'].includes(task.status) || !task.grant.originEventId) return false;
      const origin = this.engine.store.originalEvent(task.grant.originEventId);
      const scope = origin && teacherThread(origin);
      return scope?.actor === actor && scope.thread === thread;
    });
    if (!hasWork) return false;
    return /^(?:取消|放弃|算了)(?:这次|作业|草稿)?[。！!]?$/u.test(event.text)
      || !/[?？]$/.test(event.text) && /^(?:截止|题目|作业名|标题|评分|补充|本周|这周|下周|今天|明天|后天|周[一二三四五六日天]|星期|20\d\d|\d{1,2}[月:点号]|到\s*(?:下周|周)|T\d)/iu.test(event.text);
  }
  private clearPending(event: Event): void {
    const { actor, thread } = teacherThread(event);
    this.engine.store.db.prepare('DELETE FROM teacher_work_followups WHERE course_id=? AND ((actor_id=? AND thread_id=?) OR (actor_id=? AND thread_id=?))')
      .run(event.courseId, actor, thread, event.actor.id, event.threadId);
  }
  private clarify(event: Event, request: string[], question: string, reply: Reply): void {
    this.engine.store.atomic(() => {
      const { actor, thread } = teacherThread(event);
      this.clearPending(event);
      this.engine.store.db.prepare('INSERT INTO teacher_work_followups VALUES (?,?,?,?,?) ON CONFLICT(course_id,actor_id,thread_id) DO UPDATE SET expires_at=excluded.expires_at,data=excluded.data')
        .run(event.courseId, actor, thread, this.engine.now() + 30 * 60_000, JSON.stringify(request.slice(-8)));
      reply(question);
    });
  }

  async execute(event: Event, signal: AbortSignal, reply: Reply, handoff?: TaskHandoff): Promise<void> {
    this.engine.policy.requireTeacher(event);
    this.engine.policy.validateWorkerSource('teaching-affairs', event);
    const operator = teacherThread(event).actor;
    try {
      const command = confirmation.exec(event.text);
      if (command) {
        this.resolve(event, command[2].toUpperCase(), command[1] === '确认', reply);
        return;
      }
      if (/^(?:取消|放弃|算了)(?:这次|作业|草稿)?[。！!]?$/u.test(event.text)) {
        this.engine.store.atomic(() => {
          this.clearPending(event);
          reply('已放弃这次作业补充。');
        });
        return;
      }
      const course = this.engine.store.course(event.courseId)!;
      const parts = [...(isTeacherWork(event.text) ? [] : this.pending(event)), event.text.slice(0, 3000)];
      const combined = parts.join('\n');
      const assignments = this.academics.assignments(course.id).map(({ id, title, revision }) => ({ id, title, revision }));
      const exactNames = (course.roster ?? []).filter(name => combined.includes(name));
      const quotedTitle = /(?:作业\s*[「“]([^」”]{1,120})[」”]|作业\s*["]([^"]{1,120})["])/.exec(combined);
      const weekTitle = /^(?:新建|新增|创建|布置)\s*(第[零一二三四五六七八九十百\d]+周作业)(?=[，,。；;：:\s]|$)/u.exec(combined);
      const explicitTitle = (quotedTitle?.[1] ?? quotedTitle?.[2] ?? weekTitle?.[1])?.trim();
      const sourceRefs = this.references?.lookup(course.textbookIds ?? [], combined);
      const simpleWeekRequest = /^(?:新建|新增|创建|布置)\s*第[零一二三四五六七八九十百\d]+周作业[，,：: ]*(?:是|为)?\s*\d{1,3}[.．-]\d{1,3}(?:[ 、,，]+T\s*\d{1,3})+(?:(?:[，,]|\n)\s*下周[一二三四五六日天](?:截止)?)?[。！!]?$/iu.test(combined);
      const indexedWeek = simpleWeekRequest && weekTitle && sourceRefs?.found.length && !sourceRefs.unresolved.length;
      const deadline = indexedWeek ? nextWeekDeadline(combined, this.engine.now()) : undefined;
      if (indexedWeek && parts.length === 1 && !/(?:截止|交|下周|本周|明天|\d+月|\d{4}-\d{2})/.test(combined)) {
        this.clarify(event, parts, '这份作业哪天截止？可直接回复日期，例如「下周四」。', reply);
        return;
      }
      const request = deadline ? JSON.stringify({ action: 'create', title: explicitTitle,
        instructions: sourceRefs!.requested.join('、'), deadline }) : await this.model.complete([
        { role: 'system', content: [
          '你是教师私信里的作业助手。将请求转换为一个 JSON 草稿。草稿等待老师确认，不能执行操作。',
          '根据 request 中按顺序提供的原请求和补充信息填写同一份草稿。不得猜测姓名、分数、作业或缺失的截止日期。只给出明确日期时用北京时间当天 23:59。草稿本身就是确认环节，字段齐全则必须直接返回 create/edit/scores，不要额外询问标题或时间是否正确。保留所有章节和题号，不要求老师重复贴题。',
          '保留作业名称里的所有字符，包括括号和标记。若明确给出了引号内的作业名，则将该名称视为完整名称。',
          '新增格式 {"action":"create","title":"原名称","instructions":"老师给的题目或提交要求","deadline":"YYYY-MM-DDTHH:mm:ss+08:00","gradingPolicy":"可选，缺省沿用课程规则"}。名称、题目和截止必须明确。',
          '修改格式 {"action":"edit","assignmentId":"从列表选一个","title":"可选","instructions":"可选","deadline":"可选","gradingPolicy":"可选"}。只填明确要求修改的字段，其余省略。',
          '分数格式 {"action":"scores","assignmentId":"从列表选一个","students":[{"name":"名单中完全匹配的姓名","score":8.5}]}。支持零分和小数。',
          '时区 Asia/Shanghai。可依据传入当前日期理解明确的相对日期。如果不确定目标或信息不足，返回 {"action":"clarify","question":"向老师询问缺失信息"}。有多项同样匹配时询问完整名称。',
        ].join('\n') },
        { role: 'user', content: JSON.stringify({
          request: combined, explicitTitle, course: course.title, localTime: formatter.format(this.engine.now()),
          assignments, roster: exactNames, textbookNumbers: sourceRefs?.requested, taskHandoff: handoff,
        }) },
      ], signal, true);
      signal.throwIfAborted();
      const result = JSON.parse(request) as Record<string, unknown> | null;
      if (!result || typeof result !== 'object') invalid('没有识别出操作，请重新描述。');
      if (result.action === 'clarify') {
        const question = result.question;
        this.clarify(event, parts, typeof question === 'string' && question.trim() ? question.trim().slice(0, 300) : '请补充作业名称和要修改的内容。', reply);
        return;
      }
      let change: Change;
      try { change = this.prepare(course, assignments, exactNames, result, explicitTitle); }
      catch (error) {
        if (!(error instanceof DomainError)) throw error;
        this.clarify(event, parts, error.message, reply);
        return;
      }
      const references = change.action === 'scores' || (change.action === 'edit' && change.fields.instructions === undefined)
        ? undefined : sourceRefs?.requested.length ? sourceRefs : this.references?.lookup(course.textbookIds ?? [], change.fields.instructions ?? '');
      const found = references?.found.length ? '\n已定位：' + references.found.map(r => r.label + '（PDF 第 ' + r.page + ' 页）').join('、') : '';
      const missing = references?.unresolved.length ? '\n待核对题号：' + references.unresolved.join('、') : '';
      const draft: Draft = { courseRevision: course.revision ?? 1, change };
      const code = randomBytes(4).toString('hex').toUpperCase();
      this.engine.store.atomic(() => {
        this.clearPending(event);
        this.engine.store.db.prepare("UPDATE teacher_work_drafts SET status='cancelled' WHERE course_id=? AND actor_id=? AND status='pending'")
          .run(event.courseId, operator);
        this.engine.store.db.prepare("INSERT INTO teacher_work_drafts VALUES (?,?,?,?,?,'pending',?)")
          .run(code, event.id, event.courseId, operator, this.engine.now() + 30 * 60_000, JSON.stringify(draft));
        reply(this.preview(course.title, change) + found + missing + '\n请回复「确认 ' + code + '」保存，或回复「取消 ' + code + '」。确认码 30 分钟有效。');
      });
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof DomainError && error.code === 'stale' && error.message.startsWith('运行已失效')) throw error;
      const detail = error instanceof DomainError ? error.message : '暂时无法处理，请按“作业名称 + 改动”重新发一条。';
      this.engine.store.atomic(() => reply('本次没有写入。' + detail));
      if (!(error instanceof DomainError)) this.engine.store.audit('teacher_work.failed', { eventId: event.id });
    }
  }

  private prepare(course: Course, assignments: Target[], exactNames: string[], value: Record<string, unknown>, explicitTitle?: string): Change {
    if (value.action === 'create') {
      const fields = fieldsFrom(explicitTitle ? { ...value, title: explicitTitle } : value);
      if (!fields.title || !fields.instructions || !fields.deadline) invalid('请提供作业名称、题目和截止时间。');
      if (assignments.some(a => a.title === fields.title)) invalid('同名作业已经存在，请指定修改或使用新名称。');
      return { action: 'create', fields: { title: fields.title, instructions: fields.instructions, deadline: fields.deadline, gradingPolicy: fields.gradingPolicy ?? course.gradingPolicy ?? '' } };
    }
    const matches = explicitTitle ? assignments.filter(a => a.title === explicitTitle) : assignments.filter(a => a.id === value.assignmentId);
    const assignment = matches.length === 1 ? matches[0] : undefined;
    if (!assignment) invalid('找不到对应作业，请提供工作台中的完整作业名称。');
    if (value.action === 'edit') {
      const fields = fieldsFrom(value);
      if (!Object.keys(fields).length) invalid('请说明要修改哪项内容。');
      return { action: 'edit', assignment, fields };
    }
    if (value.action !== 'scores' || !Array.isArray(value.students) || !value.students.length || value.students.length > 30) {
      invalid('请提供 1 至 30 个姓名和分数。');
    }
    const records = new Map(this.academics.offline(assignment.id).map(row => [row.studentName, row.revision]));
    const students = value.students.map(row => {
      if (!row || typeof row.name !== 'string' || !exactNames.includes(row.name)) invalid('有姓名与课程名单不匹配，请按工作台中的姓名填写。');
      if (typeof row.score !== 'number' || !Number.isFinite(row.score) || row.score < 0) invalid('分数须为非负数字。');
      return { name: row.name as string, score: row.score as number, revision: records.get(row.name) ?? 0 };
    });
    if (new Set(students.map(row => row.name)).size !== students.length) invalid('同一学生出现多次，请每人只填写一个分数。');
    return { action: 'scores', assignment, students };
  }

  private preview(course: string, change: Change): string {
    if (change.action === 'scores') return '课程：' + course + '\n登记分数：' + change.assignment.title + '\n' + change.students.map(row => row.name + '：' + row.score + ' 分').join('\n');
    const lines = Object.entries(change.fields).map(([key, value]) => {
      const text = key === 'deadline' ? formatter.format(Date.parse(value)) + '（北京时间）' : value || '（清空）';
      return fieldLabels[key as keyof Fields] + '：' + text;
    });
    const action = change.action === 'create' ? '新建作业' : '修改作业：' + change.assignment.title;
    return ['课程：' + course, action, ...lines].join('\n');
  }

  private resolve(event: Event, code: string, confirm: boolean, reply: Reply): void {
    this.engine.store.atomic(() => {
      const row = this.engine.store.db.prepare('SELECT status, expires_at, data FROM teacher_work_drafts WHERE code=? AND course_id=? AND actor_id=?')
        .get(code, event.courseId, teacherThread(event).actor);
      if (!row) invalid('找不到该确认码，请检查当前选课和确认码。');
      if (row.status !== 'pending') invalid(row.status === 'confirmed' ? '此草稿已经保存。' : '此草稿已经取消。');
      if (Number(row.expires_at) <= this.engine.now()) invalid('确认码已过期，请重发原操作。');
      if (!confirm) {
        this.engine.store.db.prepare("UPDATE teacher_work_drafts SET status='cancelled' WHERE code=?").run(code);
        reply('已取消草稿。');
        return;
      }
      const { change, courseRevision } = JSON.parse(String(row.data)) as Draft;
      const course = this.engine.store.course(event.courseId)!;
      if ((course.revision ?? 1) !== courseRevision) invalid('课程已更新，请重新发起草稿。');
      let receipt: string;
      if (change.action === 'create') {
        if (this.academics.assignments(course.id).some(a => a.title === change.fields.title)) invalid('已存在同名作业，请重新核对。');
        const saved = this.academics.saveAssignment(event.actor.id, { courseId: course.id, ...change.fields });
        receipt = '已新建作业「' + saved.title + '」。可在工作台作业管理查看。';
      } else {
        const current = this.academics.assignment(change.assignment.id);
        if (current.courseId !== course.id || current.revision !== change.assignment.revision) invalid('作业已更新，请重新发起草稿。');
        if (change.action === 'edit') {
          const saved = this.academics.saveAssignment(event.actor.id, { ...current, ...change.fields });
          receipt = '已保存作业「' + saved.title + '」的修改。';
        } else {
          this.academics.register(event.actor.id, current.id, change.students);
          receipt = '已为「' + current.title + '」登记 ' + change.students.length + ' 人的分数。可在工作台线下登记查看。';
        }
      }
      this.engine.store.db.prepare("UPDATE teacher_work_drafts SET status='confirmed' WHERE code=?").run(code);
      reply(receipt);
    });
  }
}
