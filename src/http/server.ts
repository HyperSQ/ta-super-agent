import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { DomainError } from '../domain/model.ts';
import type { Event } from '../domain/model.ts';
import type { Config } from '../config.ts';
import type { QQMessage } from '../adapters/qq/llbot.ts';
import { receiveGroupUpload } from '../adapters/qq/llbot.ts';
import type { QQAttachmentReader } from '../adapters/qq/attachments.ts';
import { TaskEngine } from '../application/task-engine.ts';
import { Academics } from '../application/services/academics.ts';
import type { Course } from '../domain/model.ts';
import { MemoryService } from '../application/services/memory.ts';
import { QQAccess } from '../application/services/qq-access.ts';
import { activityDetail, activityPage } from '../application/activities.ts';
import { listAlerts } from '../application/watchdog.ts';
import { courseInbox } from '../application/services/inbox.ts';
import { buildProposals } from '../application/services/proposals.ts';
import { DSH, maxHandoutBytes } from '../application/services/dsh.ts';
import { classContext } from '../application/services/class-context.ts';
import { dshOnlyTools, scheduledTools, weeklyTasks } from '../application/weekly-lesson.ts';
import type { ScheduledTool } from '../domain/model.ts';
import { Roster, parseRosterFile, rosterFileLimit } from '../application/services/roster.ts';
import { QATools } from '../agents/qa-tools.ts';
import { dshArtifacts, dshFile } from '../agents/workers/dsh-worker.ts';
import { CourseworkIntake } from '../application/services/coursework-intake.ts';
import { TeacherConversation } from '../application/teacher-conversation.ts';
import type { CourseMail } from '../application/services/course-mail.ts';
import type { GradingBatches } from '../application/grading-batches.ts';
import type { GroupFiles } from '../application/services/group-files.ts';

const assignmentBodyLimit = 4 * 1024 * 1024;

