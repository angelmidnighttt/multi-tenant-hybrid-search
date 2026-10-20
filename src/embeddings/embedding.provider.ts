/** Must match the column type of chunks.embedding: vector(1024). */
export const EMBEDDING_DIMENSIONS = 1024;

/** Turns texts into vectors: one vector per input text, in the same order. */
export interface EmbeddingProvider {
  /** Stored in chunks.embedding_model, so chunks can be re-embedded when it changes. */
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}
