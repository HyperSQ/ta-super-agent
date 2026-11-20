import { DomainError, workerProfile } from '../domain/model.ts';
import type { Event, Run, Task } from '../domain/model.ts';
import type { Store } from '../adapters/storage/sqlite.ts';
import type { TaskEngine } from './task-engine.ts';
import { contextForTeacher } from './teacher-conversation.ts';

type TaskChange = {
  action: 'revise' | 'pause' | 'resume' | 'cancel';
  revision: number;
  eventId: string;
  at: number;
  channel: Event['channel']['kind'];
  previousGoal?: string;
  previousResult?: { revision: number; text?: string; files?: Task['artifacts'] };
};
const preview = (value: string | undefined, limit: number) => !value || value.length <= limit ? value : value.slice(0, limit) + '…';
const descriptor = (event: Event) => ({
  eventId: event.id, channel: event.channel.kind, receivedAt: event.receivedAt,
  attachments: event.attachments?.slice(0, 6).map(({ name, kind }, index) => ({ name: preview(name, 160), kind, index: index + 1 })),
});
const artifactRefs = (files: Task['artifacts']) => files?.slice(-8).map(({ name, sha256, deliveryEventId }) => ({ name, sha256, deliveryEventId }));
const readChanges = (store: Store, id: string, limit: number): TaskChange[] =>
  store.db.prepare('SELECT data FROM task_changes WHERE task_id=? ORDER BY revision DESC LIMIT ?').all(id, limit)
    .map(row => JSON.parse(String(row.data)) as TaskChange);
const shortChanges = (changes: TaskChange[]) => changes.map(({ previousResult, previousGoal, ...change }) => ({
  ...change, previousGoal: preview(previousGoal, 320),
}));

export function recordTaskChange(store: Store, task: Task, event: Event, action: TaskChange['action'], at: number) {
  const previousResult = action !== 'cancel' && (task.result || task.artifacts?.length)
    ? { revision: task.revision, text: task.result, files: task.artifacts } : undefined;
  const change: TaskChange = { action, revision: task.revision + 1, eventId: event.id,
    at, channel: event.channel.kind, ...(action === 'revise' ? { previousGoal: task.goal } : {}), previousResult };
  store.db.prepare('INSERT INTO task_changes VALUES(?,?,?,?)').run(task.id, event.id, change.revision, JSON.stringify(change));
}

export function priorTaskResult(store: Store, taskId: string) {
  const row = store.db.prepare("SELECT json_extract(data,'$.previousResult') AS result FROM task_changes WHERE task_id=? " +
    "AND json_type(data,'$.previousResult')='object' ORDER BY revision DESC LIMIT 1").get(taskId);
  return row ? JSON.parse(String(row.result)) as NonNullable<TaskChange['previousResult']> : undefined;
}

export function taskHandoff(engine: TaskEngine, run: Run) {
  const store = engine.store;
  const { course, task } = run;
  const first = run.history[0]?.event, last = run.history.at(-1)?.event;
  const changes = readChanges(store, task.id, 4);
  const prior = task.kind === 'qa' ? undefined : priorTaskResult(store, task.id);
  const question = task.teacherWait && store.event(task.teacherWait.questionId);
  const answer = task.teacherWait?.answerId && store.event(task.teacherWait.answerId);
  const marker = task.checkpoint?.revision === run.revision && task.checkpoint.value && typeof task.checkpoint.value === 'object'
    ? task.checkpoint.value as Record<string, unknown> : undefined;
  return {
    task: { id: task.id, role: workerProfile(task.kind, task.grant.purpose), goal: preview(task.goal, 4200) ?? '',
      revision: run.revision, inputVersion: run.inputEpoch },
    course: { id: course.id, title: course.title, revision: course.revision ?? 1, progress: preview(course.progress, 1100),
      progressAt: course.progressAt, progressSource: course.progressSource, progressEvidence: course.progressEvidence?.slice(0, 6),
      textbookIds: course.textbookIds?.slice(0, 12) },
    origin: first && { ...descriptor(first), kind: first.mailIntake ? 'mail' : first.scheduled ? 'schedule' : first.dsh ? 'dsh' : 'message',
      mailId: first.mailIntake?.messageId },
    latestInput: last && descriptor(last),
    recentChanges: shortChanges(changes),
    awaiting: question && { question: { ...descriptor(question), text: preview(question.text, 900) },
      answer: answer ? { ...descriptor(answer), text: preview(answer.text, 1600) } : undefined },
    previousOutput: prior && { revision: prior.revision, excerpt: preview(prior.text, 1600), artifacts: artifactRefs(prior.files) },
    artifacts: artifactRefs(task.artifacts),
    checkpoint: marker && { stage: typeof marker.stage === 'string' ? preview(marker.stage, 80) : undefined,
      step: typeof marker.step === 'number' ? marker.step : undefined },
    scope: { deliveryChannel: task.grant.channel?.kind, requestedTools: first?.scheduledTools },
    teacherConversation: contextForTeacher(engine, last),
  };
}
export type TaskHandoff = ReturnType<typeof taskHandoff>;

