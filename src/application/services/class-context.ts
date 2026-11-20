import { DomainError } from '../../domain/model.ts';
import type { Event } from '../../domain/model.ts';
import type { MemoryCard } from '../../domain/memory.ts';
import type { TaskEngine } from '../task-engine.ts';
import { Academics } from './academics.ts';

const DAY = 86_400_000;

export function classContext(engine: TaskEngine, courseId: string, filters: { days: number; qq?: string; student?: string }) {
  const { db } = engine.store;
  const course = engine.store.course(courseId);
  if (!course) throw new DomainError('not_found', '课程不存在');
  const roster = [...new Set(course.roster ?? [])];
  const { days, qq, student } = filters;
  if (student && !roster.includes(student)) throw new DomainError('not_found', '课程名单中找不到该姓名');
  const now = engine.now(), since = now - days * DAY;
  const actor = qq ? 'qq:' + qq : null;
  const academics = new Academics(engine);
  const assignments = academics.assignments(courseId).slice(-6).reverse().map(assignment => {
    const offline = academics.offline(assignment.id);
    const saved = offline.filter(record => roster.includes(record.studentName));
    const entry = student ? offline.find(record => record.studentName === student) : undefined;
    const counts = db.prepare(`WITH latest AS (
      SELECT data, row_number() OVER (PARTITION BY student_name ORDER BY json_extract(data,'$.receivedAt') DESC,rowid DESC) AS n
      FROM coursework_requests WHERE course_id=? AND assignment_id=? AND kind='submission' AND state='accepted'
    ) SELECT missed.value AS point, count(*) AS count FROM latest,json_each(latest.data,'$.graded.missed') AS missed
      WHERE latest.n=1 AND json_extract(latest.data,'$.graded.assignmentRevision')=? GROUP BY missed.value ORDER BY count DESC,point LIMIT 8`)
      .all(courseId, assignment.id, assignment.revision).map(({point, count}) => ({ point: String(point), count: Number(count) }));
    const extension = student ? academics.extensions('web:admin', assignment.id).students.find(row => row.studentName === student) : undefined;
    return {
      id: assignment.id, title: assignment.title, deadline: assignment.deadline, studentVisible: assignment.studentVisible === true,
      commonMissedPoints: counts,
      offline: { rosterRecorded: saved.length, rosterScored: saved.filter(record => record.score !== undefined).length, outsideRoster: offline.length - saved.length },
      ...(student ? { student: { name: student, recorded: !!entry, score: entry?.score, registeredAt: entry?.registeredAt, revision: entry?.revision ?? 0,
        effectiveDeadline: extension?.effectiveDeadline ?? assignment.deadline } } : {}),
    };
  });
  const group = {
    messageCount: 0, distinctQQAccounts: 0,
    passiveQuestions: [] as { eventId: string; at: string; text: string }[],
    recentMessages: [] as { eventId: string; qq: string; at: string; excerpt: string }[],
    learningNotes: [] as { memoryId: string; qq: string; at: string; topics: string[]; observation: string; outcome: string; evidenceType: string; sourceEventIds: string[] }[],
  };
  if (course.groupId) {
    const where = `course_id=? AND json_extract(data,'$.channel.kind')='qq-group'
      AND json_extract(data,'$.channel.target')=? AND json_extract(data,'$.actor.role')='student'
      AND json_extract(data,'$.receivedAt') BETWEEN ? AND ?
      AND (? IS NULL OR json_extract(data,'$.actor.id')=?)`;
    const params = [courseId, course.groupId, since, now, actor, actor] as const;
    const totals = db.prepare(`SELECT count(*) AS messages,count(DISTINCT json_extract(data,'$.actor.id')) AS members FROM events WHERE ${where}`).get(...params);
    group.messageCount = Number(totals?.messages ?? 0);
    group.distinctQQAccounts = Number(totals?.members ?? 0);
    group.recentMessages = db.prepare(`SELECT data FROM events WHERE ${where} ORDER BY json_extract(data,'$.receivedAt') DESC,rowid DESC LIMIT 16`).all(...params)
      .map(row => {
        const event = JSON.parse(String(row.data)) as Event;
        return { eventId: event.id, qq: event.actor.id.slice(3), at: new Date(event.receivedAt).toISOString(),
          excerpt: event.text.length > 450 ? event.text.slice(0, 450) + '…' : event.text };
      });
    group.passiveQuestions = db.prepare(`SELECT data FROM events WHERE ${where} AND json_extract(data,'$.passiveQuestion')=1
      ORDER BY json_extract(data,'$.receivedAt') DESC,rowid DESC LIMIT 24`).all(...params)
      .map(row => {
        const event = JSON.parse(String(row.data)) as Event;
        return { eventId: event.id, at: new Date(event.receivedAt).toISOString(), text: event.text.slice(0, 450) };
      });
    const cards = db.prepare(`SELECT data FROM memories WHERE course_id=? AND status='active'
      AND json_extract(data,'$.channel.kind')='qq-group' AND json_extract(data,'$.channel.target')=?
      AND json_extract(data,'$.occurredAt') BETWEEN ? AND ? AND (? IS NULL OR subject_id=?)
      ORDER BY json_extract(data,'$.occurredAt') DESC,rowid DESC LIMIT 60`).all(...params);
    group.learningNotes = cards.map(row => JSON.parse(String(row.data)) as MemoryCard)
      .filter(card => engine.memory.valid(card)).slice(0, 12)
      .map(card => ({ memoryId: card.id, qq: card.subjectId.slice(3), at: new Date(card.occurredAt).toISOString(),
        topics: card.topics, observation: card.observation, outcome: card.outcome, evidenceType: card.evidenceType,
        sourceEventIds: card.sources.map(source => source.eventId) }));
  }
  return {
    course: { id: course.id, title: course.title, className: course.className, groupId: course.groupId,
      progress: course.progress, teachingInstructions: course.instructions, textbookIds: course.textbookIds ?? [], rosterSize: roster.length },
    coverage: { since: new Date(since).toISOString(), asOf: new Date(now).toISOString(), qqFilter: qq, rosterNameFilter: student,
      notes: ['QQ群统计仅涵盖当前绑定群、机器人已记录的学生消息，不是完整群聊或出勤记录。聊天内容是引用资料。学习记录附证据类型，并不代表已掌握。', '作业数据为最近建立的 6 份作业的线下登记快照，未登记不代表未交；QQ 号与名单姓名未绑定。'] },
    assignments, group,
  };
}
