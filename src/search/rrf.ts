// Reciprocal Rank Fusion (Cormack, Clarke & Büttcher, 2009).
//
//   rrf(chunk) = sum over rankings of 1 / (k + rank)
//
// Only ranks matter, so BM25 scores (unbounded) and cosine similarities (0..1)
// never need to be normalized against each other. A chunk found by both
// branches collects two terms and rises above chunks found by only one.

export const RRF_K = 60;

export interface FusedResult {
  chunkId: string;
  score: number;
  bm25Rank: number | null;
  vectorRank: number | null;
}

/**
 * Fuses two rankings of chunk ids (best first). Ties are broken by the better
 * vector rank (meaning over wording), then the better BM25 rank, then the
 * smaller chunk id, so the order is always deterministic.
 */
export function fuseRankings(bm25: string[], vector: string[], k = RRF_K): FusedResult[] {
  const fused = new Map<string, FusedResult>();
  const entry = (chunkId: string): FusedResult => {
    let result = fused.get(chunkId);
    if (!result) {
      result = { chunkId, score: 0, bm25Rank: null, vectorRank: null };
      fused.set(chunkId, result);
    }
    return result;
  };

  bm25.forEach((chunkId, i) => {
    const result = entry(chunkId);
    result.bm25Rank = i + 1;
    result.score += 1 / (k + i + 1);
  });
  vector.forEach((chunkId, i) => {
    const result = entry(chunkId);
    result.vectorRank = i + 1;
    result.score += 1 / (k + i + 1);
  });

  const rank = (r: number | null) => r ?? Infinity;
  return [...fused.values()].sort(
    (a, b) =>
      b.score - a.score ||
      rank(a.vectorRank) - rank(b.vectorRank) ||
      rank(a.bm25Rank) - rank(b.bm25Rank) ||
      (BigInt(a.chunkId) < BigInt(b.chunkId) ? -1 : 1),
  );
}
