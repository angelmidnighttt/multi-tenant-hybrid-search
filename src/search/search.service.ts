import type { Db } from '../lib/db.ts';
import { currentTenant } from '../tenants/tenants.service.ts';

export interface SearchResult {
  chunkId: string;
  documentId: string;
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
    const { rows } = await tx.query<{
      chunk_id: string;
      document_id: string;
      title: string;
      content: string;
      score: number;
    }>(
      `SELECT r.chunk_id, c.document_id, d.title, c.content, r.score
         FROM app.bm25_search($1, $2) AS r
         JOIN chunks AS c ON c.id = r.chunk_id
         JOIN documents AS d ON d.id = c.document_id
        ORDER BY r.score DESC, r.chunk_id`,
      [query, limit],
    );

    return rows.map((row) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      title: row.title,
      content: row.content,
      score: row.score,
    }));
  });
}
