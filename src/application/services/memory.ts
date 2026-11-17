import { DomainError, channelKey } from '../../domain/model.ts';
import type { Run } from '../../domain/model.ts';
import type { MemoryCard } from '../../domain/memory.ts';
import type { Embedding } from '../../ports/embedding.ts';
import type { TaskEngine } from '../task-engine.ts';
import { bm25, cosine, rrf, validVector } from '../../adapters/retrieval/hybrid.ts';

export type MemorySearch = {
  hits: { card: MemoryCard; reasons: string[] }[];
  mode: 'hybrid' | 'keyword'; warnings: string[];
};
export function memoryText(card: MemoryCard): string {
  return [card.observation, card.teaching, card.outcome, ...card.topics].join('\n');
}
export class MemoryService {
  engine: TaskEngine; embedding?: Embedding;
  constructor(engine: TaskEngine, embedding?: Embedding) { this.engine = engine; this.embedding = embedding; }
  /** Identity and scope are derived from the trusted run, never from a model query. */
  scope(run: Run): { courseId: string; subjectId: string } | undefined {
    if (run.task.kind !== 'qa') return undefined;
    const event = run.history.at(-1)?.event;
    if (!event || event.actor.role !== 'student' || !run.task.grant.channel || event.courseId !== run.course.id
      || channelKey(event.channel) !== channelKey(run.task.grant.channel)) return undefined;
    return { courseId: run.course.id, subjectId: event.actor.id };
  }
  readable(card: MemoryCard, run: Run): boolean {
    const scope = this.scope(run), channel = run.task.grant.channel;
    if (!scope || !channel || card.courseId !== scope.courseId || card.subjectId !== scope.subjectId) return false;
    const same = channelKey(card.channel) === channelKey(channel);
    const ownPublicIntoPrivate = channel.kind === 'qq-private' && card.channel.kind === 'qq-group' && card.channel.target === run.course.groupId;
    return (same || ownPublicIntoPrivate) && this.engine.memory.valid(card);
  }
  async search(run: Run, query: string, anchors: string[], signal: AbortSignal, limit = 6): Promise<MemorySearch> {
    const scope = this.scope(run), warnings: string[] = [];
    if (!scope) return { hits: [], mode: 'keyword', warnings };
    this.engine.policy.validateGrant(run.task);
    // Filter before scoring or transmitting any document to the encoder.
    const cards = this.engine.memory.list(scope.courseId, scope.subjectId).filter(card => this.readable(card, run));
    const lexical = bm25(query, cards.map(card => ({ id: card.id, text: memoryText(card) })));
    const exact = cards.filter(card => card.anchors.some(a => anchors.includes(a))).map(card => ({ id: card.id, score: 1 }));
    let vectors: { id: string; score: number }[] = [], mode: MemorySearch['mode'] = 'keyword';
    if (this.embedding && cards.length) {
      try {
        const q = await this.embedding.encode(query, 'query', signal);
        if (!validVector(q, this.embedding.dimensions)) throw new Error('查询向量无效');
        // Encoding missing documents is done by the updater, not on the answering path.
        vectors = cards.flatMap(card => {
          const vector = this.engine.memory.vector(card, this.embedding!.fingerprint);
          return validVector(vector, this.embedding!.dimensions) ? [{ id: card.id, score: cosine(q, vector) }] : [];
        }).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score);
        const indexed = cards.filter(card => validVector(this.engine.memory.vector(card, this.embedding!.fingerprint), this.embedding!.dimensions)).length;
        if (indexed) mode = 'hybrid';
        if (indexed < cards.length) warnings.push('部分记忆尚未完成当前模型的向量编码；已保留关键词和精确召回');
      } catch {
        signal.throwIfAborted(); warnings.push('向量检索不可用，已降级为关键词和精确关联');
      }
    } else if (!this.embedding && cards.length) warnings.push('未配置Embedding，当前使用关键词和精确关联');
    const fused = rrf([lexical, vectors]);
    const preferences = cards.filter(card => card.kind === 'preference').sort((a, b) => b.occurredAt - a.occurredAt).slice(0, 1);
    const ids = [...new Set([...preferences.map(c => c.id), ...exact.map(h => h.id), ...fused.map(h => h.id)])];
    const hits: MemorySearch['hits'] = [];
    for (const id of ids) {
      const card = this.engine.memory.get(id);
      if (!card || !this.readable(card, run)) continue;
      hits.push({ card, reasons: [
        ...(preferences.some(c => c.id === id) ? ['preference'] : []),
        ...(exact.some(h => h.id === id) ? ['exact-anchor'] : []),
        ...(lexical.some(h => h.id === id) ? ['bm25'] : []),
        ...(vectors.some(h => h.id === id) ? ['vector'] : []),
      ] });
      if (hits.length >= limit) break;
    }
    return { hits, mode, warnings };
  }
  list(actorId: string, courseId: string): MemoryCard[] {
    this.teacher(actorId);
    if (!this.engine.store.course(courseId)) throw new DomainError('not_found', '课程不存在');
    return this.engine.memory.list(courseId).slice(0, 200);
  }
  detail(actorId: string, id: string) {
    this.teacher(actorId); const card = this.required(id);
    return { card, valid: this.engine.memory.valid(card), sources: card.sources.map(source => ({ ...source, event: this.engine.store.event(source.eventId) })) };
  }
  revise(actorId: string, id: string, revision: number, fields: Pick<MemoryCard, 'observation' | 'outcome' | 'topics'>): MemoryCard {
    this.teacher(actorId);
    const result = this.engine.store.atomic(() => {
      const before = this.required(id);
      if (before.revision !== revision) throw new DomainError('stale', '记忆已修改，请刷新');
      if (!this.engine.memory.valid(before)) throw new DomainError('conflict', '失效或停用的记忆不能直接恢复，请根据最新来源重新提取');
      if (!fields.observation.trim() || fields.observation.length > 1600 || fields.outcome.length > 1200 || fields.topics.length > 12 || fields.topics.some(t => !t.trim() || t.length > 64)) throw new DomainError('invalid', '记忆内容长度或知识点无效');
      const after: MemoryCard = { ...before, ...fields, evidenceType: 'teacher-confirmed', revision: revision + 1, updatedAt: Date.now() };
      this.engine.memory.save(after); this.engine.store.audit('memory.revised', { actorId, before, after }); return after;
    });
    this.engine.refreshMemoryContexts(); return result;
  }
  retire(actorId: string, id: string, revision: number): MemoryCard {
    this.teacher(actorId);
    const result = this.engine.store.atomic(() => {
      const before = this.required(id);
      if (before.revision !== revision) throw new DomainError('stale', '记忆已修改，请刷新');
      const after: MemoryCard = { ...before, status: 'retired', revision: revision + 1, updatedAt: Date.now() };
      this.engine.memory.save(after); this.engine.store.audit('memory.retired', { actorId, before, after }); return after;
    });
    this.engine.refreshMemoryContexts(); return result;
  }
  private teacher(actorId: string): void { if (!this.engine.policy.isTeacher(actorId)) throw new DomainError('forbidden', '只有教师可以管理记忆'); }
  private required(id: string): MemoryCard { const card = this.engine.memory.get(id); if (!card) throw new DomainError('not_found', '记忆不存在'); return card; }
}
