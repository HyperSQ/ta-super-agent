import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { DomainError } from '../../domain/model.ts';
import type { Event } from '../../domain/model.ts';
import type { TaskEngine } from '../task-engine.ts';
import { currentActivity } from '../activities.ts';
import { Academics } from './academics.ts';
import { classContext } from './class-context.ts';
import { mathImage } from '../../adapters/qq/math-image.ts';
import { describeAttachments, qqImageType } from '../../adapters/qq/attachments.ts';
import type { QQAttachmentReader } from '../../adapters/qq/attachments.ts';
import { askTeacher } from './teacher-inquiry.ts';
import { appliedTaskRevision, findMaterialTasks, materialTaskMemory, requireMaterialTask } from '../task-memory.ts';
import { TeacherConversation } from '../teacher-conversation.ts';

type GroupPreview = { courseId: string; groupId: string; text: string; imageId?: string; fileId?: string; assignmentId?: string; revision?: number };
export const maxHandoutBytes = 10 * 1024 * 1024;
const groupFileExtensions = ['pdf', 'docx', 'md', 'txt', 'zip'];

function assignmentAnnouncement(engine: TaskEngine, courseId: string, assignmentId: string) {
  const course = engine.store.course(courseId);
  if (!course?.groupId) throw new DomainError('invalid', '课程未绑定 QQ 群');
  const assignment = new Academics(engine).assignment(assignmentId);
  if (assignment.courseId !== courseId) throw new DomainError('not_found', '本课程没有该作业');
  if (assignment.studentVisible !== true) throw new DomainError('forbidden', '请先将作业设为学生可见');
  const attachments = (assignment.images?.length ?? 0) ? '\n题图可在群内 @ 助教并询问这份作业。' : '';
  const text = [`【${course.title}】${assignment.title}`, `截止 ${assignment.deadline}`, assignment.instructions, attachments].filter(Boolean).join('\n');
  return { groupId: course.groupId, revision: assignment.revision, text };
}

export function routeDSH(engine: TaskEngine, event: Event): void {
  if (!event.dsh || event.dsh.kind === 'teacher.ask' || event.actor.id !== 'web:admin') throw new DomainError('forbidden', '来源无助教桥接权限');
  if (event.dsh.kind === 'question') {
    if (event.channel.kind !== 'management') throw new DomainError('forbidden', 'DSH 请求渠道无效');
    engine.createTask(event.id, 'qa', event.text);
    return;
  }
  const command = event.dsh;
  if (command.kind === 'group.send') {
    engine.store.atomic(() => {
      if (event.channel.kind !== 'qq-group' || event.channel.target !== command.groupId ||
        (command.imageId && !engine.store.teachingImage(event.courseId, command.imageId)) ||
        (command.fileId && !engine.store.teachingFile(event.courseId, command.fileId))) throw new DomainError('stale', '目标群或发送附件已变化');
      const task = engine.createTask(event.id, 'qa', '教师群发');
      const run = engine.claim(task.id);
      if (!run) throw new DomainError('conflict', '群发任务无法领取');
      engine.finish(run, command.imageId ? { action: 'send', format: 'latex', content: event.text } : { action: 'send', format: 'text', content: [event.text] });
    });
    return;
  }
  engine.store.atomic(() => {
    const preview = assignmentAnnouncement(engine, event.courseId, command.assignmentId);
    if (preview.revision !== command.revision || preview.groupId !== command.groupId || preview.text !== event.text
      || event.channel.kind !== 'qq-group' || event.channel.target !== command.groupId) {
      throw new DomainError('stale', '作业或目标群已变更，请重新预览确认');
    }
    const task = engine.createTask(event.id, 'qa', '派发作业');
    const run = engine.claim(task.id);
    if (!run) throw new DomainError('conflict', '派发任务无法领取');
    run.assignmentReads = [{ id: command.assignmentId, revision: command.revision }];
    engine.finish(run, { action: 'send', format: 'text', content: [preview.text] });
    currentActivity('assignment.queued', '作业通知已进入交付队列', { taskId: task.id, assignmentId: command.assignmentId, groupId: command.groupId });
  });
}

