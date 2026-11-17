import type { Channel, Event } from './model.ts';

export type MemorySource = { eventId: string; threadRevision: number; quote: string };
export type MemoryPreference = 'examples-first' | 'steps-first' | 'concise';
export type MemoryCard = {
  id: string; courseId: string; subjectId: string; revision: number;
  status: 'active' | 'retired' | 'invalidated';
  kind: 'episode' | 'preference'; preference?: MemoryPreference;
  observation: string; teaching: string; outcome: string;
  topics: string[]; anchors: string[];
  evidenceType: 'student-report' | 'observed' | 'teacher-confirmed';
  channel: Channel; sources: MemorySource[];
  dependencies?: { eventId: string; threadRevision: number }[];
  occurredAt: number; updatedAt: number; jobId: string;
};
export type MemoryJob = {
  id: string; taskId: string; taskRevision: number; courseRevision: number;
  courseId: string; subjectId: string; channel: Channel;
  events: { event: Event; threadRevision: number }[];
  teaching: string; anchors: string[]; createdAt: number;
  newEventIds: string[];
};
export type MemoryRead = { id: string; revision: number };
export type MemoryCandidate = Pick<MemoryCard, 'kind' | 'preference' | 'observation' | 'outcome' | 'topics' | 'anchors' | 'sources'>;
