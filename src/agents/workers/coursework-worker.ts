import type { Worker } from './qa-worker.ts';
import type { TaskEngine } from '../../application/task-engine.ts';
import { Academics } from '../../application/services/academics.ts';
import type { CourseMail, MailSuggestion } from '../../application/services/course-mail.ts';
import type { Model } from '../../ports/model.ts';
import { gradeDraft, gradeSource } from '../../application/services/grading-draft.ts';

const normalized = (text: string) => text.normalize('NFKC').toLowerCase();
const normalizedSubject = (text: string) => normalized(text).trim().replace(/\s+/gu, ' ');
function containsLabel(text: string, label: string) {
  const pattern = normalized(label.trim()).replace(/[.*+?^$(){}|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
  return !!pattern && new RegExp(pattern + (/\d$/.test(label) ? '(?!\\d)' : ''), 'u').test(normalized(text));
}

export function courseworkWorker(engine: TaskEngine, mail: CourseMail, model?: Model): Worker {
  const academics = new Academics(engine);
  return async ({ run, signal, complete, handoff }) => {
    const messageId = handoff?.origin?.mailId ?? run.history[0]?.event.mailIntake?.messageId;
    if (run.task.kind !== 'coursework' || !messageId || !complete) throw Error('作业处理来源不完整');
    const courseId = run.course.id;
    const origin = run.history[0]?.event;
    if (origin?.mailIntake?.grade) {
      if (!model) throw Error('当前服务器未配置批改模型');
      const input = mail.gradingInput(origin);
      run.assignmentReads = [{ id: input.assignment.id, revision: input.assignment.revision }];
      const source = await gradeSource(input.text, input.files, signal);
      const draft = await gradeDraft(model, { assignment: input.assignment.instructions, criteria: input.criteria, source }, signal);
      return engine.store.atomic(() => {
        const registered = mail.saveGrade(origin, draft);
        const result = registered ? `逐项批改已完成，已登记 ${draft.total}/${draft.maximum} 分。` : '逐评分点批改草稿已保存，待教师核对。';
        complete(result);
        return result;
      });
    }
    const message = mail.read(courseId, messageId);
    if (message.state !== 'pending') return '教师已处理邮件。';
    const suggestion: MailSuggestion = { evidence: [] };
    if (message.issue) suggestion.evidence.push(message.issue);
    else {
      const subjectAndFiles = [message.subject, ...message.files.map(file => file.name)];
      const explicit = [message.subject, message.text.slice(0, 6000)];
      const matches = academics.visibleAssignments(courseId).filter(assignment =>
        explicit.some(text => containsLabel(text, assignment.id)) ||
        subjectAndFiles.some(text => containsLabel(text, assignment.title)));
      if (matches.length === 1) {
        const { id, title, revision } = matches[0];
        suggestion.assignment = { id, title, revision };
        run.assignmentReads = [{ id, revision }];
        suggestion.evidence.push('主题、附件名或正文的作业编号命中一份已发布作业。');
      } else suggestion.evidence.push(matches.length > 1 ? '命中多份作业，需核对归属。' : '没有找到唯一作业候选。');

      const named = (run.course.roster ?? []).filter(name =>
        name.length >= 2 && (containsLabel(message.subject, name) ||
        message.text.split(/\r?\n/).slice(0, 20).some(line => line.replace(/^\s*姓名[：:]\s*/u, '').trim() === name)));
      if (named.length === 1) {
        suggestion.studentName = named[0];
        suggestion.evidence.push('候选姓名来自主题或正文署名，需核对发件身份。');
      } else suggestion.evidence.push('需确认发件人对应的名单姓名。');
    }
    const exactSubject = suggestion.assignment && suggestion.studentName &&
      normalizedSubject(message.subject) === normalizedSubject(`作业 ${suggestion.assignment.title} ${suggestion.studentName}`);
    signal.throwIfAborted();
    return engine.store.atomic(() => {
      const automated = mail.finishIntake(courseId, messageId, suggestion, !!model && !!exactSubject);
      const summary = automated ?? suggestion.evidence.join('\n');
      complete(summary);
      return summary;
    });
  };
}
