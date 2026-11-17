import { Academics } from '../application/services/academics.ts';
import { studentCoursework } from '../application/services/student-coursework.ts';
import { studentSubmission } from '../application/services/student-submission.ts';
import { CourseworkIntake } from '../application/services/coursework-intake.ts';
import { CourseContent } from '../application/services/course-content.ts';
import type { CourseFiles } from '../application/services/course-files.ts';
import type { PdfImage } from '../adapters/documents/pdf-image.ts';
import type { TaskEngine } from '../application/task-engine.ts';
import type { Event, Run } from '../domain/model.ts';
import { DomainError, channelKey } from '../domain/model.ts';
import type { TextbookReferences } from '../adapters/knowledge/references.ts';
import type { PageReader } from '../adapters/knowledge/pdf-page.ts';
import type { Knowledge } from '../ports/knowledge.ts';
import type { ToolDefinition, VisualContent } from '../ports/model.ts';
import { describeAttachments, qqImageType } from '../adapters/qq/attachments.ts';
import type { QQAttachmentReader } from '../adapters/qq/attachments.ts';

const str = { type: 'string' };
const integer = { type: 'integer', minimum: 1 };
function tool(name: string, description: string, properties: object, required: string[] = []): ToolDefinition {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } };
}
export const qaToolDefinitions = [
  tool('list_assignments', '查本课程学生可见的作业目录及截止日期。多份可能时先澄清。', {}),
  tool('read_assignment', '按目录中的作业 ID 查题面和提交要求。需要核对题图时指定 attachment（从1开始）。', { assignmentId: str, attachment: integer }, ['assignmentId']),
  tool('lookup_textbook', '精确定位本课教材章节/习题/定理编号，例如 2.1节 T2；可按 bookId 选择课程内教材。', { query: str, bookId: str }, ['query']),
  tool('search_textbook', '按概念或方法检索本课教材。结果是定位候选，不能替代精确题号。', { query: str, bookId: str }, ['query']),
  tool('textbook_section', '核对本课教材的具体节号（例如 17.2），返回节标题、子专题、页码与节内摘录。', { sectionId: str, bookId: str }, ['sectionId']),
  tool('view_textbook_page', '查阅本课教材原始 PDF 的物理页，必须使用检索结果中的 bookId 和页码。', { bookId: str, page: integer }, ['bookId','page']),
  tool('read_quoted_message', '读取当前消息明确引用的那一条原消息或助教已发回复。', {}),
  tool('read_qq_image', '查看本次 QQ 消息或其明确引用中的图片。source 为 current 或 quoted，图片序号从 1 开始。', {
    source: { type: 'string', enum: ['current', 'quoted'] }, index: integer,
  }),
  tool('my_coursework', '查询提问学生本人本课程的提交、分数与个人延期。仅限学生私聊；群聊或未核对身份时只返回说明，不返回他人记录。', {}),
  tool('read_my_submission', '查看提问学生本人某份作业的已登记提交：先看附件列表，指定 fileIndex 可看图片、PDF 页或文本。仅限学生私聊。', { assignmentId: str, fileIndex: integer, page: integer }, ['assignmentId']),
  tool('request_extension', '学生用自然语言提出延期时调用：按作业 ID、新截止时间（ISO，含时区）和理由创建待教师审批的申请。仅限学生私聊；未绑定身份时需带名单姓名。', {
    assignmentId: str, deadline: str, reason: str, name: str,
  }, ['assignmentId', 'deadline', 'reason']),
  tool('search_course_content', '在课程内容（讲义、群文件、本人提交）里检索，返回可打开的引用。学生只能看到已发布内容；需要讲义原文、群文件或自己交过的东西时先用它。', { query: str, kinds: str }, ['query']),
  tool('open_course_content', '按 search_course_content 返回的 ref 打开课程内容；讲义返回正文，群文件返回文件信息。', { ref: str }, ['ref']),
  tool('list_course_files', '列出本课程已发布、已存在服务器上的文件（讲义产物、群文件），返回 path 和大小。', {}),
  tool('read_course_file', '按 path 读取服务器上的课程文件：文本返回正文，图片与 PDF 页可直接查看，其他类型给元数据。', { path: str, page: integer }, ['path']),
  tool('read_message', '按事件 ID 读取当前任务讨论或已授权引用链中的一条消息原文；跨课程、跨渠道或他人私聊不可读。', { eventId: str }, ['eventId']),
  tool('read_more', '继续读取本轮上下文中被省略的原文。ref 必须来自上下文或本条工具返回的 ref 字段。', { ref: str }, ['ref']),
];
const positiveInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
const fileKind = (name: string, content: Buffer): 'image' | 'pdf' | 'text' | 'other' => {
  if (content.subarray(0, 4).toString('ascii') === '%PDF') return 'pdf';
  if (content[0] === 0x89 && content[1] === 0x50 && content[2] === 0x4e && content[3] === 0x47) return 'image';
  if (content[0] === 0xff && content[1] === 0xd8) return 'image';
  if (content.subarray(0, 4).toString('ascii') === 'RIFF' && content.subarray(8, 12).toString('ascii') === 'WEBP') return 'image';
  const extension = name.toLowerCase().split('.').at(-1) ?? '';
  return ['txt', 'md', 'csv'].includes(extension) ? 'text' : 'other';
};
const imageMediaType = (content: Buffer): string | undefined => {
  if (content[0] === 0x89 && content[1] === 0x50) return 'image/png';
  if (content[0] === 0xff && content[1] === 0xd8) return 'image/jpeg';
  if (content.subarray(0, 4).toString('ascii') === 'RIFF') return 'image/webp';
  return undefined;
};
const image = (metadata: object, url: string): VisualContent[] => [
  { type: 'text', text: JSON.stringify(metadata) },
  { type: 'image_url', image_url: { url } },
];

