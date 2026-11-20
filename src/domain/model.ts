export type TaskKind = 'qa' | 'lesson' | 'scheduled' | 'teaching-affairs' | 'coursework';
export type WorkerProfile = 'qa' | 'teaching-affairs' | 'coursework' | 'teaching-materials';
export type ScheduledTool = 'class_context' | 'list_assignments' | 'read_assignment' | 'lookup_textbook' | 'search_textbook' | 'textbook_section' | 'view_textbook_page' | 'prepare_lesson' | 'weekly_report' | 'read_messages' | 'read_attachment' | 'ask_teacher' | 'send_group_file';
export type WeeklyTask = { id: string; title: string; prompt: string; tools: ScheduledTool[]; weekday: number; time: string;
  enabledAt: number; enabled: boolean; teacherQQ?: string; worker?: 'native' | 'dsh' };
export type TaskStatus = 'queued' | 'running' | 'paused' | 'waiting_teacher' | 'cancelled' | 'superseded' | 'completed' | 'blocked';
export type Channel = { kind: 'qq-group' | 'qq-private' | 'management'; target: string };
export type Course = {
  id: string; title: string; groupId?: string; instructions: string;
  revision?: number; className?: string; progress?: string; textbookIds?: string[];
  gradingPolicy?: string; roster?: string[];
  teacherHistoryStartAt?: number;
  progressAt?: number;
  progressSource?: 'teacher' | 'inferred';
  progressEvidence?: string[];
  weeklyLesson?: { weekday: number; time: string; teacherQQ: string; enabledAt: number };
  weeklyTasks?: WeeklyTask[];
};
export type AssignmentImage = { name: string; dataUrl: string };
export type Assignment = {
  id: string; courseId: string; title: string; instructions: string;
  deadline: string; gradingPolicy: string; revision: number; createdAt: string;
  images?: AssignmentImage[];
  studentVisible?: boolean;
};
export type OfflineSubmission = {
  assignmentId: string; studentName: string; score?: number; registeredAt: string;
  revision: number; actorId: string;
};
export type Actor = { id: string; role: 'teacher' | 'student' };
export type QQAttachment = { kind: 'image' | 'file'; fileId: string; name: string; size?: number };
export type Event = {
  id: string; sourceKey: string; courseId: string; threadId: string;
  actor: Actor; text: string; receivedAt: number;
  channel: Channel; externalId: string;
  quoted?: boolean;
  passiveQuestion?: true;
  quotedExternalId?: string;
  attachments?: QQAttachment[];
  teacherAnswerTo?: string;
  courseworkNotice?: boolean;
  assistantSurface?: 'dsh' | 'workbench';
  conversationOwner?: string;
  mailIntake?: { messageId: string; grade?: { assignmentId: string; assignmentRevision: number; submissionId: string } };
  scheduled?: 'weekly-lesson' | 'progress-request' | 'custom';
  scheduledTools?: ScheduledTool[];
  scheduledWorker?: 'native' | 'dsh';
  dsh?: { kind: 'question' } | { kind: 'assignment.announce'; assignmentId: string; revision: number; groupId: string }
    | { kind: 'teacher.ask' }
    | { kind: 'group.send'; groupId: string; imageId?: string; fileId?: string };
};
export type ReplyAction = { action: 'silent' }
  | { action: 'send'; format: 'text'; content: string[] }
  | { action: 'send'; format: 'latex'; content: string };
export type AssignmentRead = { id: string; revision: number };
export type Grant = {
  kind: TaskKind; courseId: string; originEventId?: string;
  requester: string; channel?: Channel;
  purpose?: 'course-selection' | 'teacher-work' | 'student-work';
};
export type Task = {
  id: string; courseId: string; kind: TaskKind; goal: string;
  revision: number; status: TaskStatus; inputEpoch: number;
  consumedSeq: number; grant: Grant;
  lease?: string; leaseUntil?: number;
  checkpoint?: { revision: number; value: unknown };
  result?: string; error?: string; createdAt: number; updatedAt: number;
  replyAction?: ReplyAction;
  assignmentReads?: AssignmentRead[];
  memoryReads?: { id: string; revision: number }[];
  memoryContextInvalidated?: boolean;
  dshSession?: string;
  teacherWait?: { questionId: string; answerId?: string };
  artifacts?: { name: string; bytes: number; sha256: string; deliveryEventId?: string }[];
  /** 更早对话的滚动摘要，供超出上下文预算后仍保留线索。 */
  threadSummary?: { text: string; throughId: string; at: number };
  /** 瞬态失败退避：已尝试次数与最早可重试时间。 */
  attempts?: number;
  retryAt?: number;
};
export type Input = { seq: number; event: Event };
export function workerProfile(kind: TaskKind, purpose?: Grant['purpose']): WorkerProfile {
  if (kind === 'lesson' || kind === 'scheduled') return 'teaching-materials';
  if (kind === 'teaching-affairs' || purpose === 'teacher-work') return 'teaching-affairs';
  if (kind === 'coursework' || purpose === 'student-work') return 'coursework';
  return 'qa';
}
export type ThreadAssignment = { eventId: string; threadId: string; revision: number };
export type ThreadCorrection = {
  feedbackEventId: string; moves: { eventId: string; revision: number }[];
  targetEventId?: string; targetRevision?: number; reason: string;
};
export type Run = {
  task: Task; inputs: Input[]; history: Input[]; course: Course;
  lease: string; revision: number; inputEpoch: number; throughSeq: number;
  memoryReads?: { id: string; revision: number }[];
  knowledgeAnchors?: string[];
  assignmentReads?: AssignmentRead[];
  /** 本轮上下文实际发出的续读引用；read_more 只接受这些引用。 */
  readRefs?: string[];
};
export type Delivery = {
  id: string; taskId: string; revision: number; inputEpoch: number;
  replyEventId: string; threadId?: string; channel: Channel; text: string;
  status: 'pending' | 'sending' | 'sent' | 'withdrawn' | 'unknown';
  externalId?: string; error?: string;
  externalFileId?: string;
  retryAt?: number;
  format?: 'text' | 'latex';
  afterDeliveryId?: string;
  sentAt?: number;
  announcement?: boolean;
  imageId?: string;
  fileId?: string;
};
export class DomainError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export const channelKey = (c: Channel) => `${c.kind}:${c.target}`;
