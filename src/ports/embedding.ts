/** Fingerprint identifies the entire encoding configuration, not just vector dimension. */
export interface Embedding {
  fingerprint: string;
  dimensions: number;
  encode(text: string, mode: 'query' | 'document', signal: AbortSignal): Promise<number[]>;
}
