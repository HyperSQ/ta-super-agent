import type { Run } from '../domain/model.ts';
import { DomainError, channelKey } from '../domain/model.ts';
import type { Knowledge, KnowledgeResult } from '../ports/knowledge.ts';
import type { MemoryService, MemorySearch } from '../application/services/memory.ts';
import type { TextbookReferences } from '../adapters/knowledge/references.ts';
import type { Message, Model } from '../ports/model.ts';

const DISCUSSION_LIMIT = 1200;
/** 一轮对话可用的字符预算；模型窗口远大于此，留出教材与记忆空间。 */
const DISCUSSION_BUDGET = 40_000;
const SUMMARY_LIMIT = 2000;

export class ContextBuilder {
  memory: MemoryService; knowledge?: Knowledge; references?: TextbookReferences; model?: Model;
  constructor(memory: MemoryService, knowledge?: Knowledge, references?: TextbookReferences, model?: Model) {
    this.memory = memory; this.knowledge = knowledge; this.references = references; this.model = model;
  }
  private digest(omitted: Run['history']) {
    const lines = omitted.map(input => (input.event.actor.role === 'teacher' ? '教师：' : '学生：') + input.event.text.slice(0, 160));
    return ('（更早对话摘录）\n' + lines.join('\n')).slice(-SUMMARY_LIMIT);
  }
  private async summarize(run: Run, omitted: Run['history'], signal: AbortSignal) {
    const cached = run.task.threadSummary;
    const throughId = omitted.at(-1)?.event.id;
    if (!throughId) return undefined;
    if (cached && cached.throughId === throughId) return cached.text;
    const digest = this.digest(omitted);
    let text = digest;
    if (this.model && omitted.length >= 4) {
      const messages: Message[] = [
        { role: 'system', content: '把更早的课程对话压缩成 300 字以内的摘要，保留学生的问题、已确认的结论和未解决的疑问。只输出摘要，不要寒暄。' },
        { role: 'user', content: JSON.stringify(omitted.map(input => ({ role: input.event.actor.role, text: input.event.text.slice(0, 400) }))) },
      ];
      try { text = (await this.model.complete(messages, signal, false)).trim().slice(0, 1200) || digest; }
      catch (error) { signal.throwIfAborted(); text = digest; }
    }
    run.task.threadSummary = { text, throughId, at: Date.now() };
    try { this.memory.engine.store.saveTask(run.task); } catch { /* 摘要写入失败不阻塞本轮 */ }
    return text;
  }
  async build(run: Run, signal: AbortSignal, prefetchTextbook = true) {
    const history = run.history;
    const picked: typeof history = [];
    let used = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const length = Math.min(history[i].event.text.length, DISCUSSION_LIMIT);
      if (picked.length && used + length > DISCUSSION_BUDGET) break;
      picked.unshift(history[i]); used += length;
    }
    const omitted = history.slice(0, history.length - picked.length);
    const earlierSummary = omitted.length ? await this.summarize(run, omitted, signal) : undefined;
    const store = this.memory.engine.store;
    // 超长原文只放前段，并给出可用 read_more 续读的引用。
    const readRefs: string[] = [];
    const discussion = picked.map(input => {
      const text = input.event.text;
      const ref = text.length > DISCUSSION_LIMIT ? `evt:${input.event.id}:${DISCUSSION_LIMIT}` : undefined;
      if (ref) readRefs.push(ref);
      const quoted = input.event.quotedExternalId
        ? store.eventByKey(`qq:${channelKey(input.event.channel)}:${input.event.quotedExternalId}`)
        : undefined;
      return {
        eventId: input.event.id, actorId: input.event.actor.id, text: text.slice(0, DISCUSSION_LIMIT),
        ...(ref ? { truncated: true, ref } : {}),
        ...(quoted && quoted.courseId === run.course.id ? { quotedEventId: quoted.id } : {}),
      };
    });
    run.readRefs = readRefs;
    const current = history.at(-1)?.event;
    const latest = current?.text ?? run.task.goal;
    const followup = /^(?:这[题道个里步一]|刚才|那[题道个]|第[一二三四五\d]+问|它|为什么|怎么做|继续|所以|那[么如果]|再|请(?:再|把|展开|详细|用.*(?:举例|说明))|能(?:再|详细)|什么意思|有别的方法)/.test(latest);
    const prior = picked.length ? picked.slice(0, -1) : [];
    const recent = followup ? prior : [];
    const earlier = (current?.quoted ? prior : recent.slice(-3)).map(i => i.event.text);
    let exact = prefetchTextbook ? this.references?.lookup(run.course.textbookIds ?? [], latest, earlier) : undefined;
    if (prefetchTextbook && !exact?.requested.length && (current?.quoted || followup)) {
      for (let i = earlier.length - 1; i >= 0; i--) {
        const candidate = this.references?.lookup(run.course.textbookIds ?? [], earlier[i], earlier.slice(0, i));
        if (candidate?.requested.length) { exact = candidate; break; }
      }
    }
    const query = (earlier.length && latest.length < 45 ? earlier.at(-1) + '\n' + latest : latest).slice(-6000);
    const knowledge: KnowledgeResult = prefetchTextbook && this.knowledge && !exact?.requested.length
      ? await this.knowledge.search(run.course.textbookIds ?? [], query, signal)
      : { hits: [], topics: [], mode: 'keyword', warnings: prefetchTextbook && !this.knowledge ? ['尚未接入教材检索'] : [] };
    const anchors = knowledge.hits.map(hit => hit.anchor);
    const memories: MemorySearch = await this.memory.search(run, query + '\n' + knowledge.topics.join(' '), anchors, signal);
    signal.throwIfAborted();
    // Never inject a card that became invalid while awaiting retrieval.
    if (memories.hits.some(hit => !this.memory.readable(hit.card, run))) throw new DomainError('stale', '检索期间记忆已修订');
    run.memoryReads = memories.hits.map(hit => ({ id: hit.card.id, revision: hit.card.revision }));
    if (!this.memory.engine.memory.validReads(run.memoryReads)) throw new DomainError('stale', '检索期间记忆版本已变化');
    run.knowledgeAnchors = anchors;
    let memoryBudget = 20_000;
    const selected = memories.hits.filter(hit => {
      const length = JSON.stringify(hit.card).length;
      if (length > memoryBudget) return false;
      memoryBudget -= length; return true;
    });
    // Only actual context dependencies should invalidate this run.
    run.memoryReads = selected.map(hit => ({ id: hit.card.id, revision: hit.card.revision }));
    this.memory.engine.bindMemoryContext(run);
    if (selected.length < memories.hits.length) memories.warnings.push('上下文预算不足，已整条省略部分记忆，可通过管理页查看原始来源');
    return {
      taskGoal: run.task.grant.channel?.kind === 'management' || run.task.revision > 1 ? run.task.goal : latest,
      currentRequest: latest, courseProgress: run.course.progress,
      previousAnswer: earlier.length ? run.task.result?.slice(0, 2500) : undefined,
      ...(earlierSummary ? { earlierSummary } : {}),
      discussion,
      subject: this.memory.scope(run),
      exactTextbookReferences: exact?.requested.length ? exact : undefined,
      textbookEvidence: knowledge,
      studentMemory: { mode: memories.mode, warnings: memories.warnings, hits: selected.map(({ card, reasons }) => ({
        id: card.id, revision: card.revision, subjectId: card.subjectId, kind: card.kind, preference: card.preference,
        observation: card.observation, teaching: card.teaching, outcome: card.outcome,
        topics: card.topics, evidenceType: card.evidenceType, occurredAt: card.occurredAt, sources: card.sources, reasons,
      })) },
    };
  }
}
