import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TextbookReferences } from '../src/adapters/knowledge/references.ts';
import { hasFormula } from '../src/adapters/qq/math-image.ts';

test('明确章节和题号使用原文跨度，续问可沿用章节，同号题不猜测', () => {
  const root = mkdtempSync(join(tmpdir(), 'ta-references-'));
  try {
    const text = '7. 核对原文\n8. 第二题';
    const pages = JSON.stringify([{ page: 146, text }]);
    const entries = [
      { section: '16.3', number: '7', text: text.slice(0, 7), start: 0, end: 7 },
      { section: '16.3', number: '8', text: '和原文不符', start: 8, end: text.length },
      { section: '17.1', number: '7', text: text.slice(0, 7), start: 0, end: 7 },
    ].map(e => ({ ...e, type: 'exercise', page: 146, endPage: 146, sourceSpans: [{ page: 146, start: e.start, end: e.end }] }));
    const dir = join(root, 'math');
    mkdirSync(dir);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id: 'math', sourceSHA256: 'pdf' }));
    writeFileSync(join(dir, 'pages.json'), pages);
    writeFileSync(join(dir, 'references.json'), JSON.stringify({
      schemaVersion: 1, bookId: 'math', sourceSHA256: 'pdf',
      pagesSHA256: createHash('sha256').update(pages).digest('hex'), entries,
    }));
    const reader = new TextbookReferences(root);
    assert.deepEqual(reader.lookup(['math'], '16.3 T7 T8').found.map(x => [x.label, x.page]), [['16.3 T7', 146]]);
    assert.deepEqual(reader.lookup(['math'], '16.3 T7 T8').unresolved, ['16.3 T8']);
    assert.equal(reader.lookup(['math'], 'T7', ['16.3 节']).found.length, 1);
    assert.deepEqual(reader.lookup(['math'], 'T7', ['16.3 节', '17.1 节']).unresolved, ['T7']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('QQ 只对公式触发渲染，代码中的美元符号保留为文本', () => {
  assert.equal(hasFormula('行内 $x^2$'), true);
  assert.equal(hasFormula('块公式 \\[x^2\\]'), true);
  assert.equal(hasFormula('代码 \x60$A + $B\x60'), false);
});