export class QATools {
  private readonly academics: Academics;
  constructor(privateEngine: TaskEngine, knowledge?: Knowledge, references?: Pick<TextbookReferences, 'lookup'> & Partial<Pick<TextbookReferences, 'sections'>>, pageReader?: PageReader, readAttachment?: QQAttachmentReader, pdfImage?: PdfImage, files?: CourseFiles) {
    this.engine = privateEngine; this.academics = new Academics(privateEngine);
    this.knowledge = knowledge; this.references = references; this.pageReader = pageReader; this.readAttachment = readAttachment;
    this.pdfImage = pdfImage; this.files = files;
  }
  private readonly engine: TaskEngine;
  private readonly knowledge?: Knowledge;
  private readonly references?: Pick<TextbookReferences, 'lookup'> & Partial<Pick<TextbookReferences, 'sections'>>;
  private readonly pageReader?: PageReader;
  private readonly readAttachment?: QQAttachmentReader;
  private readonly pdfImage?: PdfImage;
  private readonly files?: CourseFiles;

  /** 消息可见范围：本任务线程内的消息，加上沿明确引用可追溯的两跳。 */
  private authorized(run: Pick<Run, 'course' | 'history'> & { task?: Run['task'] }, id: string): boolean {
    const store = this.engine.store;
    if (!run.task) return false;
    const channel = run.task.grant.channel;
    const origin = run.task.grant.originEventId ? store.event(run.task.grant.originEventId) : undefined;
    const threadId = origin?.threadId ?? run.history.at(-1)?.event.threadId;
    if (!threadId) return false;
    // 本任务线程内的消息直接可读；其余只允许沿明确引用链追溯。
    const target = store.event(id);
    if (!target || target.courseId !== run.course.id) return false;
    if (channel && channelKey(target.channel) !== channelKey(channel)) return false;
    if (target.threadId === threadId) return true;
    const seeds: Event[] = [...run.history.map(input => input.event), ...(origin ? [origin] : [])];
    const queue = seeds.map(event => ({ event, depth: 0, viaQuote: false }));
    const seen = new Set<string>();
    while (queue.length) {
      const { event, depth, viaQuote } = queue.shift()!;
      if (!event || seen.has(event.id)) continue;
      seen.add(event.id);
      if (event.courseId !== run.course.id) continue;
      if (channel && channelKey(event.channel) !== channelKey(channel)) continue;
      if (!viaQuote && event.threadId !== threadId) continue;
      if (event.id === id) return true;
      if (depth < 2 && event.quotedExternalId) {
        const quoted = store.eventByKey(`qq:${channelKey(event.channel)}:${event.quotedExternalId}`);
        if (quoted) queue.push({ event: quoted, depth: depth + 1, viaQuote: true });
      }
    }
    return false;
  }

