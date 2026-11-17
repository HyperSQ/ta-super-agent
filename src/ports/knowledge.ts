export type KnowledgeHit = {
  bookId: string; bookVersion: string; chunkId: string; anchor: string;
  parentId?: string; page: number; printedPage?: string; contextStartPage: number; endPage: number; chapter: string;
  text: string; needsVisualVerification: boolean; reasons: string[];
};
export type KnowledgeResult = { hits: KnowledgeHit[]; topics: string[]; mode: 'hybrid' | 'keyword'; warnings: string[] };
export interface Knowledge {
  search(bookIds: string[], query: string, signal: AbortSignal): Promise<KnowledgeResult>;
}
