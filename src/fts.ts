import type { ChunkRecord } from "./db";

// Bilingual stop words (vault is Spanish/English)
const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "it",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "and",
  "or",
  "but",
  "not",
  "with",
  "this",
  "that",
  "was",
  "are",
  "be",
  "as",
  "by",
  "from",
  "have",
  "had",
  "has",
  "he",
  "she",
  "they",
  "we",
  "you",
  "i",
  "my",
  "your",
  "his",
  "her",
  "their",
  "our",
  "its",
  "will",
  "would",
  "could",
  "should",
  "may",
  "can",
  "do",
  "did",
  "does",
  "been",
  "being",
  "el",
  "la",
  "los",
  "las",
  "un",
  "una",
  "de",
  "en",
  "y",
  "o",
  "pero",
  "no",
  "con",
  "por",
  "para",
  "que",
  "se",
  "su",
  "al",
  "del",
  "es",
  "son",
  "lo",
  "le",
  "les",
  "me",
  "te",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9áéíóúàèìòùâêîôûäëïöüñç]+/u)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

// ChunkRecord without the vector field (stored in FTS for hydrating BM25-only hits)
export type ChunkMeta = Omit<ChunkRecord, "vector">;

export interface FTSHit extends ChunkMeta {
  score: number;
}

export class FTSIndex {
  private meta = new Map<string, ChunkMeta>(); // id → chunk metadata
  private inverted = new Map<string, Map<string, number>>(); // term → docId → tf
  private docLengths = new Map<string, number>();
  private totalLength = 0;

  private readonly k1 = 1.5;
  private readonly b = 0.75;

  get size(): number {
    return this.meta.size;
  }

  add(chunk: ChunkRecord): void {
    // Remove existing entry with same id first
    this.removeById(chunk.id);

    const tokens = tokenize(chunk.text);
    if (tokens.length === 0) return;

    // Store metadata (without vector)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { vector: _v, ...meta } = chunk;
    this.meta.set(chunk.id, meta);
    this.docLengths.set(chunk.id, tokens.length);
    this.totalLength += tokens.length;

    // Build term frequency map
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

    for (const [term, freq] of tf) {
      let posting = this.inverted.get(term);
      if (!posting) {
        posting = new Map<string, number>();
        this.inverted.set(term, posting);
      }
      posting.set(chunk.id, freq);
    }
  }

  removeByFile(filePath: string): void {
    const ids: string[] = [];
    for (const [id, m] of this.meta) {
      if (m.file_path === filePath) ids.push(id);
    }
    for (const id of ids) this.removeById(id);
  }

  private removeById(id: string): void {
    const len = this.docLengths.get(id);
    if (len === undefined) return;
    this.totalLength -= len;
    this.meta.delete(id);
    this.docLengths.delete(id);
    for (const posting of this.inverted.values()) posting.delete(id);
  }

  search(query: string, limit: number): FTSHit[] {
    if (this.meta.size === 0) return [];
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0) return [];

    const N = this.meta.size;
    const avgdl = N > 0 ? this.totalLength / N : 1;
    const scores = new Map<string, number>();

    for (const term of terms) {
      const posting = this.inverted.get(term);
      if (!posting || posting.size === 0) continue;
      const df = posting.size;
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
      for (const [id, tf] of posting) {
        const dl = this.docLengths.get(id) ?? 1;
        const tfNorm = (tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * (dl / avgdl)));
        scores.set(id, (scores.get(id) ?? 0) + idf * tfNorm);
      }
    }

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id, score]) => ({ ...this.meta.get(id)!, score }));
  }

  clear(): void {
    this.meta.clear();
    this.inverted.clear();
    this.docLengths.clear();
    this.totalLength = 0;
  }

  async rebuildFromDB(db: import("./db").VectorDB): Promise<void> {
    this.clear();
    const chunks = await db.getAllChunks();
    for (const c of chunks) this.add(c);
    console.debug(`[Anamnesis] FTS index built: ${this.meta.size} chunks`);
  }
}
