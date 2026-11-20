import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain/model.ts';
import type { Channel, Course, Delivery, Event, Task } from '../domain/model.ts';
import type { Policy } from '../security/policy.ts';
import type { TaskEngine } from './task-engine.ts';

type Surface = NonNullable<Event['assistantSurface']>;
export const assistantChannel = 'course-assistant';
const trim = (value: string | undefined, max: number) => value && value.length > max ? value.slice(0, max) + '…' : value;
const parse = <T>(value: unknown) => JSON.parse(String(value)) as T;

export function managementConversationOwner(course: Course, policy: Policy) {
  const plans = course.weeklyTasks ?? (course.weeklyLesson ? [course.weeklyLesson] : []);
  const configured = [...new Set(plans.map(plan => 'qq:' + plan.teacherQQ).filter(id => policy.isTeacher(id)))];
  const known = configured.length ? configured : [...policy.teacherIds].filter(id => id.startsWith('qq:'));
  return known.length === 1 ? known[0] : 'web:admin';
}
export function conversationOwner(course: Course, policy: Policy, actorId: string, channel: Channel, surface?: Surface) {
  if (!policy.isTeacher(actorId)) return undefined;
  if (actorId === 'web:admin' && channel.kind === 'management' && channel.target === assistantChannel && surface)
    return managementConversationOwner(course, policy);
  if (channel.kind === 'qq-private' && actorId === 'qq:' + channel.target) return actorId;
}
export function teacherAssistantEvent(event: Event) {
  return event.actor.id === 'web:admin' && !!event.assistantSurface && !!event.conversationOwner &&
    event.channel.kind === 'management' && event.channel.target === assistantChannel;
}

export function teacherThread(event: Event) {
  return {
    actor: event.conversationOwner ?? event.actor.id,
    thread: event.conversationOwner ? 'teacher-assistant:' + event.conversationOwner : event.threadId,
  };
}
function summarize(engine: TaskEngine, event: Event) {
  const db = engine.store.db;
  const rows = db.prepare("SELECT data FROM deliveries WHERE json_extract(data,'$.replyEventId')=? AND status<>'withdrawn' ORDER BY rowid LIMIT 3").all(event.id);
  const sent = rows.map(row => parse<Delivery>(row.data).text).join('\n');
  const record = db.prepare("SELECT data FROM tasks WHERE json_extract(data,'$.grant.originEventId')=? AND status<>'superseded' ORDER BY rowid DESC LIMIT 1").get(event.id);
  const ownTask = record ? parse<Task>(record.data) : undefined;
  const relation = db.prepare('SELECT task_id FROM task_changes WHERE event_id=? ORDER BY revision DESC LIMIT 1').get(event.id);
  const task = relation ? engine.store.task(String(relation.task_id)) : ownTask;
  const reply = sent || (ownTask && (ownTask.kind === 'qa' || ownTask.kind === 'teaching-affairs') ? ownTask.result : undefined);
  const routing = db.prepare('SELECT routed,error FROM events WHERE id=?').get(event.id);
  return {
    eventId: event.id, at: event.receivedAt, surface: event.assistantSurface ?? 'qq' as const,
    text: trim(event.text, 1000) ?? '', reply: trim(reply, 1600),
    task: task && { id: task.id, kind: task.kind, revision: task.revision, status: task.status },
    error: trim(routing?.error ? String(routing.error) : ownTask?.error, 350),
    pending: !routing?.routed || !!task && ['queued', 'running', 'waiting_teacher'].includes(task.status),
  };
}
export function teacherHistory(engine: TaskEngine, courseId: string, owner: string, limit = 12, beforeEventId?: string) {
  const course = engine.store.course(courseId);
  if (!course || !engine.policy.isTeacher(owner)) return [];
  const row = beforeEventId && engine.store.db.prepare('SELECT rowid AS seq FROM events WHERE id=? AND course_id=?').get(beforeEventId, courseId);
  const db = engine.store.db;
  const rows = db.prepare("SELECT data FROM events WHERE course_id=? AND rowid<? AND " +
    "coalesce(json_extract(data,'$.receivedAt'),0)>=? AND " +
    "(json_extract(data,'$.conversationOwner')=? OR (json_extract(data,'$.conversationOwner') IS NULL " +
    "AND json_extract(data,'$.channel.kind')='qq-private' AND json_extract(data,'$.actor.id')=?)) " +
    "AND coalesce(json_extract(data,'$.dsh.kind'),'')<>'teacher.ask' AND json_extract(data,'$.teacherAnswerTo') IS NULL " +
    "ORDER BY rowid DESC LIMIT ?").all(courseId, row ? Number(row.seq) : Number.MAX_SAFE_INTEGER, course.teacherHistoryStartAt ?? 0, owner, owner, limit);
  return rows.reverse().map(item => summarize(engine, parse<Event>(item.data)));
}
export function contextForTeacher(engine: TaskEngine, event: Event | undefined) {
  if (!event?.conversationOwner || !engine.policy.isTeacher(event.actor.id)) return undefined;
  return teacherHistory(engine, event.courseId, event.conversationOwner, 5, event.id).map(turn => ({
    ...turn, text: trim(turn.text, 520), reply: trim(turn.reply, 650),
  }));
}
export class TeacherConversation {
  private engine: TaskEngine;
  constructor(engine: TaskEngine) { this.engine = engine; }
  private course(courseId: string) {
    const course = this.engine.store.course(courseId);
    if (!course) throw new DomainError('not_found', '课程不存在');
    return course;
  }
  history(courseId: string) {
    const owner = managementConversationOwner(this.course(courseId), this.engine.policy);
    return { sharesQQ: owner !== 'web:admin', turns: teacherHistory(this.engine, courseId, owner, 30) };
  }
  send(courseId: string, surface: Surface, text: string, requestId: string) {
    const course = this.course(courseId);
    if (text.length > 6000 || !text.trim() || !/^[a-zA-Z0-9-]{16,80}$/.test(requestId))
      throw new DomainError('invalid', '消息或请求编号无效');
    const key = 'teacher-assistant:' + courseId + ':' + surface + ':' + requestId;
    const owner = managementConversationOwner(course, this.engine.policy);
    const { event } = this.engine.receive({ courseId, sourceKey: key, externalId: key, actorId: 'web:admin',
      threadId: randomUUID(), channel: { kind: 'management', target: assistantChannel },
      receivedAt: this.engine.now(), text, assistantSurface: surface });
    if (event.text !== text || event.conversationOwner !== owner) throw new DomainError('conflict', '该消息编号已用于另一条消息');
    return summarize(this.engine, event);
  }
  turn(courseId: string, eventId: string) {
    const owner = managementConversationOwner(this.course(courseId), this.engine.policy);
    const event = this.engine.store.event(eventId);
    if (!event || event.courseId !== courseId || event.conversationOwner !== owner ||
        !(teacherAssistantEvent(event) || event.actor.id === owner && event.channel.kind === 'qq-private'))
      throw new DomainError('not_found', '找不到本课程对话');
    return summarize(this.engine, event);
  }
}
