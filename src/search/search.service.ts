import { assertValidEmbeddings, type EmbeddingProvider } from '../embeddings/embedding.provider.ts';
import type { Db, TenantTx } from '../lib/db.ts';
import { HttpError } from '../lib/http.ts';
import { currentTenant } from '../tenants/tenants.service.ts';
import { fuseRankings } from './rrf.ts';

export interface SearchResult {
  chunkId: string;
  documentId: string;
  title: string;
  content: string;
  score: number;
}

export interface HybridResult extends SearchResult {
  /** 1-based rank in the BM25 list, or null if BM25 did not return the chunk. */
  bm25Rank: number | null;
  /** 1-based rank in the vector list, or null if vector search did not return it. */
  vectorRank: number | null;
}

/** A ranking: chunk ids in order, best first, with each branch's own score. */
type Ranking = { chunkId: string; score: number }[];

// -----------------------------------------------------------------------------
// BM25
// -----------------------------------------------------------------------------

/** Keyword search ranked by BM25, using the tenant's own statistics. */
export async function searchBm25(db: Db, tenantId: string, query: string, limit: number): Promise<SearchResult[]> {
  return db.withTenant(tenantId, async (tx) => {
    await currentTenant(tx);
    const ranking = await bm25Ranking(tx, query, limit);
    return withContent(tx, ranking, (chunk, { score }) => ({ ...chunk, score }));
  });
}

/**
 * app.bm25_search() runs without RLS (to use the GIN index) and returns ids and
 * scores only. Content is always read afterwards through RLS (withContent), so
 * even a bug in the function could not return another tenant's text.
 */
async function bm25Ranking(tx: TenantTx, query: string, limit: number): Promise<Ranking> {
  const { rows } = await tx.query<{ chunk_id: string; score: number }>(
    'SELECT chunk_id, score FROM app.bm25_search($1, $2)',
    [query, limit],
  );
  return rows.map((row) => ({ chunkId: row.chunk_id, score: row.score }));
}

// -----------------------------------------------------------------------------
// Vector search
// -----------------------------------------------------------------------------
// HNSW searches the whole table and RLS filters afterwards, so for a tenant
// holding a small share of the table most candidates belong to others. Measured
// on 57k chunks (recall@10): a 50-chunk tenant got 0.01 with HNSW, 0.83 with
// iterative scans, 1.00 with an exact scan in 1.5 ms. A 50k-chunk tenant got
// 0.98 with HNSW in ~1 ms, versus 144 ms for an exact scan. Hence: exact
// search up to EXACT_SEARCH_MAX_CHUNKS, HNSW with iterative scans above.
//
// Unlike BM25, everything here runs under RLS: index ordering (ORDER BY <=>)
// is not subject to the LEAKPROOF restriction, so no RLS bypass is needed.

/** Tenants with at most this many embedded chunks get an exact (100% recall) search. */
export const EXACT_SEARCH_MAX_CHUNKS = 20_000;

export type VectorStrategy = 'exact' | 'hnsw';

export interface VectorSearchOptions {
  exactSearchMaxChunks?: number;
}

/**
 * Semantic search: the query is embedded, then chunks are ranked by cosine
 * similarity (score = 1 - cosine distance; higher is closer). Chunks whose
 * embedding is still pending are not included.
 */
export async function searchVector(
  db: Db,
  embeddings: EmbeddingProvider,
  tenantId: string,
  query: string,
  limit: number,
  options: VectorSearchOptions = {},
): Promise<{ strategy: VectorStrategy; results: SearchResult[] }> {
  // The model call happens before the transaction, so no connection is held.
  const vector = await embedQuery(embeddings, query);

  return db.withTenant(tenantId, async (tx) => {
    await currentTenant(tx);
    const { strategy, ranking } = await vectorRanking(tx, vector, limit, options);
    const results = await withContent(tx, ranking, (chunk, { score }) => ({ ...chunk, score }));
    return { strategy, results };
  });
}

