import type { Db } from '../lib/db.ts';
import { currentTenant } from '../tenants/tenants.service.ts';
import { chunkText } from './chunker.ts';
import type { DocumentInput } from './documents.validation.ts';

export interface IngestResult {
  id: string;
  replaced: boolean;
  chunkCount: number;
}

/**
 * Stores a document and its chunks for a tenant.
 *
 * With an external_id that already exists in this tenant, the document is
 * replaced (title, source, metadata updated; old chunks deleted, new ones
 * inserted), so re-sending the same document is idempotent.
 */
export async function ingestDocument(db: Db, tenantId: string, input: DocumentInput): Promise<IngestResult> {
  // CPU work happens before the transaction so it does not hold a connection.
  // Validation guarantees non-blank content, so there is at least one chunk.
  const chunks = chunkText(input.content);

  return db.withTenant(tenantId, async (tx) => {
    await currentTenant(tx);

    // tenant_id is filled in by its column default (the current tenant), so
    // the conflict target can only ever match this tenant's own document.
    const { rows } = await tx.query<{ id: string; inserted: boolean }>(
      `INSERT INTO documents (external_id, title, source_uri, metadata)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, external_id) DO UPDATE
         SET title = EXCLUDED.title, source_uri = EXCLUDED.source_uri, metadata = EXCLUDED.metadata
       RETURNING id, (xmax = 0) AS inserted`,
      [input.externalId, input.title, input.sourceUri, input.metadata],
    );
    const doc = rows[0]!;
    if (!doc.inserted) await tx.query('DELETE FROM chunks WHERE document_id = $1', [doc.id]);

    await tx.query(
      `INSERT INTO chunks (document_id, chunk_index, content)
       SELECT $1, ordinality - 1, content FROM unnest($2::text[]) WITH ORDINALITY AS t(content, ordinality)`,
      [doc.id, chunks],
    );
    return { id: doc.id, replaced: !doc.inserted, chunkCount: chunks.length };
  });
}