const interactive = (task: Task) => !task.grant.purpose && ['lesson', 'scheduled'].includes(task.kind);
export function requireMaterialTask(store: Store, courseId: string, taskId: string): Task {
  const task = store.task(taskId);
  if (!task || task.courseId !== courseId || !interactive(task))
    throw new DomainError('not_found', '本课程没有可通过此工具访问的教学材料任务');
  return task;
}
export function materialTaskCard(store: Store, task: Task) {
  const origin = task.grant.originEventId && store.event(task.grant.originEventId);
  return { taskId: task.id, revision: task.revision, status: task.status, createdAt: task.createdAt, updatedAt: task.updatedAt, goal: preview(task.goal, 500) ?? '',
    channel: origin ? origin.channel.kind : undefined, title: task.kind === 'scheduled' ? task.grant.channel?.target : undefined,
    resultPreview: preview(task.result, 1200), artifacts: artifactRefs(task.artifacts) };
}
export function materialTaskMemory(store: Store, task: Task) {
  const prior = priorTaskResult(store, task.id);
  return { ...materialTaskCard(store, task), changes: shortChanges(readChanges(store, task.id, 6)),
    previousOutput: prior && { revision: prior.revision, excerpt: preview(prior.text, 1600), artifacts: artifactRefs(prior.files) } };
}
export function appliedTaskRevision(store: Store, taskId: string, eventId: string) {
  const row = store.db.prepare('SELECT revision FROM task_changes WHERE task_id=? AND event_id=? ORDER BY revision DESC LIMIT 1').get(taskId, eventId);
  return row && Number(row.revision);
}
export function findMaterialTasks(store: Store, courseId: string, query: string) {
  const normalized = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s/g, '');
  const term = normalized(query);
  return store.tasks().filter(task => task.courseId === courseId && interactive(task) && !['cancelled', 'superseded'].includes(task.status))
    .filter(task => !term || [task.id, task.goal, task.grant.channel?.target, task.result,
      ...task.artifacts?.map(file => file.name) ?? []].some(s => s && normalized(s).includes(term)))
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12).map(task => materialTaskCard(store, task));
}

export type MaterialSearch = { terms: string[]; before?: number; after?: number; offset: number };
export function recentMaterialRuns(store: Store, courseId: string) {
  const rows = store.db.prepare("SELECT data FROM tasks WHERE course_id=? AND json_extract(data,'$.kind') IN ('lesson','scheduled') " +
    "AND json_array_length(data,'$.artifacts')>0 AND status NOT IN ('cancelled','superseded') " +
    "ORDER BY json_extract(data,'$.updatedAt') DESC,id LIMIT 4").all(courseId);
  return rows.map(row => JSON.parse(String(row.data)) as Task).filter(interactive).map(task => ({
    taskId: task.id, status: task.status, updatedAt: task.updatedAt, goal: preview(task.goal, 160),
    files: task.artifacts?.slice(-4).map(file => preview(file.name, 160)),
  }));
}

export function searchMaterialTasks(store: Store, courseId: string, filter: MaterialSearch) {
  const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
  const terms = filter.terms.map(normalize).filter(Boolean);
  const rows = store.db.prepare("SELECT data FROM tasks WHERE course_id=? AND json_extract(data,'$.kind') IN ('lesson','scheduled') " +
    "AND status NOT IN ('cancelled','superseded') ORDER BY json_extract(data,'$.updatedAt') DESC,id").all(courseId);
  const candidates = rows.map(row => JSON.parse(String(row.data)) as Task)
    .filter(task => interactive(task) && (filter.before === undefined || task.updatedAt < filter.before) &&
      (filter.after === undefined || task.updatedAt >= filter.after));
  const ranked = candidates.map(task => {
    const current = normalize([task.id, task.goal, task.grant.channel?.target, ...task.artifacts?.map(file => file.name) ?? [], task.result].join('\n'));
    const prior = task.revision > 1 && terms.length && !terms.every(term => current.includes(term)) ? priorTaskResult(store, task.id) : undefined;
    const history = prior ? normalize([prior.text, ...prior.files?.map(file => file.name) ?? []].join('\n')) : '';
    const matches = terms.filter(term => current.includes(term) || history.includes(term)).length;
    return { task, matches };
  }).filter(hit => !terms.length || hit.matches > 0).sort((a, b) => b.matches - a.matches);
  const pageSize = 8;
  return {
    tasks: ranked.slice(filter.offset, filter.offset + pageSize).map(({ task }) => {
      const card = materialTaskCard(store, task);
      const prior = !card.artifacts?.length && task.revision > 1 ? priorTaskResult(store, task.id) : undefined;
      return { ...card, resultPreview: preview(card.resultPreview, 300), artifacts: card.artifacts ?? artifactRefs(prior?.files) };
    }),
    nextOffset: ranked.length > filter.offset + pageSize ? filter.offset + pageSize : undefined,
  };
}
