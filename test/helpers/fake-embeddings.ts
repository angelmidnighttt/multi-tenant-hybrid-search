import { createHash } from 'node:crypto';
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from '../../src/embeddings/embedding.provider.ts';
import type { WorkerOptions } from '../../src/embeddings/embeddings.service.ts';

/** Deterministic pseudo-embedding: the same text always gives the same vector. */
export function fakeVector(text: string, dimensions = EMBEDDING_DIMENSIONS): number[] {
  const values: number[] = [];
  let block = createHash('sha256').update(text).digest();
  while (values.length < dimensions) {
    for (let i = 0; i + 4 <= block.length && values.length < dimensions; i += 4) {
      values.push(block.readInt32LE(i) / 2 ** 31);
    }
    block = createHash('sha256').update(block).digest();
  }
  return values;
}

export interface FakeProvider extends EmbeddingProvider {
  /** Texts received by each embed() call, in order. */
  calls: string[][];
  /** Size of the vectors returned (set it wrong to simulate a misconfigured model). */
  dimensions: number;
  /** Runs before each embed() call (1-based call number). Throw to make the call fail. */
  hook?: (call: number, texts: string[]) => void | Promise<void>;
}

export function createFakeProvider(): FakeProvider {
  const provider: FakeProvider = {
    model: 'fake-embedding',
    calls: [],
    dimensions: EMBEDDING_DIMENSIONS,
    async embed(texts) {
      provider.calls.push(texts);
      await provider.hook?.(provider.calls.length, texts);
      return texts.map((text) => fakeVector(text, provider.dimensions));
    },
  };
  return provider;
}

const silent = { log() {}, error() {} };

/** Small batches exercise batching; no log output in test runs. */
export const TEST_WORKER_OPTIONS: WorkerOptions = { jobLimit: 10, leaseSeconds: 300, batchSize: 2, logger: silent };
