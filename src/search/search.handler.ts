import type { AuthedHandler } from '../auth/auth.ts';
import type { Db } from '../lib/db.ts';
import { searchBm25 } from './search.service.ts';
import { parseSearchInput } from './search.validation.ts';

/** GET /search?q=...&mode=bm25&limit=10 */
export function searchHandler(db: Db): AuthedHandler {
  return async (req, auth) => {
    const { query, mode, limit } = parseSearchInput(req.query);
    const results = await searchBm25(db, auth.tenantId, query, limit);

    return {
      status: 200,
      body: {
        mode,
        results: results.map((r) => ({
          chunk_id: r.chunkId,
          document_id: r.documentId,
          title: r.title,
          content: r.content,
          score: r.score,
        })),
      },
    };
  };
}
