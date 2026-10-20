/** Must match the column type of chunks.embedding: vector(1024). */
export const EMBEDDING_DIMENSIONS = 1024;

/** Turns texts into vectors: one vector per input text, in the same order. */
export interface EmbeddingProvider {
  /** Stored in chunks.embedding_model, so chunks can be re-embedded when it changes. */
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

/** Throws unless there is exactly one finite, correctly sized vector per text. */
export function assertValidEmbeddings(vectors: number[][], expectedCount: number): void {
  if (vectors.length !== expectedCount) {
    throw new Error(`Embedding provider returned ${vectors.length} vectors for ${expectedCount} texts`);
  }
  for (const vector of vectors) {
    if (vector.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Embedding has ${vector.length} dimensions, expected ${EMBEDDING_DIMENSIONS}. Check EMBEDDING_MODEL.`,
      );
    }
    if (!vector.every(Number.isFinite)) throw new Error('Embedding contains non-finite values');
  }
}
