import { randomUUID } from 'node:crypto';
import { DomainError, channelKey } from '../../domain/model.ts';
import type { Course, Delivery, Event, Run } from '../../domain/model.ts';
import type { GroupMembership, QQSendGuard, RunGuard } from '../../ports/qq-access.ts';
import { receiveQQ, validateQQ } from '../../adapters/qq/llbot.ts';
import type { QQMessage } from '../../adapters/qq/llbot.ts';
import type { TaskEngine } from '../task-engine.ts';
import { Roster, parseRosterFile, rosterFileLimit } from './roster.ts';
import { qqAttachments } from '../../adapters/qq/attachments.ts';
import { inquiryForReply, teacherContact } from './teacher-inquiry.ts';

/** Course scope comes from program state and live group membership, never from the model. */
export class QQAccess implements QQSendGuard, RunGuard {
  engine: TaskEngine; membership?: GroupMembership;
  private loadRosterFile?: (fileId: string) => Promise<Buffer>;
  constructor(engine: TaskEngine, membership?: GroupMembership, loadRosterFile?: (fileId: string) => Promise<Buffer>) {
    this.engine = engine; this.membership = membership; this.loadRosterFile = loadRosterFile;
  }
  private async courseMember(courseId: string, userId: string, signal?: AbortSignal): Promise<Course> {
    const course = this.engine.store.course(courseId);
    if (!course) throw new DomainError('not_found', '课程不存在');
    if (this.engine.policy.isTeacher('qq:' + userId)) return course;
    if (!course.groupId) throw new DomainError('forbidden', '该课程尚未绑定群');
    if (!this.membership) throw new DomainError('unavailable', '课程群成员校验尚未配置');
    const groupId = course.groupId;
    const allowed = await this.membership.isMember(groupId, userId, signal);
    const current = this.engine.store.course(courseId);
    if (!current || current.groupId !== groupId) throw new DomainError('stale', '校验期间课程群已变化，请重试');
    if (!allowed) throw new DomainError('forbidden', '发信者不是该课程群当前成员');
    return current;
  }
  private async eligible(userId: string): Promise<Course[]> {
    const courses = this.engine.store.courses(), result: Course[] = [];
    for (let i = 0; i < courses.length; i += 4) {
      const batch = await Promise.all(courses.slice(i, i + 4).map(async course => {
        try { return await this.courseMember(course.id, userId); }
        catch (error) { if (error instanceof DomainError && error.code === 'forbidden') return undefined; throw error; }
      }));
      result.push(...batch.filter((course): course is Course => !!course));
    }
    return result;
  }
  async receive(raw: QQMessage, suppliedCourseId?: string) {
    validateQQ(raw);
    if (String(raw.user_id) === String(raw.self_id)) return { ignored: true };
    if (raw.message_type === 'group') return receiveQQ(this.engine, raw);
    const userId = String(raw.user_id), actorId = 'qq:' + userId;
    const text = raw.message.filter(s => s.type === 'text').map(s => String(s.data.text ?? '')).join('').trim();
    const attachments = qqAttachments(raw.message);
    const importRequested = /(?:^|\n)(?:\/roster import|(?:请)?导入(?:学生|课程)?名单)[。！]?$/iu.test(text);
    const files = this.engine.policy.isTeacher(actorId) ? raw.message.filter(segment => {
      const name = String(segment.data.file_name ?? segment.data.file ?? '');
      return segment.type === 'file' && /\.(xlsx|csv|tsv|txt)$/i.test(name) && (importRequested || /名单|roster/i.test(name));
    }) : [];
    if (!text && !files.length && !attachments.length) return { ignored: true };
    const sourceKey = 'qq:qq-private:' + userId + ':' + raw.message_id;
    const duplicate = this.engine.store.eventByKey(sourceKey);
    if (duplicate) {
      if (suppliedCourseId && suppliedCourseId !== duplicate.courseId) throw new DomainError('forbidden', '重复消息不属于接入课程');
      await this.courseMember(duplicate.courseId, userId);
      return { event: duplicate, duplicate: true, subscribed: true };
    }
    const command = /^\/course(?:\s+([^\s]+))?(?:\s+([\s\S]*))?$/.exec(text);
    if (suppliedCourseId && command?.[1] && suppliedCourseId !== command[1]) throw new DomainError('forbidden', '选课指令与接入课程范围不一致');
    const channel = { kind: 'qq-private' as const, target: userId };
    const quote = raw.message.find(s => s.type === 'reply')?.data.id;
    const question = quote !== undefined ? inquiryForReply(this.engine, userId, String(quote)) : undefined;
    if (question) {
      if ((suppliedCourseId && suppliedCourseId !== question.courseId) || (command?.[1] && command[1] !== question.courseId))
        throw new DomainError('forbidden', '教师回复不属于指定课程');
      return this.engine.store.atomic(() => {
        const received = this.engine.receive({ sourceKey, courseId: question.courseId, actorId, channel,
        threadId: question.threadId, text: command?.[2]?.trim() || text || '[QQ 附件]', teacherAnswerTo: question.id,
        externalId: String(raw.message_id), receivedAt: this.engine.now(), attachments }, true);
        this.engine.recordTeacherAnswer(question, received.event);
        return received;
      });
    }
    const linked = quote === undefined ? undefined : this.engine.store.threadForReply(channelKey(channel), String(quote));
    const referenced = linked ? this.engine.store.subscribers(linked).filter(t => t.grant.purpose !== 'course-selection' && t.grant.channel?.kind === 'qq-private' && t.grant.channel.target === userId) : [];
    const referencedCourses = [...new Set(referenced.map(t => t.courseId))];
    const selectedId = command?.[1] || suppliedCourseId || (referencedCourses.length === 1 ? referencedCourses[0] : undefined);
    let courses: Course[], course: Course | undefined;
    if (selectedId) {
      course = await this.courseMember(selectedId, userId);
      courses = [course];
    } else {
      courses = await this.eligible(userId);
      if (!courses.length) return { ignored: true, reason: 'not-course-member' };
      const context = this.engine.store.db.prepare('SELECT course_id FROM qq_private_contexts WHERE user_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 1').get(userId);
      course = command ? undefined : courses.find(c => c.id === String(context?.course_id));
      if (!course && !context && courses.length === 1 && !command) course = courses[0];
    }
    // An explicit source scope cannot be overridden by a message claiming another course.
    if (suppliedCourseId && course && suppliedCourseId !== course.id) throw new DomainError('forbidden', '选课指令与接入课程范围不一致');
    if (!course) {
      const owner = courses[0];
      if (!owner) return { ignored: true, reason: 'no-course' };
      return this.notice(raw, owner, text, '请选择本次私信的课程：\n' + courses.map(c => c.title + '：/course ' + c.id).join('\n') + '\n发送对应选课指令后即可提问；也可在指令下一行附上问题。');
    }
    // Recheck the course snapshot after the asynchronous membership lookup.
    if (this.engine.store.course(course.id)?.groupId !== course.groupId) throw new DomainError('stale', '课程群已变化');
    const context = this.engine.store.db.prepare('SELECT thread_id FROM qq_private_contexts WHERE user_id=? AND course_id=?').get(userId, course.id);
    const linkedHere = referenced.some(t => t.courseId === course!.id) ? linked : undefined;
    const threadId = linkedHere ?? (context ? String(context.thread_id) : randomUUID());
    const latest = this.engine.store.db.prepare('SELECT MAX(updated_at) AS at FROM qq_private_contexts WHERE user_id=?').get(userId);
    const at = Math.max(Date.now(), Number(latest?.at ?? 0) + 1);
    this.engine.store.db.prepare('INSERT INTO qq_private_contexts(user_id,course_id,thread_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,course_id) DO UPDATE SET thread_id=excluded.thread_id,updated_at=excluded.updated_at')
      .run(userId, course.id, threadId, at);
    if (files.length) {
      const courseId = course.id;
      let reply: string, names: string[] | undefined;
      try {
        if (files.length !== 1) throw new DomainError('invalid', '请每次发送一个名单文件');
        const { file_id, file_name, file, file_size } = files[0].data;
        if (!this.loadRosterFile || typeof file_id !== 'string' || !file_id || file_id.length > 1000) throw new DomainError('unavailable', '没有可读取的 QQ 附件编号');
        if (Number(file_size) > rosterFileLimit) throw new DomainError('invalid', '名单文件须在 2 MiB 以内');
        const filename = String(file_name ?? file);
        names = parseRosterFile(filename, await this.loadRosterFile(file_id), importRequested || /名单|roster/i.test(filename));
        reply = '';
      } catch (error) { reply = error instanceof DomainError ? error.message : '名单附件读取失败，请重新发送或上传 UTF-8 CSV'; }
      return this.engine.store.atomic(() => {
        const result = this.engine.receive({ sourceKey, courseId, threadId: randomUUID(), actorId, text: '教师上传名单表',
          channel, externalId: String(raw.message_id), receivedAt: Date.now() });
        if (!result.duplicate) {
          if (names) {
            try {
              const imported = new Roster(this.engine).add(actorId, courseId, names);
              reply = `已向「${course!.title}」追加 ${imported.added} 人，名单共 ${imported.total} 人。`;
            } catch (error) { if (!(error instanceof DomainError)) throw error; reply = error.message; }
          }
          this.engine.replyToTeacher(result.event, reply);
        }
        return result;
      });
    }
    if (command?.[1] && !command[2]?.trim()) return this.notice(raw, course, text, '已选择课程“' + course.title + '”，请直接发送问题。其他课程可用 /course 课程ID 切换。');
    this.clearNotices(userId);
    const content = command?.[2]?.trim() || text || '[QQ 附件]';
    const coursework = !this.engine.policy.isTeacher(actorId) &&
      /^\/(?:extension|assignments|申请延期)(?:\s|$)/iu.test(content);
    return this.engine.receive({ sourceKey, courseId: course.id, threadId: coursework ? JSON.stringify(['coursework',course.id,actorId]) : threadId, actorId, text: content, quoted: !coursework && !!linkedHere,
      ...(attachments.length ? { attachments } : {}),
      quotedExternalId: !coursework && linkedHere ? String(quote) : undefined,
      channel, externalId: String(raw.message_id), receivedAt: Date.now() }, !coursework && !text && !linkedHere);
  }
  private clearNotices(userId: string): void {
    for (const task of this.engine.store.tasks()) {
      if (task.grant.purpose !== 'course-selection' || task.grant.channel?.kind !== 'qq-private' || task.grant.channel.target !== userId) continue;
      for (const delivery of this.engine.store.deliveries()) if (delivery.taskId === task.id && delivery.status === 'pending') {
        delivery.status = 'withdrawn'; this.engine.store.saveDelivery(delivery);
      }
    }
  }
  private notice(raw: QQMessage, course: Course, text: string, reply: string) {
    this.clearNotices(String(raw.user_id));
    const { event } = this.engine.receive({ sourceKey: 'qq:qq-private:' + raw.user_id + ':' + raw.message_id,
      courseId: course.id, threadId: randomUUID(), actorId: 'qq:' + raw.user_id, text,
      channel: { kind: 'qq-private', target: String(raw.user_id) }, externalId: String(raw.message_id), receivedAt: Date.now() });
    const task = this.engine.createTask(event.id, 'qa', text, 'course-selection');
    const run = this.engine.claim(task.id);
    if (run) this.engine.finish(run, reply);
    return { event, duplicate: false, subscribed: false, courseSelection: true };
  }
  async authorizeRun(run: Run, signal: AbortSignal): Promise<void> {
    const current = this.engine.store.task(run.task.id);
    if (!current) throw new DomainError('not_found', '任务不存在');
    this.engine.assertTaskScope(current);
    const channel = current.grant.channel!;
    if (channel.kind === 'qq-private') await this.courseMember(current.courseId, channel.target, signal);
    signal.throwIfAborted();
    const refreshed = this.engine.store.task(current.id)!;
    this.engine.assertTaskScope(refreshed);
    if (refreshed.revision !== run.revision || refreshed.inputEpoch !== run.inputEpoch) throw new DomainError('stale', '成员校验期间任务已修改');
  }
  async authorizeDelivery(delivery: Delivery, event: Event): Promise<void> {
    this.assertDeliveryTarget(delivery, event);
    const courseId = this.engine.store.task(delivery.taskId)!.courseId;
    if (delivery.channel.kind === 'qq-private') await this.courseMember(courseId, delivery.channel.target);
    this.assertDeliveryTarget(delivery, event);
  }
  assertDeliveryTarget(delivery: Delivery, event: Event): void {
    this.engine.assertDeliveryTarget(delivery, event);
    if (event.dsh?.kind === 'teacher.ask') {
      const course = this.engine.store.course(event.courseId);
      if (!course || teacherContact(this.engine, course) !== delivery.channel.target)
        throw new DomainError('forbidden', '课程教师联系人已变更');
    }
  }
}
