export interface EmbeddingProvider {
  readonly name: string;
  readonly dimension: number;
  initialize(): Promise<void>;
  /** Embed a batch of texts. Returns one vector per text. */
  embed(texts: string[]): Promise<number[][]>;
}
