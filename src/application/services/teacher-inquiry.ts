import { randomUUID } from 'node:crypto';
import { DomainError } from '../../domain/model.ts';
import type { Event } from '../../domain/model.ts';
import type { Course } from '../../domain/model.ts';
import type { TaskEngine } from '../task-engine.ts';
import { weeklyTasks } from '../weekly-lesson.ts';

export function teacherContact(engine: TaskEngine, course: Course) {
  const teachers = [...new Set(weeklyTasks(course).map(task => task.teacherQQ)
    .filter((id): id is string => !!id && engine.policy.isTeacher('qq:' + id)))];
  return teachers.length === 1 ? teachers[0] : undefined;
}

export function askTeacher(engine: TaskEngine, courseId: string, question: string, requestId: string): Event {
  return engine.store.atomic(() => {
    const course = engine.store.course(courseId);
    if (!course) throw new DomainError('not_found', '课程不存在');
    const key = `dsh:teacher-ask:${courseId}:${requestId}`;
    const prior = engine.store.eventByKey(key);
    if (prior) {
      if (prior.text !== question) throw new DomainError('conflict', '此请求编号已用于另一条询问');
      return prior;
    }
    const target = teacherContact(engine, course);
    if (!target) throw new DomainError('invalid', '请在课程定时任务中配置唯一已授权的联系人 QQ');
    const { event } = engine.receive({ sourceKey: key, courseId, threadId: randomUUID(), actorId: 'qq:' + target,
      channel: { kind: 'qq-private', target }, text: question, externalId: key, receivedAt: engine.now(), dsh: { kind: 'teacher.ask' } });
    engine.replyToTeacher(event, `「${course.title}」助教需要确认：\n${question}\n请引用这条消息回复。`, 'text');
    return event;
  });
}

export function inquiryForReply(engine: TaskEngine, teacher: string, quoted: string): Event | undefined {
  if (!engine.policy.isTeacher('qq:' + teacher)) return;
  const row = engine.store.db.prepare(`SELECT e.id FROM deliveries d
    JOIN events e ON e.id=json_extract(d.data,'$.replyEventId')
    WHERE d.status='sent' AND json_extract(d.data,'$.externalId')=?
    AND json_extract(e.data,'$.dsh.kind')='teacher.ask' AND json_extract(e.data,'$.channel.target')=? LIMIT 1`).get(quoted, teacher);
  return row && engine.store.event(String(row.id));
}
