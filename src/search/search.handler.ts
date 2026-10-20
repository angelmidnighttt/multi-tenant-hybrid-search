import type { AuthedHandler } from '../auth/auth.ts';
import type { EmbeddingProvider } from '../embeddings/embedding.provider.ts';
import type { Db } from '../lib/db.ts';
import { searchBm25, searchVector, type SearchResult } from './search.service.ts';
import { parseSearchInput } from './search.validation.ts';

/** GET /search?q=...&mode=bm25|vector&limit=10 */
export function searchHandler(db: Db, embeddings: EmbeddingProvider): AuthedHandler {
  return async (req, auth) => {
    const { query, mode, limit } = parseSearchInput(req.query);

    if (mode === 'bm25') {
      const results = await searchBm25(db, auth.tenantId, query, limit);
      return { status: 200, body: { mode, results: results.map(toJson) } };
    }

    const { strategy, results } = await searchVector(db, embeddings, auth.tenantId, query, limit);
    return { status: 200, body: { mode, strategy, results: results.map(toJson) } };
  };
}

function toJson(r: SearchResult) {
  return {
    chunk_id: r.chunkId,
    document_id: r.documentId,
    title: r.title,
    content: r.content,
    score: r.score,
  };
}
