import { DomainError } from '../domain/model.ts';
import type { Event, Task, TaskKind } from '../domain/model.ts';
import { teacherAssistantEvent } from '../application/teacher-conversation.ts';

/** Identity is derived from adapter metadata, never a name or a model claim. */
export class Policy {
  teacherIds: Set<string>;
  constructor(teacherQQ: string[]) { this.teacherIds = new Set(['web:admin', ...teacherQQ.map(id => `qq:${id}`)]); }
  isTeacher(id: string): boolean { return this.teacherIds.has(id); }
  requireTeacher(event: Event): void {
    if (!this.isTeacher(event.actor.id)) throw new DomainError('forbidden', '只有已配置教师可以执行控制操作');
  }
  validateGrant(task: Task): void {
    if (task.grant.courseId !== task.courseId || task.grant.kind !== task.kind) throw new DomainError('forbidden', '任务授权范围不一致');
    if ((task.kind !== 'qa' || task.grant.purpose === 'teacher-work') && !this.isTeacher(task.grant.requester)) throw new DomainError('forbidden', '教师授权已失效');
  }
  validateWorkerSource(kind: TaskKind, event: Event): void {
    if (kind === 'teaching-affairs' && event.channel.kind !== 'qq-private' && !teacherAssistantEvent(event))
      throw new DomainError('forbidden', '作业和分数操作请通过教师私信完成');
    if (kind === 'coursework' && (event.actor.id !== 'web:admin' || event.channel.kind !== 'management'
      || event.channel.target !== 'course-mail' || !event.mailIntake?.messageId))
      throw new DomainError('forbidden', '作业处理任务须来自系统收件事件');
  }
}