export class DSH {
  private engine: TaskEngine;
  private secret: string;
  private readAttachment?: QQAttachmentReader;
  constructor(engine: TaskEngine, secret: string, readAttachment?: QQAttachmentReader) {
    this.engine = engine; this.secret = secret; this.readAttachment = readAttachment;
  }
  private sign(encoded: string): Buffer {
    return createHmac('sha256', this.secret).update('ta-dsh-announcement:').update(encoded).digest();
  }
  private course(courseId: string) {
    const course = this.engine.store.course(courseId);
    if (!course) throw new DomainError('not_found', '课程不存在');
    return course;
  }
  courses() {
    return this.engine.store.courses().map(({ id, title, groupId }) => ({ id, title, groupId }));
  }
  taskMemory(courseId: string, query: string, taskId: string) {
    this.course(courseId);
    if (query.length > 200) throw new DomainError('invalid', '任务关键词最多 200 字');
    return taskId ? { task: materialTaskMemory(this.engine.store, requireMaterialTask(this.engine.store, courseId, taskId)) }
      : { candidates: findMaterialTasks(this.engine.store, courseId, query) };
  }
  reviseTask(courseId: string, taskId: string, revision: number, goal: string, requestId: string) {
    this.course(courseId);
    const task = requireMaterialTask(this.engine.store, courseId, taskId);
    if (!/^[a-f0-9]{64}$/.test(requestId)) throw new DomainError('invalid', '请求编号无效');
    const key = 'dsh:task-revision:' + courseId + ':' + requestId, input = JSON.stringify({ taskId, revision, goal });
    return this.engine.store.atomic(() => {
      const { event } = this.engine.receive({ sourceKey: key, externalId: key, threadId: key, courseId, actorId: 'web:admin',
        channel: { kind: 'management', target: 'dsh' }, text: input, receivedAt: this.engine.now() }, true);
      if (event.text !== input) throw new DomainError('conflict', '此请求编号已用于其他修改');
      const applied = appliedTaskRevision(this.engine.store, task.id, event.id);
      const latest = applied ? this.engine.store.task(task.id)! : this.engine.control(event.id, task.id, 'revise', revision, goal);
      return { eventId: event.id, appliedRevision: applied ?? latest.revision, task: materialTaskMemory(this.engine.store, latest) };
    });
  }
  assignments(courseId: string) {
    if (!this.engine.store.course(courseId)) throw new DomainError('not_found', '课程不存在');
    return this.engine.store.db.prepare(`SELECT json_remove(data,'$.images') AS data, coalesce(json_array_length(data,'$.images'),0) AS imageCount
      FROM coursework_assignments WHERE course_id=? ORDER BY rowid`).all(courseId).map(row => {
      const { id, title, instructions, deadline, revision, studentVisible, gradingPolicy } = JSON.parse(String(row.data));
      return { id, title, instructions, deadline, revision, studentVisible, gradingPolicy, imageCount: Number(row.imageCount) };
    });
  }
  assignment(courseId: string, assignmentId: string, attachment?: number) {
    const assignment = new Academics(this.engine).assignment(assignmentId);
    if (assignment.courseId !== courseId) throw new DomainError('not_found', '作业不属于本课程');
    const { images = [], ...data } = assignment;
    const attachments = images.map(({ name }, index) => ({ index: index + 1, name }));
    if (attachment === undefined) return { data: { ...data, attachments } };
    const selected = images[attachment - 1];
    if (!selected) throw new DomainError('not_found', '这份作业没有该编号的题图');
    return { data: { ...data, attachments, loadedAttachment: attachment }, image: selected };
  }
  writeAssignment(courseId: string, requestId: string, input: Parameters<Academics['saveAssignment']>[1]) {
    const payload = JSON.stringify(input);
    return this.engine.store.atomic(() => {
      const db = this.engine.store.db;
      const old = db.prepare('SELECT payload,result FROM dsh_writes WHERE request_id=?').get(requestId);
      if (old) {
        if (old.payload !== payload) throw new DomainError('conflict', '此请求编号已用于其他操作');
        return JSON.parse(String(old.result));
      }
      const academics = new Academics(this.engine);
      if (input.id && academics.assignment(input.id).courseId !== courseId) throw new DomainError('not_found', '该作业不属于本课程');
      const result = academics.saveAssignment('web:admin', { ...input, courseId });
      const summary = { id: result.id, courseId, title: result.title, revision: result.revision, studentVisible: result.studentVisible };
      db.prepare('INSERT INTO dsh_writes VALUES(?,?,?)').run(requestId, payload, JSON.stringify(summary));
      return summary;
    });
  }
  registerScores(courseId: string, assignmentId: string, students: Parameters<Academics['register']>[2]) {
    const academics = new Academics(this.engine);
    if (academics.assignment(assignmentId).courseId !== courseId) throw new DomainError('not_found', '该作业不属于本课程');
    const names = new Set(this.course(courseId).roster ?? []);
    if (students.some(student => !names.has(student.name.trim()))) throw new DomainError('invalid', '只能为课程名单中的学生登记');
    return academics.register('web:admin', assignmentId, students);
  }
  messages(courseId: string, options: { teacher: boolean; before?: number; messageId?: string }) {
    const course = this.course(courseId);
    const db = this.engine.store.db;
    const limit = options.messageId ? 1 : 24;
    const rows = db.prepare(`SELECT rowid AS cursor,data FROM events WHERE course_id=? AND rowid<?
      AND (json_extract(data,'$.externalId')=? OR ? IS NULL)
      AND json_extract(data,'$.dsh') IS NULL
      AND ((json_extract(data,'$.channel.kind')='qq-group' AND json_extract(data,'$.channel.target')=?)
        OR (?=1 AND json_extract(data,'$.channel.kind')='qq-private' AND json_extract(data,'$.actor.role')='teacher'))
      AND (?=0 OR json_extract(data,'$.actor.role')='teacher')
      ORDER BY rowid DESC LIMIT ?`).all(courseId, options.before ?? Number.MAX_SAFE_INTEGER, options.messageId ?? null, options.messageId ?? null,
        course.groupId ?? '', Number(options.teacher), Number(options.teacher), limit);
    const messages = rows.map(row => {
      const e = JSON.parse(String(row.data)) as Event;
      return { eventId: e.id, messageId: e.externalId, sender: e.actor, channel: e.channel.kind, at: e.receivedAt,
        text: e.text.slice(0, 2500), ...(e.attachments?.length ? { attachments: describeAttachments(e) } : {}) };
    });
    const replies = db.prepare(`SELECT d.data,m.image_id FROM deliveries d JOIN tasks t ON t.id=d.task_id
      JOIN events e ON e.id=json_extract(d.data,'$.replyEventId') LEFT JOIN teaching_replies m ON d.id=m.delivery_id
      WHERE t.course_id=? AND d.status='sent' AND (json_extract(d.data,'$.externalId')=? OR ? IS NULL)
      AND ((json_extract(d.data,'$.channel.kind')='qq-group' AND json_extract(d.data,'$.channel.target')=?)
        OR (?=1 AND json_extract(d.data,'$.channel.kind')='qq-private' AND json_extract(e.data,'$.actor.role')='teacher'))
      AND (?=0 OR json_extract(e.data,'$.actor.role')='teacher') ORDER BY d.rowid DESC LIMIT ?`)
      .all(courseId, options.messageId ?? null, options.messageId ?? null, course.groupId ?? '', Number(options.teacher), Number(options.teacher), limit)
      .map(row => {
        const d = JSON.parse(String(row.data)) as import('../../domain/model.ts').Delivery;
        return { messageId: d.externalId, channel: d.channel.kind, at: d.sentAt, source: d.text.slice(0, 8000), imageId: row.image_id ?? undefined, format: d.format };
      });
    return { messages, replies: options.before ? [] : replies, nextBefore: rows.length === limit && !options.messageId ? Number(rows.at(-1)?.cursor) : undefined };
  }
  brief(courseId: string) {
    const { course, group, assignments } = classContext(this.engine, courseId, { days: 7 });
    const conversation = new TeacherConversation(this.engine).history(courseId);
    const recent = conversation.turns.slice(-5).map(turn => ({ ...turn, text: turn.text.slice(0, 520), reply: turn.reply?.slice(0, 650) }));
    return { course, recordedStudentMessages: group.messageCount, recent: group.recentMessages.slice(0, 5),
      teacherConversation: { sharesQQ: conversation.sharesQQ, recent },
      learningNotes: group.learningNotes.slice(0, 4).map(note => ({ topics: note.topics, observation: note.observation.slice(0, 280), sourceEventIds: note.sourceEventIds })),
      assignments: assignments.slice(0, 4).map(assignment => ({ id: assignment.id, title: assignment.title, deadline: assignment.deadline })) };
  }
  async attachment(courseId: string, eventId: string, index: number, signal?: AbortSignal) {
    const course = this.course(courseId);
    const event = this.engine.store.event(eventId);
    const visible = event?.channel.kind === 'qq-group' ? event.channel.target === course.groupId
      : event?.channel.kind === 'qq-private' && event.channel.target === event.actor.id.slice(3) && this.engine.policy.isTeacher(event.actor.id);
    if (!event || event.courseId !== courseId || !visible) throw new DomainError('not_found', '本课可见消息中找不到该附件');
    const file = event.attachments?.[index - 1];
    if (!file) throw new DomainError('not_found', '找不到该序号的附件');
    if (!this.readAttachment) throw new DomainError('unavailable', '未配置 QQ 附件读取');
    const content = await this.readAttachment(event.channel, file, signal);
    if (event.channel.kind === 'qq-group' && this.engine.store.course(courseId)?.groupId !== event.channel.target)
      throw new DomainError('stale', '课程绑定群已变更');
    const imageType = file.kind === 'image' ? qqImageType(content) : undefined;
    const name = imageType && !/\.[a-z]{2,4}$/i.test(file.name) ? file.name + '.' + imageType.split('/')[1] : file.name;
    return { name, kind: file.kind, bytes: content.length, mediaType: imageType ?? 'application/octet-stream', base64: content.toString('base64') };
  }
  ask(courseId: string, question: string, requestId: string) {
    return this.status(askTeacher(this.engine, courseId, question, requestId).id);
  }
  async render(courseId: string, text: string, preview = false) {
    this.course(courseId);
    const socket = process.env.TA_MATH_SOCKET;
    if (!socket) throw new DomainError('unavailable', '服务器未配置公式渲染');
    const id = randomUUID();
    const png = await mathImage(socket, text).catch(() => { throw new DomainError('render_failed', '渲染失败，未生成图片'); });
    this.engine.store.saveTeachingImage(id, courseId, png, text);
    return { imageId: id, bytes: png.length, ...(preview ? { png: png.toString('base64') } : {}) };
  }
  groupPreview(courseId: string, text: string, imageId?: string) {
    const { groupId } = this.course(courseId);
    if (!groupId) throw new DomainError('invalid', '课程未绑定 QQ 群');
    if (imageId) {
      const image = this.engine.store.db.prepare('SELECT source FROM teaching_images WHERE id=? AND course_id=?').get(imageId, courseId);
      if (!image) throw new DomainError('not_found', '找不到本课程的渲染图');
      if (image.source !== text) throw new DomainError('invalid', '图片与确认原稿不一致，请使用当时渲染的原稿');
    }
    return this.signedPreview({ courseId, groupId, text, imageId });
  }
  question(courseId: string, text: string, requestId: string) {
    const key = `dsh:question:${courseId}:${requestId}`;
    const { event } = this.engine.receive({ sourceKey: key, courseId, threadId: randomUUID(), actorId: 'web:admin',
      channel: { kind: 'management', target: 'dsh' }, externalId: randomUUID(), receivedAt: Date.now(), text, dsh: { kind: 'question' } });
    if (event.text !== text) throw new DomainError('conflict', '此请求编号已用于其他内容');
    return this.status(event.id);
  }
  groupFileOptions(courseId: string) {
    const { groupId, title } = this.course(courseId);
    if (!groupId) throw new DomainError('invalid', '课程未绑定 QQ 群');
    return { groupId, title, extensions: groupFileExtensions, maxBytes: maxHandoutBytes };
  }
  groupFile(courseId: string, expectedGroup: string, name: string, content: Buffer, fileId: string) {
    const { groupId } = this.course(courseId);
    const sourceKey = 'dsh:announcement:file:' + fileId;
    const existing = this.engine.store.eventByKey(sourceKey);
    if (existing) {
      if (existing.courseId !== courseId || existing.channel.target !== expectedGroup || existing.text !== name)
        throw new DomainError('conflict', '此发送编号已用于其他文件');
      return this.status(existing.id);
    }
    if (!groupId || groupId !== expectedGroup) throw new DomainError('stale', '课程绑定群已变化，请重新确认');
    const extension = /^[^/\\:\u0000-\u001f]+\.([a-z]+)$/i.exec(name)?.[1].toLowerCase();
    if (name.length > 180 || !extension || !groupFileExtensions.includes(extension)) throw new DomainError('invalid', '不支持的群文件名或格式');
    if (!content.length || content.length > maxHandoutBytes) throw new DomainError('invalid', '群文件须大于 0 字节且不超过 10 MiB');
    return this.engine.store.atomic(() => {
      this.engine.store.db.prepare('INSERT INTO teaching_files VALUES(?,?,?,?)').run(fileId, courseId, name, content);
      return this.confirm(this.signedPreview({ courseId, groupId, text: name, fileId }, 'file:' + fileId).confirmation);
    });
  }
  preview(courseId: string, assignmentId: string) {
    const preview = assignmentAnnouncement(this.engine, courseId, assignmentId);
    return this.signedPreview({ courseId, assignmentId, ...preview });
  }
  private signedPreview(preview: GroupPreview, id: string = randomUUID()) {
    const encoded = Buffer.from(JSON.stringify({ ...preview, expires: Date.now() + 5 * 60_000, id })).toString('base64url');
    return { ...preview, confirmation: encoded + '.' + this.sign(encoded).toString('base64url') };
  }
  confirm(confirmation: string) {
    const [encoded, signature, extra] = confirmation.split('.');
    if (!encoded || !signature || extra !== undefined || !/^[A-Za-z0-9_-]{43}$/.test(signature)
      || !timingSafeEqual(Buffer.from(signature, 'base64url'), this.sign(encoded))) throw new DomainError('invalid', '派发凭据无效');
    const command = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as GroupPreview & { expires: number; id: string };
    const sourceKey = `dsh:announcement:${command.id}`;
    const existing = this.engine.store.eventByKey(sourceKey);
    if (existing) return this.status(existing.id);
    if (command.expires < Date.now()) throw new DomainError('stale', '确认已过期，请重新预览');
    const { event } = this.engine.receive({ sourceKey, courseId: command.courseId, threadId: randomUUID(), actorId: 'web:admin',
      channel: { kind: 'qq-group', target: command.groupId }, externalId: randomUUID(), receivedAt: Date.now(), text: command.text,
      dsh: command.assignmentId && command.revision ? { kind: 'assignment.announce', assignmentId: command.assignmentId, revision: command.revision, groupId: command.groupId }
        : { kind: 'group.send', groupId: command.groupId, imageId: command.imageId, fileId: command.fileId } });
    return this.status(event.id);
  }
  status(eventId: string) {
    const event = this.engine.store.event(eventId);
    if (!event?.dsh) throw new DomainError('not_found', 'DSH 请求不存在');
    const routing = this.engine.store.db.prepare('SELECT error FROM events WHERE id=?').get(eventId);
    const task = this.engine.store.tasks().find(item => item.grant.originEventId === eventId);
    const delivery = task && this.engine.store.deliveries().find(item => item.taskId === task.id);
    const answer = event.dsh.kind === 'teacher.ask' && this.engine.store.db.prepare(`SELECT data FROM events WHERE course_id=?
      AND json_extract(data,'$.teacherAnswerTo')=? ORDER BY rowid DESC LIMIT 1`).get(event.courseId, event.id);
    const response = answer ? JSON.parse(String(answer.data)) as Event : undefined;
    return { eventId, courseId: event.courseId, status: response ? 'answered' : routing?.error ? 'failed' : delivery?.status ?? task?.status ?? 'routing',
      ...(response ? { answer: { eventId: response.id, text: response.text, receivedAt: response.receivedAt, attachments: describeAttachments(response) } } : {}),
      ...(event.dsh.kind === 'question' && task?.result ? { result: task.result } : {}),
      error: routing?.error ?? delivery?.error ?? task?.error ?? undefined, externalId: delivery?.externalId, externalFileId: delivery?.externalFileId };
  }
}