async function vectorRanking(
  tx: TenantTx,
  vector: number[],
  limit: number,
  { exactSearchMaxChunks = EXACT_SEARCH_MAX_CHUNKS }: VectorSearchOptions,
): Promise<{ strategy: VectorStrategy; ranking: Ranking }> {
  const { rows: counted } = await tx.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM chunks WHERE embedding IS NOT NULL',
  );
  const strategy: VectorStrategy = counted[0]!.n <= exactSearchMaxChunks ? 'exact' : 'hnsw';

  let sql: string;
  if (strategy === 'exact') {
    // MATERIALIZED keeps the planner away from the HNSW index: the tenant's
    // chunks are fetched by tenant_id and every distance is computed.
    sql = `
      WITH candidates AS MATERIALIZED (
        SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL
      )
      SELECT id, embedding <=> $1::vector AS distance
        FROM candidates ORDER BY distance, id LIMIT $2`;
  } else {
    // Iterative scans keep walking the HNSW graph until enough rows pass the
    // RLS filter. relaxed_order may return them slightly out of order, so the
    // outer query sorts again.
    await tx.query("SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true)");
    sql = `
      WITH nearest AS MATERIALIZED (
        SELECT id, embedding <=> $1::vector AS distance
          FROM chunks WHERE embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector LIMIT $2
      )
      SELECT id, distance FROM nearest ORDER BY distance, id`;
  }

  const { rows } = await tx.query<{ id: string; distance: number }>(sql, [JSON.stringify(vector), limit]);
  return { strategy, ranking: rows.map((row) => ({ chunkId: row.id, score: 1 - row.distance })) };
}

// -----------------------------------------------------------------------------
// Hybrid search
// -----------------------------------------------------------------------------

/** How many results each branch contributes before fusion. */
export const HYBRID_DEPTH = 50;

/**
 * BM25 and vector search fused with Reciprocal Rank Fusion (see rrf.ts). Both
 * branches run in one transaction, so they see the same data. Chunks whose
 * embedding is pending can still be found through BM25. If the query cannot be
 * embedded, this fails with 503 like mode=vector.
 */
export async function searchHybrid(
  db: Db,
  embeddings: EmbeddingProvider,
  tenantId: string,
  query: string,
  limit: number,
  options: VectorSearchOptions = {},
): Promise<{ strategy: VectorStrategy; results: HybridResult[] }> {
  const vector = await embedQuery(embeddings, query);

  return db.withTenant(tenantId, async (tx) => {
    await currentTenant(tx);
    const bm25 = await bm25Ranking(tx, query, HYBRID_DEPTH);
    const { strategy, ranking: nearest } = await vectorRanking(tx, vector, HYBRID_DEPTH, options);

    const fused = fuseRankings(
      bm25.map((r) => r.chunkId),
      nearest.map((r) => r.chunkId),
    ).slice(0, limit);

    const results = await withContent(tx, fused, (chunk, f) => ({
      ...chunk,
      score: f.score,
      bm25Rank: f.bm25Rank,
      vectorRank: f.vectorRank,
    }));
    return { strategy, results };
  });
}

// -----------------------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------------------

type ChunkContent = Omit<SearchResult, 'score'>;

/**
 * Reads title and content for ranked chunk ids, through RLS, keeping the
 * ranking's order. An id the tenant cannot see is dropped.
 */
async function withContent<R extends { chunkId: string }, T>(
  tx: TenantTx,
  ranking: R[],
  build: (chunk: ChunkContent, ranked: R) => T,
): Promise<T[]> {
  if (ranking.length === 0) return [];
  const { rows } = await tx.query<{ chunk_id: string; document_id: string; title: string; content: string }>(
    `SELECT c.id AS chunk_id, c.document_id, d.title, c.content
       FROM chunks AS c
       JOIN documents AS d ON d.id = c.document_id
      WHERE c.id = ANY ($1::bigint[])`,
    [ranking.map((r) => r.chunkId)],
  );
  const byId = new Map(rows.map((row) => [row.chunk_id, row]));

  const results: T[] = [];
  for (const ranked of ranking) {
    const row = byId.get(ranked.chunkId);
    if (!row) continue;
    results.push(
      build({ chunkId: row.chunk_id, documentId: row.document_id, title: row.title, content: row.content }, ranked),
    );
  }
  return results;
}

async function embedQuery(embeddings: EmbeddingProvider, query: string): Promise<number[]> {
  try {
    const vectors = await embeddings.embed([query]);
    assertValidEmbeddings(vectors, 1);
    return vectors[0]!;
  } catch (err) {
    console.error('[search] could not embed the query:', (err as Error).message);
    throw new HttpError(503, 'embedding_unavailable', 'Vector search is temporarily unavailable');
  }
}
