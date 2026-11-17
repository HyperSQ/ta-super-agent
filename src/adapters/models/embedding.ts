import type { Embedding } from '../../ports/embedding.ts';
import { validVector } from '../retrieval/hybrid.ts';

export class HttpEmbedding implements Embedding {
  fingerprint: string; dimensions: number;
  options: { url: string; apiKey: string; model: string; fingerprint: string; dimensions: number; queryPrefix: string };
  constructor(options: HttpEmbedding['options']) { this.options = options; this.fingerprint = options.fingerprint; this.dimensions = options.dimensions; }
  async encode(text: string, mode: 'query' | 'document', signal: AbortSignal): Promise<number[]> {
    const response = await fetch(this.options.url, {
      method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      headers: { 'content-type': 'application/json', ...(this.options.apiKey ? { authorization: 'Bearer ' + this.options.apiKey } : {}) },
      body: JSON.stringify({ model: this.options.model, input: (mode === 'query' ? this.options.queryPrefix : '') + text }),
    });
    if (!response.ok) throw new Error('Embedding请求失败：HTTP ' + response.status);
    const data = await response.json() as { data?: { embedding?: unknown }[] };
    const vector = data.data?.[0]?.embedding;
    if (!validVector(vector, this.dimensions)) throw new Error('Embedding返回向量无效');
    return vector;
  }
}
