import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Knowledge, KnowledgeResult } from '../../ports/knowledge.ts';
import type { Embedding } from '../../ports/embedding.ts';
import { bm25, cosine, rrf, validVector } from '../retrieval/hybrid.ts';

type Chunk = { id: string; text: string; page: number; printedPage?: string; chapter?: string; needsVisualVerification?: boolean };
type Parent = Chunk & { endPage: number };
type Package = {
  version: string; chunks: Chunk[]; parents: Map<string, Parent>; childParents: Record<string, string[]>;
  vectors?: number[][]; warnings: string[]; requiresVisual: boolean;
};
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** Independent reader for imported textbook packages; never calls the old chatbot. */
export class TextbookLibrary implements Knowledge {
  root: string; embedding?: Embedding; private cache = new Map<string, Package>();
  constructor(root: string, embedding?: Embedding) { this.root = root; this.embedding = embedding; }
  load(id: string): Package {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('教材ID格式无效');
    const cached = this.cache.get(id); if (cached) return cached;
    const dir = join(this.root, id);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const chunksRaw = readFileSync(join(dir, 'chunks.json')), chunks = JSON.parse(chunksRaw.toString()) as Chunk[];
    if (manifest.id !== id || !Array.isArray(chunks) || !chunks.length || new Set(chunks.map(c => c.id)).size !== chunks.length
      || chunks.some(c => !c.id || typeof c.text !== 'string' || !Number.isInteger(c.page) || c.page < 1 || c.text.length > 20000)
      || (manifest.embedding?.chunksSha256 && sha(chunksRaw) !== manifest.embedding.chunksSha256)) throw new Error('教材子块或哈希校验失败');
    const result: Package = { version: sha(chunksRaw), chunks, parents: new Map(), childParents: {}, warnings: [], requiresVisual: manifest.needsVisualVerification !== false };
    try {
      const h = JSON.parse(readFileSync(join(dir, 'hierarchy.json'), 'utf8')) as { parents: Parent[]; childParents: Record<string, string[]>; chunksSha256?: string; pagesSha256?: string };
      if (!Array.isArray(h.parents) || !h.childParents || (h.chunksSha256 && h.chunksSha256 !== result.version)
        || (h.pagesSha256 && sha(readFileSync(join(dir, 'pages.json'))) !== h.pagesSha256)
        || h.parents.some(p => typeof p.text !== 'string' || !p.id || !Number.isInteger(p.page) || !Number.isInteger(p.endPage))) throw new Error();
      result.parents = new Map(h.parents.map(p => [p.id, p])); result.childParents = h.childParents;
    } catch { result.warnings.push(id + '：父子索引不可用，使用子块检索'); }
    if (this.embedding && manifest.embedding?.configHash === this.embedding.fingerprint && manifest.embedding.dimensions === this.embedding.dimensions) {
      try {
        const raw = readFileSync(join(dir, 'vectors.bin')), dimensions = this.embedding.dimensions;
        if (raw.length !== chunks.length * dimensions * 4 || (manifest.embedding.vectorsSha256 && sha(raw) !== manifest.embedding.vectorsSha256)) throw new Error();
        result.vectors = chunks.map((_, i) => Array.from({ length: dimensions }, (__, j) => raw.readFloatLE((i * dimensions + j) * 4)));
        if (result.vectors.some(v => !validVector(v, dimensions))) throw new Error();
      } catch { result.vectors = undefined; result.warnings.push(id + '：向量文件无效，降级关键词检索'); }
    } else result.warnings.push(id + '：未配置与教材索引完全匹配的Embedding，使用关键词检索');
    this.cache.set(id, result); return result;
  }
  async search(bookIds: string[], query: string, signal: AbortSignal): Promise<KnowledgeResult> {
    const result: KnowledgeResult = { hits: [], topics: [], mode: 'keyword', warnings: [] };
    let queryVector: number[] | undefined;
    const packages: { id: string; data: Package }[] = [];
    for (const id of [...new Set(bookIds)]) {
      try { const data = this.load(id); packages.push({ id, data }); result.warnings.push(...data.warnings); }
      catch { result.warnings.push(id + '：教材包不可用或校验失败'); }
    }
    if (this.embedding && packages.some(p => p.data.vectors)) {
      try {
        queryVector = await this.embedding.encode(query, 'query', signal);
        if (!validVector(queryVector, this.embedding.dimensions)) throw new Error();
      } catch { signal.throwIfAborted(); queryVector = undefined; result.warnings.push('教材查询向量不可用，降级关键词检索'); }
    }
    const candidates: { hit: KnowledgeResult['hits'][number]; score: number }[] = [];
    for (const { id, data } of packages) {
      const lexical = bm25(query, data.chunks);
      const vectors = queryVector && data.vectors ? data.chunks.map((c, i) => ({ id: c.id, score: cosine(queryVector!, data.vectors![i]) })).filter(h => h.score > 0).sort((a, b) => b.score - a.score) : [];
      if (queryVector && data.vectors) result.mode = 'hybrid';
      const seen = new Set<string>();
      for (const ranked of rrf([lexical, vectors]).slice(0, 12)) {
        const chunk = data.chunks.find(c => c.id === ranked.id)!;
        const parent = (data.childParents[chunk.id] ?? []).map(p => data.parents.get(p)).find(p => p && p.text.length <= 5000);
        const identity = parent?.id ?? chunk.id;
        if (seen.has(identity)) continue; seen.add(identity);
        candidates.push({ score: ranked.score, hit: {
          bookId: id, bookVersion: data.version, chunkId: chunk.id, anchor: id + '@' + data.version + ':' + identity,
          parentId: parent?.id, page: chunk.page, printedPage: chunk.printedPage,
          contextStartPage: parent?.page ?? chunk.page,
          endPage: parent?.endPage ?? chunk.page, chapter: chunk.chapter ?? '',
          text: parent?.text ?? chunk.text,
          needsVisualVerification: data.requiresVisual || chunk.needsVisualVerification === true,
          reasons: [...(lexical.some(h => h.id === chunk.id) ? ['bm25'] : []), ...(vectors.some(h => h.id === chunk.id) ? ['vector'] : [])],
        } });
      }
    }
    result.hits = candidates.sort((a, b) => b.score - a.score).slice(0, 4).map(c => c.hit);
    result.topics = [...new Set(result.hits.map(h => h.chapter).filter(Boolean))];
    if (!bookIds.length) result.warnings.push('课程尚未绑定教材');
    return result;
  }
}
