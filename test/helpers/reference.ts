// Reference implementations, written independently of src/, that the tests
// compare the real search results against.
import { fakeVector } from './fake-embeddings.ts';

/**
 * Lucene-style BM25 over ASCII texts (tokens = split on spaces).
 * Returns content -> score for every text matching at least one query word.
 */
export function referenceBm25(corpus: string[], query: string, k1 = 1.2, b = 0.75): Map<string, number> {
  const docs = corpus.map((text) => text.split(' '));
  const avgdl = docs.reduce((sum, d) => sum + d.length, 0) / docs.length;
  const terms = [...new Set(query.split(' '))];
  const scores = new Map<string, number>();
  docs.forEach((doc, i) => {
    let score = 0;
    let matched = false;
    for (const term of terms) {
      const tf = doc.filter((token) => token === term).length;
      if (tf === 0) continue;
      matched = true;
      const df = docs.filter((d) => d.includes(term)).length;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / avgdl));
    }
    if (matched) scores.set(corpus[i]!, score);
  });
  return scores;
}

/** Texts sorted by score, best first. */
export function rankedKeys(scores: Map<string, number>): string[] {
  return [...scores].sort((x, y) => y[1] - x[1]).map(([key]) => key);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! ** 2;
    nb += b[i]! ** 2;
  }
  return dot / Math.sqrt(na * nb);
}

/** Exact cosine ranking computed from the same fake vectors as the fake model. */
export function bruteForceVector(corpus: string[], query: string, limit: number) {
  const q = fakeVector(query);
  return corpus
    .map((content) => ({ content, score: cosine(q, fakeVector(content)) }))
    .sort((x, y) => y.score - x.score)
    .slice(0, limit);
}

/** Reciprocal Rank Fusion with the documented tie-break: vector rank, then BM25 rank. */
export function referenceRrf(bm25: string[], vector: string[], k = 60) {
  const keys = [...new Set([...bm25, ...vector])];
  return keys
    .map((key) => {
      const b = bm25.indexOf(key);
      const v = vector.indexOf(key);
      return {
        key,
        score: (b < 0 ? 0 : 1 / (k + b + 1)) + (v < 0 ? 0 : 1 / (k + v + 1)),
        bm25Rank: b < 0 ? null : b + 1,
        vectorRank: v < 0 ? null : v + 1,
      };
    })
    .sort(
      (x, y) =>
        y.score - x.score ||
        (x.vectorRank ?? Infinity) - (y.vectorRank ?? Infinity) ||
        (x.bm25Rank ?? Infinity) - (y.bm25Rank ?? Infinity),
    );
}
