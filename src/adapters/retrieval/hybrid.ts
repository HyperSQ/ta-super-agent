export type Ranked = { id: string; score: number };
export function terms(text: string): string[] {
  const lower = text.normalize('NFKC').toLowerCase();
  const result: string[] = [...(lower.match(/[a-z0-9_]+/g) ?? [])];
  for (const run of lower.match(/[\p{Script=Han}]+/gu) ?? []) {
    const chars = [...run]; result.push(...chars);
    for (let i = 1; i < chars.length; i++) result.push(chars[i - 1] + chars[i]);
  }
  return result;
}
export function bm25(query: string, docs: { id: string; text: string }[]): Ranked[] {
  const q = [...new Set(terms(query))], tokenized = docs.map(d => terms(d.text));
  const average = tokenized.reduce((s, t) => s + t.length, 0) / (docs.length || 1) || 1;
  const df = new Map(q.map(t => [t, tokenized.filter(tokens => tokens.includes(t)).length]));
  return docs.map((doc, i) => {
    const tokens = tokenized[i], counts = new Map<string, number>();
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
    const score = q.reduce((s, t) => {
      const tf = counts.get(t) ?? 0, n = df.get(t) ?? 0;
      return s + Math.log(1 + (docs.length - n + 0.5) / (n + 0.5)) * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * tokens.length / average));
    }, 0);
    return { id: doc.id, score };
  }).filter(d => d.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
export function validVector(v: unknown, dimensions: number): v is number[] {
  return Array.isArray(v) && v.length === dimensions && v.every(n => typeof n === 'number' && Number.isFinite(n)) && v.some(n => n !== 0);
}
export function cosine(a: number[], b: number[]): number {
  if (!validVector(a, b.length) || !validVector(b, a.length)) throw new Error('向量格式或维度不匹配');
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return dot / Math.sqrt(aa * bb);
}
export function rrf(lists: Ranked[][]): Ranked[] {
  const scores = new Map<string, number>();
  for (const list of lists) list.forEach((item, i) => scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (60 + i + 1)));
  return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
