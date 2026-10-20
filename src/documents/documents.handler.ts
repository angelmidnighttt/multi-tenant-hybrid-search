import type { AuthedHandler } from '../auth/auth.ts';
import type { Db } from '../lib/db.ts';
import { ingestDocument } from './documents.service.ts';
import { parseDocumentInput } from './documents.validation.ts';

/**
 * POST /documents. Chunks are searchable by BM25 immediately; embeddings are
 * computed later, hence 202 Accepted.
 */
export function createDocumentHandler(db: Db): AuthedHandler {
  return async (req, auth) => {
    const input = parseDocumentInput(req.body);
    const { id, replaced, chunkCount } = await ingestDocument(db, auth.tenantId, input);

    return {
      status: 202,
      body: {
        id,
        external_id: input.externalId,
        replaced,
        chunk_count: chunkCount,
        embedding_status: 'pending',
      },
    };
  };
}
