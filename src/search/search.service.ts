import { assertValidEmbeddings, type EmbeddingProvider } from '../embeddings/embedding.provider.ts';
import type { Db } from '../lib/db.ts';
import { HttpError } from '../lib/http.ts';
import { currentTenant } from '../tenants/tenants.service.ts';

export interface SearchResult {
  chunkId: string;
  documentId: string;
  title: string;
  content: string;
  score: number;
}

interface ResultRow {
  chunk_id: string;
  document_id: string;
  title: string;
  content: string;
  score: number;
}

/** Keyword search ranked by BM25, using the tenant's own statistics. */
export async function searchBm25(db: Db, tenantId: string, query: string, limit: number): Promise<SearchResult[]> {
  return db.withTenant(tenantId, async (tx) => {
    await currentTenant(tx);

    // app.bm25_search() runs without RLS (to use the GIN index) and returns ids
    // and scores only. Titles and content are read here, through RLS, so even a
    // bug in the function could not return another tenant's text.
    const { rows } = await tx.query<ResultRow>(
      `SELECT r.chunk_id, c.document_id, d.title, c.content, r.score
         FROM app.bm25_search($1, $2) AS r
         JOIN chunks AS c ON c.id = r.chunk_id
         JOIN documents AS d ON d.id = c.document_id
        ORDER BY r.score DESC, r.chunk_id`,
      [query, limit],
    );
    return rows.map(toResult);
  });
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
  { exactSearchMaxChunks = EXACT_SEARCH_MAX_CHUNKS }: VectorSearchOptions = {},
): Promise<{ strategy: VectorStrategy; results: SearchResult[] }> {
  // The model call happens before the transaction, so no connection is held.
  const vector = JSON.stringify(await embedQuery(embeddings, query));

  return db.withTenant(tenantId, async (tx) => {
    await currentTenant(tx);

    const { rows: counted } = await tx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM chunks WHERE embedding IS NOT NULL',
    );
    const strategy: VectorStrategy = counted[0]!.n <= exactSearchMaxChunks ? 'exact' : 'hnsw';

    let nearest: string;
    if (strategy === 'exact') {
      // MATERIALIZED keeps the planner away from the HNSW index: the tenant's
      // chunks are fetched by tenant_id and every distance is computed.
      nearest = `
        candidates AS MATERIALIZED (
          SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL
        ),
        nearest AS (
          SELECT id, embedding <=> $1::vector AS distance
            FROM candidates ORDER BY distance LIMIT $2
        )`;
    } else {
      // Iterative scans keep walking the HNSW graph until enough rows pass the
      // RLS filter. relaxed_order may return them slightly out of order, so the
      // final query sorts again.
      await tx.query("SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true)");
      nearest = `
        nearest AS MATERIALIZED (
          SELECT id, embedding <=> $1::vector AS distance
            FROM chunks WHERE embedding IS NOT NULL
           ORDER BY embedding <=> $1::vector LIMIT $2
        )`;
    }

    const { rows } = await tx.query<ResultRow>(
      `WITH ${nearest}
       SELECT n.id AS chunk_id, c.document_id, d.title, c.content, 1 - n.distance AS score
         FROM nearest AS n
         JOIN chunks AS c ON c.id = n.id
         JOIN documents AS d ON d.id = c.document_id
        ORDER BY n.distance, n.id`,
      [vector, limit],
    );
    return { strategy, results: rows.map(toResult) };
  });
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

function toResult(row: ResultRow): SearchResult {
  return {
    chunkId: row.chunk_id,
    documentId: row.document_id,
    title: row.title,
    content: row.content,
    score: row.score,
  };
}