  async call(run: Pick<Run, 'course' | 'history' | 'assignmentReads' | 'knowledgeAnchors' | 'readRefs'> & { task?: Run['task'] }, name: string, raw: string, signal: AbortSignal, vision: boolean): Promise<string | VisualContent[]> {
    signal.throwIfAborted();
    const { id: courseId, textbookIds = [] } = run.course;
    const event = run.history.at(-1)?.event;
    try {
      if (raw.length > 4000) throw new DomainError('invalid', '参数过长');
      const args = JSON.parse(raw) as Record<string, unknown>;
      const definition = qaToolDefinitions.find(t => t.function.name === name);
      if (!args || typeof args !== 'object' || Array.isArray(args) || !definition) throw new DomainError('invalid', '不支持该工具或参数');
      const properties = (definition.function.parameters as { properties: object }).properties;
      if (Object.keys(args).some(key => !Object.hasOwn(properties, key))) throw new DomainError('invalid', '工具参数包含未授权字段');
      const query = () => {
        if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 600) throw new DomainError('invalid', '需要明确且简短的检索词');
        return args.query.trim();
      };
      const books = () => {
        if (args.bookId === undefined) return textbookIds;
        if (typeof args.bookId !== 'string' || !textbookIds.includes(args.bookId)) throw new DomainError('forbidden', '教材不属于本课程');
        return [args.bookId];
      };
      const remember = (item: { id: string; revision: number }) => {
        if (!run.assignmentReads) run.assignmentReads = [];
        if (!run.assignmentReads.some(read => read.id === item.id)) run.assignmentReads.push({ id: item.id, revision: item.revision });
      };
      if (name === 'list_assignments') {
        const assignments = this.academics.visibleAssignments(courseId).slice(-30).reverse();
        assignments.forEach(remember);
        return JSON.stringify({ courseId, assignments });
      }
      if (name === 'read_assignment') {
        if (typeof args.assignmentId !== 'string') throw new DomainError('invalid', '缺少作业 ID');
        const a = this.academics.visibleAssignment(courseId, args.assignmentId);
        remember(a);
        const metadata = { id: a.id, title: a.title, revision: a.revision, deadline: a.deadline, instructions: a.instructions,
          attachments: (a.images ?? []).map((file, i) => ({ index: i + 1, name: file.name })) };
        if (args.attachment === undefined) return JSON.stringify(metadata);
        const attachment = positiveInt(args.attachment) && a.images?.[args.attachment - 1];
        if (!attachment) throw new DomainError('not_found', '找不到这张作业题图');
        if (!vision) return JSON.stringify({ ...metadata, error: '当前模型不支持查看题图' });
        return image({ ...metadata, loadedAttachment: args.attachment }, attachment.dataUrl);
      }
      if (name === 'my_coursework') {
        if (!run.task) return JSON.stringify({ error: '缺少任务上下文，无法查询个人记录。' });
        const current = run.history.at(-1)?.event;
        if (!current) return JSON.stringify({ error: '缺少提问消息。' });
        if (run.task.grant.channel?.kind !== 'qq-private' || current.channel.kind !== 'qq-private')
          return JSON.stringify({ error: '个人提交与成绩只能在私聊中查询；请让学生私聊助教。' });
        if (current.actor.id !== run.task.grant.requester) return JSON.stringify({ error: '只能查询本人的记录。' });
        return JSON.stringify(studentCoursework(this.engine, courseId, current.actor.id));
      }
      if (name === 'read_my_submission') {
        if (!run.task) return JSON.stringify({ error: '缺少任务上下文，无法查看个人提交。' });
        const current = run.history.at(-1)?.event;
        if (!current) return JSON.stringify({ error: '缺少提问消息。' });
        if (run.task.grant.channel?.kind !== 'qq-private' || current.channel.kind !== 'qq-private')
          return JSON.stringify({ error: '个人提交内容只能在私聊中查看；请让学生私聊助教。' });
        if (current.actor.id !== run.task.grant.requester) return JSON.stringify({ error: '只能查看本人的提交。' });
        if (typeof args.assignmentId !== 'string' || !args.assignmentId) throw new DomainError('invalid', '需要作业 ID');
        const submission = studentSubmission(this.engine, courseId, current.actor.id, args.assignmentId);
        if (!submission.verified) return JSON.stringify({ error: submission.hint });
        const metadata = {
          assignment: submission.assignment, attempt: submission.attempt, submittedAt: submission.submittedAt, late: submission.late,
          files: submission.files.map(file => ({ index: file.index, name: file.name, bytes: file.bytes })),
        };
        if (!submission.files.length) return JSON.stringify({ ...metadata, error: submission.hint });
        if (args.fileIndex === undefined)
          return JSON.stringify({ ...metadata, hint: '指定 fileIndex 查看具体内容；图片与 PDF 可直接查看，其他类型只给元数据。' });
        if (!positiveInt(args.fileIndex)) throw new DomainError('invalid', 'fileIndex 需为从 1 开始的整数');
        const file = submission.files[args.fileIndex - 1];
        if (!file) throw new DomainError('not_found', '没有这个序号的附件');
        const kind = fileKind(file.name, file.content);
        const base = { assignmentId: args.assignmentId, fileIndex: file.index, name: file.name, bytes: file.bytes, kind };
        if (kind === 'image') {
          const media = imageMediaType(file.content);
          if (!vision || !media) return JSON.stringify({ ...base, error: '当前模型不能查看这张图片' });
          return image({ ...base, source: '学生提交的原文件' }, `data:${media};base64,${file.content.toString('base64')}`);
        }
        if (kind === 'pdf') {
          const page = positiveInt(args.page) ? args.page : 1;
          if (!vision || !this.pdfImage)
            return JSON.stringify({ ...base, page, error: '当前不能查看 PDF 页图；可以请学生把关键页截图发来。' });
          const url = await this.pdfImage(file.content, page, signal);
          if (!url) return JSON.stringify({ ...base, page, error: 'PDF 页图未生成（可能未安装渲染器）；可以请学生把关键页截图发来。' });
          return image({ ...base, page, source: '学生提交的原文件' }, url);
        }
        if (kind === 'text') {
          const text = file.content.toString('utf8').slice(0, 8000);
          return JSON.stringify({ ...base, text, truncated: file.content.length > 8000 });
        }
        return JSON.stringify({ ...base, error: '该文件类型暂时不能直接查看' });
      }
      if (name === 'request_extension') {
        if (!run.task) return JSON.stringify({ error: '缺少任务上下文。' });
        const current = run.history.at(-1)?.event;
        if (!current) return JSON.stringify({ error: '缺少提问消息。' });
        if (run.task.grant.channel?.kind !== 'qq-private' || current.channel.kind !== 'qq-private')
          return JSON.stringify({ error: '延期申请只能在私聊中提交；请让学生私聊助教。' });
        if (current.actor.id !== run.task.grant.requester) return JSON.stringify({ error: '只能为本人提交延期申请。' });
        if (typeof args.assignmentId !== 'string' || typeof args.deadline !== 'string' || typeof args.reason !== 'string')
          throw new DomainError('invalid', '需要作业 ID、新的截止时间与理由');
        try {
          const record = new CourseworkIntake(this.engine).requestExtension(current, args.assignmentId, args.deadline, args.reason,
            typeof args.name === 'string' ? args.name : undefined);
          return JSON.stringify({ id: record.id, status: 'pending', assignmentId: record.assignmentId, deadline: record.deadline,
            name: record.name, note: '已进入教师待审批，审批结果会私信通知。' });
        } catch (error) {
          if (error instanceof DomainError) return JSON.stringify({ error: error.message });
          throw error;
        }
      }
      if (name === 'search_course_content') {
        if (!run.task) return JSON.stringify({ error: '缺少任务上下文。' });
        const current = run.history.at(-1)?.event;
        if (!current) return JSON.stringify({ error: '缺少提问消息。' });
        if (typeof args.query !== 'string' || !args.query.trim()) throw new DomainError('invalid', '需要检索词');
        const kinds = typeof args.kinds === 'string'
          ? args.kinds.split(/[,，\s]+/).filter(kind => ['material', 'group-file', 'submission'].includes(kind)) as ('material' | 'group-file' | 'submission')[]
          : undefined;
        const hits = new CourseContent(this.engine).search(courseId, current.actor.id, args.query, { kinds });
        return JSON.stringify({ hits, hint: hits.length ? '用 open_course_content 打开引用。' : '没有找到已发布的对应内容。' });
      }
      if (name === 'open_course_content') {
        if (!run.task) return JSON.stringify({ error: '缺少任务上下文。' });
        const current = run.history.at(-1)?.event;
        if (!current) return JSON.stringify({ error: '缺少提问消息。' });
        if (typeof args.ref !== 'string' || !args.ref) throw new DomainError('invalid', '需要内容引用');
        try {
          const row = new CourseContent(this.engine).open(courseId, current.actor.id, args.ref);
          return JSON.stringify({ ref: row.ref, kind: row.kind, title: row.title, version: row.version,
            text: row.text.slice(0, 8000), truncated: row.text.length > 8000,
            ...(row.kind === 'group-file' ? { note: '群文件是二进制文件，可在工作台下载；需要内容时请学生发关键页截图。' } : {}) });
        } catch (error) {
          if (error instanceof DomainError) return JSON.stringify({ error: error.message });
          throw error;
        }
      }
      if (name === 'list_course_files') {
        if (!this.files) return JSON.stringify({ files: [], note: '服务器文件目录未配置。' });
        return JSON.stringify({ files: this.files.list(courseId) });
      }
      if (name === 'read_course_file') {
        if (!this.files) throw new DomainError('unavailable', '服务器文件读取未配置');
        if (typeof args.path !== 'string' || !args.path) throw new DomainError('invalid', '需要文件 path');
        const entry = this.files.read(courseId, args.path);
        const kind = fileKind(entry.name, entry.content);
        const base = { path: entry.path, name: entry.name, bytes: entry.bytes, kind };
        if (kind === 'text') {
          const text = entry.content.toString('utf8');
          return JSON.stringify({ ...base, text: text.slice(0, 20_000), truncated: text.length > 20_000 });
        }
        if (kind === 'image') {
          const media = imageMediaType(entry.content);
          if (!vision || !media) return JSON.stringify({ ...base, error: '当前模型不能查看这张图片' });
          return image(base, `data:${media};base64,${entry.content.toString('base64')}`);
        }
        if (kind === 'pdf') {
          const page = positiveInt(args.page) ? args.page : 1;
          if (!vision || !this.pdfImage) return JSON.stringify({ ...base, page, error: '当前不能查看 PDF 页图；可请学生发关键页截图。' });
          const url = await this.pdfImage(entry.content, page, signal);
          if (!url) return JSON.stringify({ ...base, page, error: 'PDF 页图渲染失败；可请学生发关键页截图。' });
          return image({ ...base, page }, url);
        }
        return JSON.stringify({ ...base, note: '二进制文件，可在工作台下载；需要内容时请学生发关键页截图。' });
      }
      if (name === 'read_quoted_message') {
        const quote = event && this.engine.store.quotedText(event);
        if (!quote) return JSON.stringify({ error: '当前没有可核对的引用原文；请提供题号或重新引用' });
        const { imageId, ...source } = quote;
        const png = imageId && vision ? this.engine.store.teachingImage(courseId, imageId) : undefined;
        const metadata = { ...source, text: quote.text.slice(0, 12000), truncated: quote.text.length > 12000,
          imageLoaded: !!png };
        return png ? image(metadata, 'data:image/png;base64,' + png.toString('base64')) : JSON.stringify(metadata);
      }
      if (name === 'read_qq_image') {
        if (!event || event.channel.kind === 'management' || (args.index !== undefined && !positiveInt(args.index)) ||
          (args.source !== undefined && args.source !== 'current' && args.source !== 'quoted')) throw new DomainError('invalid', '需要当前或引用图片及有效序号');
        const source = args.source === 'quoted' && event.quotedExternalId
          ? this.engine.store.eventByKey(`qq:${channelKey(event.channel)}:${event.quotedExternalId}`)
          : args.source === 'quoted' ? undefined : event;
        if (!source || source.courseId !== courseId || channelKey(source.channel) !== channelKey(event.channel) ||
          (args.source === 'quoted' && source.threadId !== event.threadId)) throw new DomainError('not_found', '本轮没有可读取的引用图片');
        const index = Number(args.index ?? 1);
        const item = source.attachments?.[index - 1];
        if (!item || item.kind !== 'image') return JSON.stringify({ error: '该序号无图片', attachments: describeAttachments(source) });
        if (!vision || !this.readAttachment) throw new DomainError('unavailable', '本轮不能读取 QQ 图片');
        const content = await this.readAttachment(source.channel, item, signal);
        const mediaType = qqImageType(content);
        if (!mediaType || mediaType === 'image/gif') throw new DomainError('invalid', '请将图片转成 PNG、JPEG 或 WebP 后再发');
        return image({ index, name: item.name }, `data:${mediaType};base64,${content.toString('base64')}`);
      }
      if (name === 'read_message') {
        if (typeof args.eventId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(args.eventId))
          throw new DomainError('invalid', '需要消息事件 ID');
        if (!this.authorized(run, args.eventId)) throw new DomainError('forbidden', '该消息不在本次任务可见范围');
        const source = this.engine.store.event(args.eventId)!;
        const text = source.text.slice(0, 12000);
        const ref = source.text.length > 12000 ? `evt:${source.id}:12000` : undefined;
        if (ref) run.readRefs = [...(run.readRefs ?? []), ref];
        const quoted = source.quotedExternalId
          ? this.engine.store.eventByKey(`qq:${channelKey(source.channel)}:${source.quotedExternalId}`) : undefined;
        return JSON.stringify({
          eventId: source.id, authorRole: source.actor.role, at: source.receivedAt,
          text, truncated: !!ref, ...(ref ? { ref } : {}),
          ...(quoted && quoted.courseId === run.course.id ? { quotedEventId: quoted.id } : {}),
          attachments: source.attachments?.map((item, index) => ({ index: index + 1, kind: item.kind, name: item.name })) ?? [],
        });
      }
      if (name === 'read_more') {
        if (typeof args.ref !== 'string' || !/^evt:[0-9a-f-]{36}:\d+$/i.test(args.ref)) throw new DomainError('invalid', '需要上下文中的 ref');
        if (!(run.readRefs ?? []).includes(args.ref)) throw new DomainError('forbidden', '该 ref 不是本轮上下文发出的');
        const [, id, offsetText] = args.ref.split(':');
        const offset = Number(offsetText);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new DomainError('invalid', 'ref 偏移无效');
        if (!this.authorized(run, id)) throw new DomainError('forbidden', '该消息不在本次任务可见范围');
        const source = this.engine.store.event(id)!;
        const end = offset + 8000;
        const text = source.text.slice(offset, end);
        const nextRef = source.text.length > end ? `evt:${id}:${end}` : undefined;
        if (nextRef) run.readRefs = [...(run.readRefs ?? []), nextRef];
        return JSON.stringify({ eventId: id, offset, text, nextRef });
      }
      if (name === 'lookup_textbook') {
        const bookIds = books(), term = query();
        const quoted = event && this.engine.store.quotedText(event);
        return JSON.stringify(this.references?.lookup(bookIds, term, quoted ? [quoted.text] : [])
          ?? { found: [], error: '教材编号索引不可用' });
      }
      if (name === 'search_textbook') {
        const bookIds = books(), term = query();
        const result = await this.knowledge?.search(bookIds, term, signal);
        if (result) run.knowledgeAnchors = [...new Set([...(run.knowledgeAnchors ?? []), ...result.hits.map(hit => hit.anchor)])].slice(0, 12);
        return JSON.stringify(result ?? { hits: [], error: '教材搜索不可用' });
      }
      if (name === 'textbook_section') {
        const id = args.sectionId;
        if (typeof id !== 'string' || !/^\d{1,3}\.\d{1,3}$/.test(id)) throw new DomainError('invalid', '请提供类似 17.2 的节号');
        const bookIds = books();
        const sections = this.references?.sections?.(bookIds, id) ?? [];
        return JSON.stringify({ sectionId: id, sections, ...(sections.length > 1 ? { ambiguous: true } : {}) });
      }
      const bookIds = books();
      if (typeof args.bookId !== 'string' || !positiveInt(args.page)) throw new DomainError('invalid', '缺少教材 ID 或有效页码');
      if (!vision || !this.pageReader) return JSON.stringify({ error: '本轮不能查看原页', bookId: args.bookId, page: args.page });
      try {
        const url = await this.pageReader(bookIds[0], args.page, signal);
        return image({ bookId: args.bookId, page: args.page, source: '原 PDF 物理页，供本轮核对' }, url);
      } catch {
        signal.throwIfAborted();
        return JSON.stringify({ error: '原 PDF 页图未加载；不可声称看过原页', bookId: args.bookId, page: args.page });
      }
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof DomainError) return JSON.stringify({ error: error.message });
      if (error instanceof SyntaxError) return JSON.stringify({ error: '工具参数不是完整 JSON' });
      throw error;
    }
  }
}
