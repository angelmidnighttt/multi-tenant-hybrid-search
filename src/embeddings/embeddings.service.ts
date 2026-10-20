import type { Db } from '../lib/db.ts';
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from './embedding.provider.ts';

export interface EmbeddingJob {
  tenantId: string;
  documentId: string;
  /** Which version of the document was claimed (see app.embedding_jobs). */
  generation: number;
}

export interface WorkerOptions {
  /** Jobs claimed per round. */
  jobLimit: number;
  /** How long a claimed job is reserved before another worker may take it. */
  leaseSeconds: number;
  /** Chunks sent per embedding request. */
  batchSize: number;
  logger: Pick<Console, 'log' | 'error'>;
}

export const DEFAULT_WORKER_OPTIONS: WorkerOptions = {
  jobLimit: 5,
  leaseSeconds: 300,
  batchSize: 16,
  logger: console,
};

/**
 * Claims one round of jobs and processes them one by one. A failed job is
 * recorded for a later retry; it never stops the others.
 * Returns the number of jobs claimed (0 means the queue is idle).
 */
export async function runWorkerOnce(
  db: Db,
  provider: EmbeddingProvider,
  options: WorkerOptions = DEFAULT_WORKER_OPTIONS,
): Promise<number> {
  const { logger } = options;
  const jobs = await claimJobs(db, options.jobLimit, options.leaseSeconds);

  for (const job of jobs) {
    const label = `document ${job.documentId} (tenant ${job.tenantId})`;
    const startedAt = Date.now();
    try {
      const count = await processJob(db, provider, job, options.batchSize);
      logger.log(`[worker] ${label}: embedded ${count} chunks in ${Date.now() - startedAt}ms`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[worker] ${label} failed: ${message}`);
      await db
        .withTenant(job.tenantId, (tx) =>
          tx.query('SELECT app.fail_embedding_job($1, $2, $3)', [job.documentId, job.generation, message]),
        )
        // If even this fails (e.g. the DB is down), the lease expires and the
        // job is retried anyway.
        .catch((failErr: Error) => logger.error(`[worker] could not record the failure: ${failErr.message}`));
    }
  }
  return jobs.length;
}

/** Leases ready jobs across ALL tenants: the worker's only cross-tenant step. */
export async function claimJobs(db: Db, limit: number, leaseSeconds: number): Promise<EmbeddingJob[]> {
  return db.withoutTenant(async (tx) => {
    const { rows } = await tx.query<{ tenant_id: string; document_id: string; generation: number }>(
      'SELECT tenant_id, document_id, generation FROM app.claim_embedding_jobs($1, make_interval(secs => $2))',
      [limit, leaseSeconds],
    );
    return rows.map((row) => ({ tenantId: row.tenant_id, documentId: row.document_id, generation: row.generation }));
  });
}

/**
 * Embeds the chunks of one document that have no embedding yet, then finishes
 * the job. Everything tenant-related runs inside withTenant(job.tenantId).
 *
 * The slow model call never runs inside a transaction, and each batch is
 * written in its own short transaction: progress survives a failure, and a
 * retry only embeds what is left. If the document is re-ingested meanwhile,
 * the old chunk ids no longer exist (the UPDATE matches nothing) and the job
 * stays queued for the new chunks.
 *
 * Returns the number of chunks embedded.
 */
export async function processJob(
  db: Db,
  provider: EmbeddingProvider,
  job: EmbeddingJob,
  batchSize: number,
): Promise<number> {
  const pending = await db.withTenant(job.tenantId, async (tx) => {
    const { rows } = await tx.query<{ id: string; content: string }>(
      'SELECT id, content FROM chunks WHERE document_id = $1 AND embedding IS NULL ORDER BY chunk_index',
      [job.documentId],
    );
    return rows;
  });

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const vectors = await provider.embed(batch.map((chunk) => chunk.content));
    assertValidVectors(vectors, batch.length);

    await db.withTenant(job.tenantId, (tx) =>
      tx.query(
        `UPDATE chunks AS c
            SET embedding = v.embedding::vector, embedding_model = $3
           FROM unnest($1::bigint[], $2::text[]) AS v(id, embedding)
          WHERE c.id = v.id`,
        [batch.map((chunk) => chunk.id), vectors.map((vector) => JSON.stringify(vector)), provider.model],
      ),
    );
  }

  await db.withTenant(job.tenantId, (tx) =>
    tx.query('SELECT app.finish_embedding_job($1, $2)', [job.documentId, job.generation]),
  );
  return pending.length;
}

function assertValidVectors(vectors: number[][], expectedCount: number): void {
  if (vectors.length !== expectedCount) {
    throw new Error(`Embedding provider returned ${vectors.length} vectors for ${expectedCount} texts`);
  }
  for (const vector of vectors) {
    if (vector.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Embedding has ${vector.length} dimensions, expected ${EMBEDDING_DIMENSIONS}. Check EMBEDDING_MODEL.`,
      );
    }
    if (!vector.every(Number.isFinite)) throw new Error('Embedding contains non-finite values');
  }
}
