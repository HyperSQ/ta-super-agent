import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TextbookLibrary } from '../src/adapters/knowledge/library.ts';
import { HttpEmbedding } from '../src/adapters/models/embedding.ts';
import { MemoryService } from '../src/application/services/memory.ts';
import { MemoryUpdater } from '../src/application/memory-updater.ts';
import { ContextBuilder } from '../src/agents/context-builder.ts';
import { fixture } from './helpers.ts';

function bookFixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'ta-memory-rag-')), dir = join(root, 'book');
  mkdirSync(dir);
  t.after(() => {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes('ta-memory-rag-')) throw new Error('测试目录不在预期范围');
    rmSync(root, { recursive: true, force: true });
  });
  const chunks = [
    { id: 'c1', page: 3, printedPage: '1', text: '一致收敛的定义需要对整个区间控制误差。', chapter: '一致收敛' },
    { id: 'c2', page: 4, printedPage: '2', text: '某个别的概念。', chapter: '其他概念' },
  ];
  const raw = Buffer.from(JSON.stringify(chunks)); writeFileSync(join(dir, 'chunks.json'), raw);
  const vectors = Buffer.alloc(16); [1, 0, 0, 1].forEach((n, i) => vectors.writeFloatLE(n, i * 4)); writeFileSync(join(dir, 'vectors.bin'), vectors);
  const hash = createHash('sha256').update(raw).digest('hex');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id: 'book', embedding: { configHash: 'full-config-v1', dimensions: 2, chunksSha256: hash, vectorsSha256: createHash('sha256').update(vectors).digest('hex') } }));
  writeFileSync(join(dir, 'hierarchy.json'), JSON.stringify({ chunksSha256: hash, parents: [
    { id: 'p1', page: 2, endPage: 3, text: '完整条件：函数列在整个区间一致收敛。定义及其说明。' },
  ], childParents: { c1: ['p1'] } }));
  return { root, dir, hash };
}

test('兼容教材包的关键词检索展开父块，保留命中页与上下文页范围', async t => {
  const b = bookFixture(t), library = new TextbookLibrary(b.root);
  const result = await library.search(['book'], '一致收敛定义', new AbortController().signal);
  assert.equal(result.mode, 'keyword'); assert.equal(result.hits[0].chunkId, 'c1');
  assert.equal(result.hits[0].page, 3); assert.equal(result.hits[0].contextStartPage, 2);
  assert.equal(result.hits[0].printedPage, '1'); assert.equal(result.hits[0].parentId, 'p1');
  assert.match(result.hits[0].text, /完整条件/); assert.equal(result.hits[0].needsVisualVerification, true);
  assert.equal((await library.search([], '一致收敛', new AbortController().signal)).hits.length, 0);
});

test('匹配完整编码指纹才能语义召回；损坏索引如实降级，教材哈希变化拒绝加载', async t => {
  const b = bookFixture(t); let calls = 0;
  const embedding = { fingerprint: 'full-config-v1', dimensions: 2, encode: async () => { calls++; return [1, 0]; } };
  const result = await new TextbookLibrary(b.root, embedding).search(['book'], 'semantic-only-query', new AbortController().signal);
  assert.equal(calls, 1); assert.equal(result.mode, 'hybrid'); assert.equal(result.hits[0].chunkId, 'c1');
  assert.deepEqual(result.hits[0].reasons, ['vector']);
  const mismatch = await new TextbookLibrary(b.root, { ...embedding, fingerprint: 'other-config' }).search(['book'], 'semantic-only-query', new AbortController().signal);
  assert.equal(mismatch.mode, 'keyword'); assert.equal(mismatch.hits.length, 0); assert.equal(calls, 1);
  writeFileSync(join(b.dir, 'vectors.bin'), 'broken');
  const broken = await new TextbookLibrary(b.root, embedding).search(['book'], '一致收敛', new AbortController().signal);
  assert.equal(broken.mode, 'keyword'); assert.match(broken.warnings.join(), /向量文件无效/);
  writeFileSync(join(b.dir, 'chunks.json'), readFileSync(join(b.dir, 'chunks.json'), 'utf8') + ' ');
  const changed = await new TextbookLibrary(b.root).search(['book'], '一致收敛', new AbortController().signal);
  assert.equal(changed.hits.length, 0); assert.match(changed.warnings.join(), /校验失败/);
});

test('真实教材检索→提取知识点关联→增量编码记忆→换thread召回', async t => {
  const b = bookFixture(t), f = fixture();
  try {
    f.engine.updateCourse('web:admin', { ...f.store.course('math')!, textbookIds: ['book'] }, 1);
    const memory = new MemoryService(f.engine, { fingerprint: 'full-config-v1', dimensions: 2, encode: async () => [1, 0] });
    const builder = new ContextBuilder(memory, new TextbookLibrary(b.root, memory.embedding));
    const e = f.receive('一致收敛定义还不懂'), task = f.engine.createTask(e.id, 'qa', e.text), run = f.engine.claim(task.id)!;
    await builder.build(run, new AbortController().signal);
    assert.ok(run.knowledgeAnchors!.length);
    f.engine.finish(run, '结合定义解释');
    const updater = new MemoryUpdater(f.engine, { complete: async () => JSON.stringify({ memories: [{
      kind: 'episode', observation: '学生对一致收敛定义提出疑问', outcome: '等待新的练习验证',
      topics: ['一致收敛'], anchors: run.knowledgeAnchors, sources: [{ eventId: e.id, quote: e.text }],
    }] }) }, memory);
    await updater.step(); await updater.step();
    const card = f.engine.memory.list('math')[0];
    assert.deepEqual(f.engine.memory.vector(card, 'full-config-v1'), [1, 0]);
    const next = f.receive('现在这个极限如何处理'), nextTask = f.engine.createTask(next.id, 'qa', next.text);
    const context = await builder.build(f.engine.claim(nextTask.id)!, new AbortController().signal);
    assert.equal(context.studentMemory.hits[0].id, card.id);
    assert.ok(context.studentMemory.hits[0].reasons.includes('exact-anchor'));
  } finally { f.store.close(); }
});

test('HTTP Embedding适配器区分查询前缀与文档编码，并验证向量维数', async () => {
  const inputs: string[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    inputs.push(JSON.parse(raw).input);
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ embedding: [1, 0] }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const embedding = new HttpEmbedding({ url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/embeddings', apiKey: '', model: 'fixture', fingerprint: 'full-config', dimensions: 2, queryPrefix: 'Query: ' });
    assert.deepEqual(await embedding.encode('问题', 'query', new AbortController().signal), [1, 0]);
    await embedding.encode('记忆', 'document', new AbortController().signal);
    assert.deepEqual(inputs, ['Query: 问题', '记忆']);
    embedding.dimensions = 3;
    await assert.rejects(embedding.encode('问题', 'query', new AbortController().signal), /向量无效/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