function authorized(req: IncomingMessage, token: string): boolean {
  const value = req.headers.authorization ?? '';
  const expected = `Bearer ${token}`;
  const supplied = Buffer.from(value), required = Buffer.from(expected);
  return supplied.length === required.length && timingSafeEqual(supplied, required);
}
async function rawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new DomainError('invalid', '请求内容过大');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
function jsonBody(raw: Buffer): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new DomainError('invalid', '请求体必须为JSON对象'); }
}
async function body(req: IncomingMessage, limit = 65536): Promise<Record<string, unknown>> {
  return jsonBody(await rawBody(req, limit));
}
function signedByLLBot(req: IncomingMessage, raw: Buffer, token: string): boolean {
  const signature = req.headers['x-signature'];
  if (typeof signature !== 'string' || !/^sha1=[a-f0-9]{40}$/.test(signature)) return false;
  const expected = createHmac('sha1', token).update(raw).digest();
  return timingSafeEqual(Buffer.from(signature.slice(5), 'hex'), expected);
}
function str(data: Record<string, unknown>, key: string, optional = false): string {
  const value = data[key];
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > 20000) throw new DomainError('invalid', `字段${key}必须为有效字符串`);
  return value.trim();
}
function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data));
}
function text(data: Record<string, unknown>, key: string): string {
  if (data[key] === undefined) return '';
  if (typeof data[key] !== 'string' || data[key].length > 20000) throw new DomainError('invalid', `${key}格式无效`);
  return data[key].trim();
}
function revision(data: Record<string, unknown>): number {
  if (typeof data.revision !== 'number' || !Number.isSafeInteger(data.revision) || data.revision < 1) throw new DomainError('invalid', '需提供有效revision');
  return data.revision;
}
function assignmentVisibility(data: Record<string, unknown>): boolean | undefined {
  const value = data.studentVisible;
  if (value !== undefined && typeof value !== 'boolean') throw new DomainError('invalid', 'studentVisible 必须为布尔值');
  return value;
}
function courseFields(data: Record<string, unknown>, id: string): Course {
  const list = (key: string, max: number) => {
    const value = data[key] ?? [];
    if (!Array.isArray(value) || value.length > max || value.some(v => typeof v !== 'string' || !v.trim() || v.length > 100)) throw new DomainError('invalid', `${key}格式无效`);
    const result = value.map((v: string) => v.trim());
    if (new Set(result).size !== result.length) throw new DomainError('invalid', `${key}含重复项`);
    return result;
  };
  const groupId = text(data, 'groupId');
  if (groupId && !/^\d+$/.test(groupId)) throw new DomainError('invalid', '群号必须为数字');
  return { id, title: str(data, 'title'), groupId: groupId || undefined, instructions: text(data, 'instructions'), className: text(data, 'className'), progress: text(data, 'progress'), gradingPolicy: text(data, 'gradingPolicy'), textbookIds: list('textbookIds', 100), roster: list('roster', 2000) };
}
function adminEvent(engine: TaskEngine, courseId: string, text: string): Event {
  return engine.receive({ sourceKey: `web:${randomUUID()}`, threadId: randomUUID(), courseId, actorId: 'web:admin', text,
    channel: { kind: 'management', target: 'admin' }, externalId: randomUUID(), receivedAt: Date.now() }).event;
}
export function createApi(engine: TaskEngine, config: Pick<Config, 'adminToken' | 'webhookToken' | 'headless'>, qqAccess = new QQAccess(engine), qa = new QATools(engine), attachments?: QQAttachmentReader, mail?: CourseMail, batches?: GradingBatches, groups?: GroupFiles) {
  const academics = new Academics(engine);
  const memory = new MemoryService(engine);
  const dsh = new DSH(engine, config.adminToken, attachments);
  const roster = new Roster(engine);
  const coursework = new CourseworkIntake(engine);
  const conversation = new TeacherConversation(engine);
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') { send(res, 200, { status: 'ok', version: '0.1.0' }); return; }
      if (url.pathname === '/hooks/qq' && req.method === 'POST') {
        const bearer = authorized(req, config.webhookToken);
        if (!bearer && !req.headers['x-signature']) { send(res, 401, { error: 'unauthorized' }); return; }
        const raw = await rawBody(req, 65536);
        if (!bearer && !signedByLLBot(req, raw, config.webhookToken)) { send(res, 401, { error: 'unauthorized' }); return; }
        const data = jsonBody(raw);
        const message = !data.post_type || data.post_type === 'message';
        let result: unknown;
        if (message) result = await qqAccess.receive(data as unknown as QQMessage, bearer ? url.searchParams.get('courseId') ?? undefined : undefined);
        else if (data.post_type === 'notice' && data.notice_type === 'group_upload') {
          result = receiveGroupUpload(engine, data);
          if (result && typeof result === 'object' && 'event' in result && result.event && groups)
            void groups.ingest(result.event as Event).catch(error =>
              engine.store.audit('groupfile.failed', { error: error instanceof Error ? error.message : '群文件下载失败' }));
        } else result = { ignored: true };
        if (bearer) send(res, message ? 202 : 200, result);
        else res.writeHead(204).end();
        return;
      }
      if (!authorized(req, config.adminToken)) { send(res, 401, { error: 'unauthorized' }); return; }
      const assistantPath = /^\/v1\/(dsh\/)?courses\/([^/]+)\/conversation(?:\/([0-9a-f-]{36}))?$/.exec(url.pathname);
      if (assistantPath) {
        const courseId = decodeURIComponent(assistantPath[2]), eventId = assistantPath[3];
        if (req.method === 'GET') {
          send(res, 200, eventId ? conversation.turn(courseId, eventId) : conversation.history(courseId)); return;
        }
        if (req.method === 'POST' && !eventId) {
          const data = await body(req, 32768);
          send(res, 202, conversation.send(courseId, assistantPath[1] ? 'dsh' : 'workbench', str(data, 'message'), str(data, 'requestId')));
          return;
        }
      }
      const mailRoute = /^\/v1\/courses\/([^/]+)\/mail(?:\/(check|sync|messages\/([a-f0-9-]{36})(?:\/(review|reply|grade|files\/([1-3])))?))?$/.exec(url.pathname);
      if (mailRoute && mail) {
        const courseId = decodeURIComponent(mailRoute[1]), [, , route, message, action, file] = mailRoute;
        if (req.method === 'GET' && !route) { send(res, 200, mail.get(courseId)); return; }
        if (req.method === 'PUT' && !route) { send(res, 200, mail.save(courseId, await body(req, 8192))); return; }
        if (req.method === 'POST' && route === 'check') { send(res, 200, await mail.check(courseId)); return; }
        if (req.method === 'POST' && route === 'sync') { send(res, 200, await mail.sync(courseId)); return; }
        if (req.method === 'GET' && message && !action) { send(res, 200, mail.read(courseId, message)); return; }
        if (req.method === 'GET' && file) { send(res, 200, mail.file(courseId, message, Number(file))); return; }
        if (req.method === 'POST' && action === 'review') {
          const data = await body(req, 8192);
          if (typeof data.ignore !== 'boolean') throw new DomainError('invalid', '需选择登记或忽略');
          send(res, 200, mail.review(courseId, message, text(data, 'assignmentId'), text(data, 'name'), data.ignore)); return;
        }
        if (req.method === 'POST' && action === 'reply') {
          send(res, 200, await mail.reply(courseId, message, str(await body(req), 'text'))); return;
        }
        if (req.method === 'POST' && action === 'grade') { send(res, 202, mail.requestGrade(courseId, message)); return; }
      }
      const batchRoute = /^\/v1\/courses\/([^/]+)\/grading-batches(?:\/([a-f0-9-]{36})\/(approve|reject))?$/.exec(url.pathname);
      if (batchRoute && batches) {
        const courseId = decodeURIComponent(batchRoute[1]);
        if (req.method === 'GET' && !batchRoute[2]) { send(res, 200, batches.list(courseId)); return; }
        if (req.method === 'POST' && batchRoute[2] && batchRoute[3] === 'approve') { send(res, 200, await batches.approve(courseId, batchRoute[2])); return; }
        if (req.method === 'POST' && batchRoute[2] && batchRoute[3] === 'reject') { send(res, 200, batches.reject(courseId, batchRoute[2])); return; }
      }
      const courseworkRoute = /^\/v1\/(?:dsh\/)?courses\/([^/]+)\/coursework(?:\/([^/]+)\/(review|files\/([1-3])))?$/.exec(url.pathname);
      if (courseworkRoute) {
        const courseId = decodeURIComponent(courseworkRoute[1]), id = courseworkRoute[2];
        if (req.method === 'GET' && !id) { send(res, 200, coursework.list(courseId)); return; }
        if (req.method === 'GET' && courseworkRoute[4]) {
          send(res, 200, coursework.file(courseId, decodeURIComponent(id), Number(courseworkRoute[4]))); return;
        }
        if (req.method === 'POST' && courseworkRoute[3] === 'review') {
          const data = await body(req), note = text(data, 'note');
          if (typeof data.accept !== 'boolean' || note.length > 500) throw new DomainError('invalid', '需提供审批选择，备注最多 500 字');
          send(res, 200, coursework.review(courseId, decodeURIComponent(id), revision(data), data.accept, note)); return;
        }
      }
      if (url.pathname.startsWith('/v1/dsh/')) {
        const [, , , resource, id, tail, item] = url.pathname.split('/');
        const courseId = resource === 'courses' && id ? decodeURIComponent(id) : '';
        if (courseId && tail === 'roster') {
          if (req.method === 'GET' && !item) { send(res, 200, roster.list('web:admin', courseId)); return; }
          if (req.method === 'POST' && ['add', 'import', 'prepare', 'confirm'].includes(item)) {
            const data = await body(req, item === 'import' ? 3_000_000 : 400_000);
            if (item === 'import') {
              const encoded = data.content;
              if (typeof encoded !== 'string' || encoded.length > Math.ceil(rosterFileLimit / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new DomainError('invalid', '名单文件无效');
              send(res, 200, roster.add('web:admin', courseId, parseRosterFile(str(data, 'name'), Buffer.from(encoded, 'base64')))); return;
            }
            if (item === 'add') send(res, 200, roster.add('web:admin', courseId, data.names));
            if (item === 'prepare') send(res, 200, roster.prepare('web:admin', courseId, data.names));
            if (item === 'confirm') send(res, 200, roster.confirm('web:admin', courseId, str(data, 'code')));
            return;
          }
        }
        if (courseId && req.method === 'GET' && tail === 'group-file' && !item) {
          send(res, 200, dsh.groupFileOptions(courseId)); return;
        }
        if (courseId && req.method === 'POST' && tail === 'textbook' && !item) {
          const data = await body(req, 8192);
          const action = str(data, 'action');
          const names = { lookup: 'lookup_textbook', search: 'search_textbook', section: 'textbook_section', page: 'view_textbook_page' };
          if (!Object.hasOwn(names, action)) throw new DomainError('invalid', '未知的教材操作');
          const course = engine.store.course(courseId);
          if (!course) throw new DomainError('not_found', '课程不存在');
          const { action: _, ...args } = data;
          const controller = new AbortController();
          res.once('close', () => controller.abort());
          const result = await qa.call({ course, history: [] }, names[action as keyof typeof names], JSON.stringify(args), controller.signal, true);
          if (typeof result === 'string') { send(res, 200, { data: JSON.parse(result) }); return; }
          const metadata = result.find(item => item.type === 'text');
          const image = result.find(item => item.type === 'image_url');
          if (metadata?.type !== 'text' || image?.type !== 'image_url' || !image.image_url.url.startsWith('data:image/png;base64,'))
            throw new DomainError('unavailable', '教材页图不可用');
          send(res, 200, { data: JSON.parse(metadata.text), png: image.image_url.url.slice('data:image/png;base64,'.length) }); return;
        }
        if (courseId && req.method === 'POST' && tail === 'group-file' && !item) {
          const data = await body(req, Math.ceil(maxHandoutBytes / 3) * 4 + 4096);
          const requestId = str(data, 'requestId'), encoded = data.content;
          if (!/^[a-f0-9]{64}$/.test(requestId) || typeof encoded !== 'string' ||
              encoded.length > Math.ceil(maxHandoutBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
            throw new DomainError('invalid', '群文件编号或内容无效');
          }
          send(res, 202, dsh.groupFile(courseId, str(data, 'groupId'), str(data, 'name'), Buffer.from(encoded, 'base64'), requestId)); return;
        }
        if (courseId && req.method === 'GET' && tail === 'brief' && !item) { send(res, 200, dsh.brief(courseId)); return; }
        if (courseId && req.method === 'POST' && !item && tail === 'task-memory') {
          const data = await body(req, 8192);
          send(res, 200, dsh.taskMemory(courseId, text(data, 'query'), text(data, 'taskId'))); return;
        }
        if (courseId && req.method === 'POST' && !item && tail === 'task-revision') {
          const data = await body(req, 32768);
          send(res, 200, dsh.reviseTask(courseId, str(data, 'taskId'), revision(data), str(data, 'goal'), str(data, 'requestId'))); return;
        }
        if (courseId && req.method === 'GET' && tail === 'messages' && !item) {
          const cursor = url.searchParams.get('before'), messageId = url.searchParams.get('messageId') ?? undefined;
          const before = cursor ? Number(cursor) : undefined;
          if ((before !== undefined && (!Number.isSafeInteger(before) || before < 1)) || (messageId && !/^-?\d{1,20}$/.test(messageId))) {
            throw new DomainError('invalid', '消息游标或消息编号无效');
          }
          send(res, 200, dsh.messages(courseId, { teacher: url.searchParams.get('teacher') === '1', before, messageId })); return;
        }
        if (courseId && tail === 'attachments' && req.method === 'GET' && item) {
          const index = Number(url.searchParams.get('index'));
          if (!Number.isSafeInteger(index) || index < 1) throw new DomainError('invalid', '附件序号从 1 开始');
          const controller = new AbortController();
          res.once('close', () => controller.abort());
          send(res, 200, await dsh.attachment(courseId, decodeURIComponent(item), index, controller.signal)); return;
        }
        if (courseId && tail === 'teacher-question' && req.method === 'POST' && !item) {
          const data = await body(req), question = str(data, 'text'), requestId = str(data, 'requestId');
          if (question.length > 1200 || !/^[a-f0-9]{64}$/.test(requestId)) throw new DomainError('invalid', '问题最多 1200 字，需有效请求编号');
          send(res, 202, dsh.ask(courseId, question, requestId)); return;
        }
        if (courseId && tail === 'images' && req.method === 'GET' && item) {
          const png = engine.store.teachingImage(courseId, item);
          if (!png) throw new DomainError('not_found', '本课程找不到该图片');
          send(res, 200, { png: png.toString('base64') }); return;
        }
        if (courseId && tail === 'render' && req.method === 'POST' && !item) {
          const data = await body(req);
          if (data.preview !== undefined && typeof data.preview !== 'boolean') throw new DomainError('invalid', 'preview 必须是布尔值');
          send(res, 201, await dsh.render(courseId, str(data, 'text'), data.preview === true)); return;
        }
        if (courseId && tail === 'assignments' && req.method === 'POST' && !item) {
          const data = await body(req), requestId = str(data, 'requestId');
          if (!/^[a-f0-9]{64}$/.test(requestId)) throw new DomainError('invalid', '写入请求编号无效');
          const assignmentId = str(data, 'assignmentId', true) || undefined;
          send(res, assignmentId ? 200 : 201, dsh.writeAssignment(courseId, requestId, {
            id: assignmentId, revision: assignmentId ? revision(data) : undefined, courseId, title: str(data, 'title'),
            instructions: str(data, 'instructions'), deadline: str(data, 'deadline'), gradingPolicy: text(data, 'gradingPolicy'),
            studentVisible: assignmentVisibility(data),
          })); return;
        }
        if (courseId && tail === 'assignments' && item && /^\/v1\/dsh\/courses\/[^/]+\/assignments\/[^/]+\/extensions$/.test(url.pathname) &&
            (req.method === 'GET' || req.method === 'PUT')) {
          const assignmentId = decodeURIComponent(item);
          if (academics.assignment(assignmentId).courseId !== courseId) throw new DomainError('not_found', '该作业不属于当前课程');
          if (req.method === 'GET') { send(res, 200, academics.extensions('web:admin', assignmentId)); return; }
          const data = await body(req);
          const entryRevision = data.revision;
          if (typeof entryRevision !== 'number' || !Number.isSafeInteger(entryRevision) || entryRevision < 0 ||
            typeof data.assignmentRevision !== 'number' || !Number.isSafeInteger(data.assignmentRevision) || data.assignmentRevision < 1)
            throw new DomainError('invalid', '需提供有效作业版本和延期版本');
          send(res, 200, academics.setExtension('web:admin', assignmentId, str(data, 'studentName'), {
            deadline: data.deadline === null ? null : str(data, 'deadline'), reason: text(data, 'reason'),
            revision: entryRevision, assignmentRevision: data.assignmentRevision,
          })); return;
        }
        if (courseId && tail === 'scores' && req.method === 'POST' && !item) {
          const data = await body(req);
          if (!Array.isArray(data.students) || !data.students.every(s => s && typeof s === 'object' && typeof s.name === 'string' && typeof s.revision === 'number' && typeof s.score === 'number')) {
            throw new DomainError('invalid', '每个学生需填写姓名、成绩、登记版本');
          }
          send(res, 200, dsh.registerScores(courseId, str(data, 'assignmentId'), data.students)); return;
        }
        if (req.method === 'GET' && resource === 'courses' && !id) { send(res, 200, dsh.courses()); return; }
        if (courseId && tail === 'assignments' && req.method === 'GET' && !item) {
          const assignmentId = url.searchParams.get('assignmentId');
          const image = url.searchParams.get('attachment');
          const attachment = image === null ? undefined : Number(image);
          if ((assignmentId !== null && !assignmentId.trim()) ||
            (attachment !== undefined && (!assignmentId || !Number.isSafeInteger(attachment) || attachment < 1))) {
            throw new DomainError('invalid', '指定题图时须提供作业 ID 和从 1 开始的题图序号');
          }
          send(res, 200, assignmentId ? dsh.assignment(courseId, assignmentId, attachment) : dsh.assignments(courseId)); return;
        }
        if (req.method === 'GET' && resource === 'courses' && id && tail === 'class-context') {
          const days = Number(url.searchParams.get('days') ?? 7);
          const qq = url.searchParams.get('qq')?.trim(), student = url.searchParams.get('student')?.trim();
          if (!Number.isInteger(days) || days < 1 || days > 30 || (qq && !/^\d{1,20}$/.test(qq)) || (student && student.length > 100)) {
            throw new DomainError('invalid', '天数须为 1–30，QQ 须为数字，学生姓名最多 100 字');
          }
          send(res, 200, classContext(engine, decodeURIComponent(id), { days, qq, student }));
          return;
        }
        if (req.method === 'GET' && resource === 'requests' && id && !tail) { send(res, 200, dsh.status(decodeURIComponent(id))); return; }
        if (req.method === 'POST' && resource === 'requests' && !id) {
          const data = await body(req), requestId = str(data, 'requestId');
          if (!/^[a-zA-Z0-9_-]{1,150}$/.test(requestId)) throw new DomainError('invalid', '请求编号无效');
          send(res, 202, dsh.question(str(data, 'courseId'), str(data, 'request'), requestId)); return;
        }
        if (req.method === 'POST' && resource === 'announcement' && (id === 'preview' || id === 'confirm' || id === 'message-preview') && !tail) {
          const data = await body(req);
          if (id === 'preview') send(res, 200, dsh.preview(str(data, 'courseId'), str(data, 'assignmentId')));
          else if (id === 'message-preview') send(res, 200, dsh.groupPreview(str(data, 'courseId'), str(data, 'text'), str(data, 'imageId', true) || undefined));
          else send(res, 202, dsh.confirm(typeof data.confirmation === 'string' && data.confirmation.length < 120_000 ? data.confirmation : ''));
          return;
        }
      }
      const activities = /^\/v1\/courses\/([^/]+)\/activities(?:\/(\d+))?$/.exec(url.pathname);
      if (activities && req.method === 'GET') {
        const course = decodeURIComponent(activities[1]);
        if (!engine.store.course(course)) throw new DomainError('not_found', '课程不存在');
        if (activities[2]) {
          const record = activityDetail(engine.store, course, Number(activities[2]));
          if (!record) throw new DomainError('not_found', '活动不存在');
          send(res, 200, record);
        } else {
          const cursor = url.searchParams.get('before');
          const before = cursor === null ? Number.MAX_SAFE_INTEGER : Number(cursor);
          if (!Number.isSafeInteger(before) || before < 1) throw new DomainError('invalid', '活动游标无效');
          send(res, 200, activityPage(engine.store, course, before, url.searchParams.get('event') || undefined));
        }
        return;
      }
      const memories = /^\/v1\/courses\/([^/]+)\/memories$/.exec(url.pathname);
      if (memories && req.method === 'GET') {
        send(res, 200, memory.list('web:admin', decodeURIComponent(memories[1]))); return;
      }
      const memoryRoute = /^\/v1\/memories\/([^/]+)$/.exec(url.pathname);
      if (memoryRoute && req.method === 'GET') {
        send(res, 200, memory.detail('web:admin', decodeURIComponent(memoryRoute[1]))); return;
      }
      if (memoryRoute && req.method === 'PUT') {
        const data = await body(req);
        if (!Array.isArray(data.topics) || !data.topics.every(t => typeof t === 'string')) throw new DomainError('invalid', 'topics必须为字符串数组');
        send(res, 200, memory.revise('web:admin', decodeURIComponent(memoryRoute[1]), revision(data), {
          observation: str(data, 'observation'), outcome: text(data, 'outcome'), topics: data.topics as string[],
        })); return;
      }
      const retireMemory = /^\/v1\/memories\/([^/]+)\/retire$/.exec(url.pathname);
      if (retireMemory && req.method === 'POST') {
        send(res, 200, memory.retire('web:admin', decodeURIComponent(retireMemory[1]), revision(await body(req)))); return;
      }
      const memoryJobs = /^\/v1\/courses\/([^/]+)\/memory-jobs$/.exec(url.pathname);
      if (memoryJobs && req.method === 'GET') {
        const courseId = decodeURIComponent(memoryJobs[1]);
        if (!engine.store.course(courseId)) throw new DomainError('not_found', '课程不存在');
        send(res, 200, engine.store.db.prepare("SELECT id,status,attempts,error FROM memory_jobs WHERE json_extract(data,'$.courseId')=? ORDER BY rowid DESC LIMIT 100").all(courseId)); return;
      }
      const retryMemory = /^\/v1\/memory-jobs\/([^/]+)\/retry$/.exec(url.pathname);
      if (retryMemory && req.method === 'POST') {
        const id = decodeURIComponent(retryMemory[1]);
        const row = engine.store.db.prepare('SELECT data,status FROM memory_jobs WHERE id=?').get(id);
        if (!row) throw new DomainError('not_found', '记忆任务不存在');
        if (row.status !== 'failed') throw new DomainError('conflict', '只有失败的记忆任务可以重试');
        if (!engine.memory.jobValid(JSON.parse(String(row.data)))) throw new DomainError('stale', '记忆来源已修订');
        engine.store.db.prepare("UPDATE memory_jobs SET status='pending',error=NULL WHERE id=?").run(id);
        engine.store.audit('memory.retry', { jobId: id, actorId: 'web:admin' }); send(res, 202, { queued: true }); return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/courses') { send(res, 200, engine.store.courses()); return; }
      if (req.method === 'GET' && url.pathname === '/v1/tasks') { send(res, 200, engine.store.tasks()); return; }
      if (req.method === 'GET' && url.pathname === '/v1/deliveries') { send(res, 200, engine.store.deliveries()); return; }
      const alertsRoute = /^\/v1\/courses\/([^/]+)\/alerts$/.exec(url.pathname);
      if (alertsRoute && req.method === 'GET') {
        const courseId = decodeURIComponent(alertsRoute[1]);
        if (!engine.store.course(courseId)) throw new DomainError('not_found', '课程不存在');
        send(res, 200, { alerts: listAlerts(engine.store, courseId, Math.min(50, Number(url.searchParams.get('limit') ?? 20) || 20)) });
        return;
      }
      const inboxRoute = /^\/v1\/courses\/([^/]+)\/inbox$/.exec(url.pathname);
      if (inboxRoute && req.method === 'GET') {
        const courseId = decodeURIComponent(inboxRoute[1]);
        if (!engine.store.course(courseId)) throw new DomainError('not_found', '课程不存在');
        send(res, 200, { ...courseInbox(engine, courseId, { limit: Math.min(100, Number(url.searchParams.get('limit') ?? 50) || 50) }),
          proposals: buildProposals(engine, courseId) });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/events') {
        send(res, 200, engine.store.db.prepare('SELECT e.id,e.routed,e.error,a.thread_id AS threadId,a.revision AS threadRevision FROM events e JOIN event_threads a ON a.event_id=e.id ORDER BY e.rowid DESC LIMIT 100').all()); return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/threads') {
        send(res, 200, engine.store.events().slice(-100).map(e => ({ eventId: e.id, text: e.text, actor: e.actor, channel: e.channel, courseId: e.courseId, ...engine.store.assignment(e.id) }))); return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/threads/changes') {
        send(res, 200, engine.store.db.prepare('SELECT * FROM thread_changes ORDER BY rowid DESC LIMIT 100').all().map(r => ({ ...r, data: JSON.parse(String(r.data)) }))); return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/threads/reclassify') {
        const data = await body(req), reason = str(data, 'reason');
        if (!Array.isArray(data.moves) || !data.moves.length || !data.moves.every(m => m && typeof m === 'object' && typeof m.eventId === 'string' && Number.isSafeInteger(m.revision))) throw new DomainError('invalid', 'moves须为消息ID和归属版本数组');
        const moves = data.moves as { eventId: string; revision: number }[];
        const first = engine.store.event(moves[0].eventId);
        if (!first) throw new DomainError('not_found', '消息不存在');
        const targetEventId = str(data, 'targetEventId', true) || undefined;
        if (targetEventId && (typeof data.targetRevision !== 'number' || !Number.isSafeInteger(data.targetRevision))) throw new DomainError('invalid', '目标锚点需提供targetRevision');
        const event = adminEvent(engine, first.courseId, JSON.stringify({ operation: 'thread.reclassify', reason, moves }));
        engine.store.markRouted(event.id);
        send(res, 200, engine.reclassify({ feedbackEventId: event.id, moves, targetEventId, targetRevision: data.targetRevision as number | undefined, reason })); return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/courses') {
        const data = await body(req);
        const course = { ...courseFields(data, str(data, 'id')), revision: 1 };
        if (course.progress?.trim()) Object.assign(course, { progressAt: engine.now(), progressSource: 'teacher' });
        engine.createCourse('web:admin', course); send(res, 201, course); return;
      }
      const courseRoute = /^\/v1\/courses\/([^/]+)$/.exec(url.pathname);
      const schedulesRoute = /^\/v1\/courses\/([^/]+)\/schedules$/.exec(url.pathname);
      const startSchedule = /^\/v1\/courses\/([^/]+)\/schedules\/([^/]+)\/run$/.exec(url.pathname);
      if (req.method === 'POST' && startSchedule) {
        const course = engine.store.course(decodeURIComponent(startSchedule[1]));
        const plan = course && weeklyTasks(course).find(item => item.id === decodeURIComponent(startSchedule[2]));
        if (!course || !plan) throw new DomainError('not_found', '找不到课内定时任务');
        if (plan.worker === 'dsh' && !config.headless) throw new DomainError('unavailable', '此服务器尚未启用隔离 DSH Worker');
        const key = 'manual-schedule:' + randomUUID();
        const { event } = engine.receive({ sourceKey: key, externalId: key, courseId: course.id, threadId: key, actorId: 'web:admin',
          channel: { kind: 'management', target: plan.title }, text: plan.prompt, receivedAt: engine.now(), scheduled: 'custom',
          scheduledTools: plan.tools, scheduledWorker: plan.worker });
        send(res, 202, { eventId: event.id }); return;
      }
      if (schedulesRoute && (req.method === 'GET' || req.method === 'PUT')) {
        const id = decodeURIComponent(schedulesRoute[1]);
        const course = engine.store.course(id);
        if (!course) throw new DomainError('not_found', '课程不存在');
        const capabilities = { availableTools: scheduledTools, dshOnlyTools: [...dshOnlyTools], dshAvailable: !!config.headless };
        if (req.method === 'GET') { send(res, 200, { revision: course.revision, tasks: weeklyTasks(course), ...capabilities }); return; }
        const data = await body(req, 280_000);
        if (!Array.isArray(data.tasks) || data.tasks.length > 24) throw new DomainError('invalid', '每门课最多配置 24 个定时任务');
        const saved = weeklyTasks(course);
        const tasks = data.tasks.map((value: unknown) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('invalid', '定时任务格式无效');
          const row = value as Record<string, unknown>;
          const taskId = str(row, 'id'), title = str(row, 'title'), prompt = str(row, 'prompt');
          const { weekday, time, tools, enabled } = row;
          const teacherQQ = text(row, 'teacherQQ');
          if (!/^[\w-]{1,80}$/.test(taskId) || title.length > 100 || prompt.length > 8000 ||
              typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 0 || weekday > 6 ||
              typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) || typeof enabled !== 'boolean' ||
              (teacherQQ && (!/^\d+$/.test(teacherQQ) || !engine.policy.isTeacher('qq:' + teacherQQ))) ||
              !Array.isArray(tools) || tools.some(tool => !scheduledTools.includes(tool))) throw new DomainError('invalid', '任务名称、提示词、时间、教师或工具配置无效');
          const prior = saved.find(task => task.id === taskId);
          const worker = row.worker ?? prior?.worker ?? 'native';
          if (worker !== 'native' && worker !== 'dsh' || worker === 'native' && tools.some(tool => dshOnlyTools.has(tool)))
            throw new DomainError('invalid', '此工具需要 DSH 执行方式');
          if (worker === 'dsh' && !config.headless) throw new DomainError('unavailable', '此服务器尚未启用隔离 DSH Worker');
          return { id: taskId, title, prompt, weekday, time, enabled, tools: [...new Set<ScheduledTool>(tools)], teacherQQ: teacherQQ || undefined,
            worker: worker as 'native' | 'dsh',
            enabledAt: prior?.enabled && prior.weekday === weekday && prior.time === time ? prior.enabledAt : engine.now() };
        });
        if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new DomainError('invalid', '定时任务 ID 重复');
        const next = engine.updateCourse('web:admin', { ...course, weeklyTasks: tasks, weeklyLesson: undefined }, revision(data));
        send(res, 200, { revision: next.revision, tasks, ...capabilities }); return;
      }
      if (req.method === 'PUT' && courseRoute) {
        const data = await body(req);
        const id = decodeURIComponent(courseRoute[1]);
        const course = courseFields(data, id);
        course.weeklyTasks = engine.store.course(id)?.weeklyTasks;
        const oldSchedule = engine.store.course(id)?.weeklyLesson;
        const schedule = data.weeklyLesson;
        if (schedule === undefined) course.weeklyLesson = oldSchedule;
        else if (schedule !== null) {
          if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) throw new DomainError('invalid', '定时备课设置无效');
          const { weekday, time, teacherQQ } = schedule as Record<string, unknown>;
          if (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 0 || weekday > 6 ||
              typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) ||
              typeof teacherQQ !== 'string' || !/^\d+$/.test(teacherQQ) || !engine.policy.isTeacher('qq:' + teacherQQ)) {
            throw new DomainError('invalid', '请选择星期和时间，并填写已授权的教师 QQ 号');
          }
          course.weeklyLesson = { weekday, time, teacherQQ,
            enabledAt: oldSchedule?.weekday === weekday && oldSchedule.time === time ? oldSchedule.enabledAt : engine.now() };
        }
        send(res, 200, engine.updateCourse('web:admin', course, revision(data))); return;
      }
      const assignments = /^\/v1\/courses\/([^/]+)\/assignments$/.exec(url.pathname);
      if (assignments && req.method === 'GET') { send(res, 200, academics.assignments(decodeURIComponent(assignments[1]))); return; }
      if (assignments && req.method === 'POST') {
        const data = await body(req, assignmentBodyLimit);
        send(res, 201, academics.saveAssignment('web:admin', { courseId: decodeURIComponent(assignments[1]), title: str(data, 'title'), instructions: text(data, 'instructions'), deadline: str(data, 'deadline'), gradingPolicy: text(data, 'gradingPolicy'), images: data.images, studentVisible: assignmentVisibility(data) })); return;
      }
      const assignmentRoute = /^\/v1\/assignments\/([^/]+)$/.exec(url.pathname);
      if (assignmentRoute && req.method === 'GET') { send(res, 200, academics.assignment(decodeURIComponent(assignmentRoute[1]))); return; }
      if (assignmentRoute && req.method === 'PUT') {
        const data = await body(req, assignmentBodyLimit), old = academics.assignment(decodeURIComponent(assignmentRoute[1]));
        send(res, 200, academics.saveAssignment('web:admin', { id: old.id, courseId: old.courseId, title: str(data, 'title'), instructions: text(data, 'instructions'), deadline: str(data, 'deadline'), gradingPolicy: text(data, 'gradingPolicy'), revision: revision(data), images: data.images, studentVisible: assignmentVisibility(data) })); return;
      }
      const extensions = /^\/v1\/assignments\/([^/]+)\/extensions(?:\/([^/]+))?$/.exec(url.pathname);
      if (extensions && req.method === 'GET' && !extensions[2]) {
        send(res, 200, academics.extensions('web:admin', decodeURIComponent(extensions[1]))); return;
      }
      if (extensions?.[2] && req.method === 'PUT') {
        const data = await body(req);
        if (typeof data.revision !== 'number' || !Number.isSafeInteger(data.revision) || data.revision < 0) throw new DomainError('invalid', '延期记录版本无效');
        send(res, 200, academics.setExtension('web:admin', decodeURIComponent(extensions[1]), decodeURIComponent(extensions[2]), {
          deadline: data.deadline === null ? null : str(data, 'deadline'), reason: text(data, 'reason'), revision: data.revision,
          assignmentRevision: revision({ revision: data.assignmentRevision }),
        }));
        return;
      }
      const offline = /^\/v1\/assignments\/([^/]+)\/offline$/.exec(url.pathname);
      if (offline && req.method === 'GET') { send(res, 200, academics.offline(decodeURIComponent(offline[1]))); return; }
      if (offline && req.method === 'POST') {
        const data = await body(req);
        if (!Array.isArray(data.students) || !data.students.every(s => s && typeof s === 'object' && typeof s.name === 'string' && typeof s.revision === 'number' && typeof s.score === 'number')) {
          throw new DomainError('invalid', '每条登记须包含姓名、分数和登记版本，请使用新版工作台');
        }
        send(res, 200, academics.register('web:admin', decodeURIComponent(offline[1]), data.students)); return;
      }
      const remove = /^\/v1\/assignments\/([^/]+)\/offline\/([^/]+)$/.exec(url.pathname);
      if (remove && req.method === 'DELETE') {
        const data = await body(req);
        academics.remove('web:admin', decodeURIComponent(remove[1]), decodeURIComponent(remove[2]), revision(data)); send(res, 200, { removed: true }); return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/tasks') {
        const data = await body(req), kind = str(data, 'kind');
        if (kind !== 'qa' && kind !== 'lesson') throw new DomainError('invalid', '当前支持qa或lesson任务');
        const goal = str(data, 'goal');
        const event = adminEvent(engine, str(data, 'courseId'), goal);
        send(res, 201, engine.createTask(event.id, kind, goal)); return;
      }
      const artifact = /^\/v1\/tasks\/([^/]+)\/artifacts\/([a-f0-9]{64})$/.exec(url.pathname);
      if (req.method === 'GET' && artifact && config.headless) {
        const task = engine.store.task(artifact[1]);
        const item = task?.artifacts?.find(file => file.sha256 === artifact[2]);
        if (!task || !item) throw new DomainError('not_found', '未找到任务产物');
        const bytes = await dshFile(dshArtifacts(config.headless.workspace, task.courseId, task.id), item.sha256);
        if (bytes.length !== item.bytes || createHash('sha256').update(bytes).digest('hex') !== item.sha256)
          throw new DomainError('conflict', '任务产物内容已变化');
        send(res, 200, { name: item.name, data: bytes.toString('base64') }); return;
      }
      const control = /^\/v1\/tasks\/([^/]+)\/control$/.exec(url.pathname);
      if (req.method === 'POST' && control) {
        const data = await body(req), action = str(data, 'action');
        if (!['revise', 'pause', 'resume', 'cancel'].includes(action)) throw new DomainError('invalid', '未知控制动作');
        const revision = data.revision;
        if (typeof revision !== 'number' || !Number.isSafeInteger(revision)) throw new DomainError('invalid', '必须提供整数revision');
        const task = engine.store.task(control[1]);
        if (!task) throw new DomainError('not_found', '任务不存在');
        const goal = str(data, 'goal', true);
        const event = adminEvent(engine, task.courseId, JSON.stringify({ action, taskId: task.id, goal }));
        // A direct management command must not later enter the natural language Router.
        engine.store.markRouted(event.id);
        send(res, 200, engine.control(event.id, task.id, action as 'pause' | 'resume' | 'cancel' | 'revise', revision, goal)); return;
      }
      const retry = /^\/v1\/events\/([^/]+)\/retry$/.exec(url.pathname);
      if (req.method === 'POST' && retry) {
        if (!engine.store.event(retry[1])) throw new DomainError('not_found', '事件不存在');
        engine.store.db.prepare('UPDATE events SET routed=0,error=NULL WHERE id=?').run(retry[1]);
        send(res, 202, { queued: true }); return;
      }
      const reconsider = /^\/v1\/events\/([^/]+)\/reconsider$/.exec(url.pathname);
      if (req.method === 'POST' && reconsider) {
        if (!engine.store.event(reconsider[1])) throw new DomainError('not_found', '反馈消息不存在');
        engine.store.review(reconsider[1]); send(res, 202, { reviewQueued: true }); return;
      }
      send(res, 404, { error: 'not_found' });
    } catch (error) {
      const status = error instanceof DomainError ? ({ forbidden: 403, not_found: 404, stale: 409, conflict: 409, invalid: 400, unavailable: 503 }[error.code] ?? 400) : 500;
      send(res, status, { error: error instanceof DomainError ? error.code : 'internal', message: status === 500 ? '操作失败，检查服务日志和配置' : (error as Error).message });
      if (status === 500) console.error('HTTP operation failed:', error instanceof Error ? error.message : 'unknown');
    }
  });
}
