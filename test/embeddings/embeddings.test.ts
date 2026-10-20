// Embedding job queue + worker, against a real database and a fake model.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ingestDocument } from '../../src/documents/documents.service.ts';
import { claimJobs, processJob, runWorkerOnce } from '../../src/embeddings/embeddings.service.ts';
import { createDb, type Db } from '../../src/lib/db.ts';
import { startTestDatabase, TENANT_A, TENANT_B, testConfig, withClient, type TestDatabase } from '../helpers/db.ts';
import { createFakeProvider, fakeVector, TEST_WORKER_OPTIONS } from '../helpers/fake-embeddings.ts';

// PostgreSQL error codes
const INSUFFICIENT_PRIVILEGE = '42501';
const FOREIGN_KEY_VIOLATION = '23503';
const NOT_NULL_VIOLATION = '23502';

let testDb: TestDatabase;
let db: Db;

before(async () => {
  testDb = await startTestDatabase();
  db = await createDb(testConfig(testDb.appUrl));
});

after(async () => {
  await db?.close();
  await testDb?.stop();
});

// Each test starts with an empty queue.
beforeEach(() => query('DELETE FROM app.embedding_jobs'));

/** Reads as superuser, bypassing RLS, to check what was really stored. */
const query = (sql: string, params: unknown[] = []) =>
  withClient(testDb.superUrl, async (client) => (await client.query(sql, params)).rows);

async function ingest(tenantId: string, externalId: string, content: string) {
  return ingestDocument(db, tenantId, { title: externalId, content, externalId, sourceUri: null, metadata: {} });
}

/** Text of 175 words per `units` (5-word sentences): splits into about `units` chunks. */
const longContent = (prefix: string, units: number) =>
  Array.from({ length: units * 35 }, (_, i) => `${prefix} câu số ${i + 1}.`).join(' ');

const jobOf = async (documentId: string) =>
  (await query('SELECT * FROM app.embedding_jobs WHERE document_id = $1', [documentId]))[0];

const chunksOf = (documentId: string) =>
  query(
    `SELECT id, content, embedding IS NOT NULL AS embedded, embedding_model,
            vector_dims(embedding) AS dims, embedding::text AS vector
       FROM app.chunks WHERE document_id = $1 ORDER BY chunk_index`,
    [documentId],
  );

/** Stored vectors are float4: compare the first values approximately. */
function assertVectorOf(stored: string, text: string) {
  const actual = JSON.parse(stored) as number[];
  const expected = fakeVector(text);
  for (let i = 0; i < 8; i++) assert.ok(Math.abs(actual[i]! - expected[i]!) < 1e-6, `dimension ${i}`);
}

/** Lets a job in backoff be claimed right away. */
const makeReady = (documentId: string) =>
  query('UPDATE app.embedding_jobs SET run_after = now() WHERE document_id = $1', [documentId]);

describe('embedding queue', () => {
  it('ingesting a document queues one job', async () => {
    const { id } = await ingest(TENANT_A, 'queued', 'Một tài liệu ngắn.');
    const job = await jobOf(id);
    assert.equal(job.tenant_id, TENANT_A);
    assert.equal(job.generation, 1);
    assert.equal(job.attempts, 0);
  });

  it('a claimed job is not handed out twice', async () => {
    await ingest(TENANT_A, 'lease', 'Tài liệu.');
    assert.equal((await claimJobs(db, 10, 300)).length, 1);
    assert.equal((await claimJobs(db, 10, 300)).length, 0);
  });
});

describe('embedding worker', () => {
  it('embeds every chunk in batches and finishes the job', async () => {
    const provider = createFakeProvider();
    const { id, chunkCount } = await ingest(TENANT_A, 'long', longContent('Học phí', 3));
    assert.ok(chunkCount >= 3);

    assert.equal(await runWorkerOnce(db, provider, TEST_WORKER_OPTIONS), 1);

    const chunks = await chunksOf(id);
    assert.equal(chunks.length, chunkCount);
    for (const chunk of chunks) {
      assert.equal(chunk.embedded, true);
      assert.equal(chunk.embedding_model, 'fake-embedding');
      assert.equal(chunk.dims, 1024);
      assertVectorOf(chunk.vector, chunk.content);
    }
    assert.equal(provider.calls.length, Math.ceil(chunkCount / TEST_WORKER_OPTIONS.batchSize));
    assert.equal(await jobOf(id), undefined);
  });

  it("processes every tenant's jobs, each chunk getting its own vector", async () => {
    const a = await ingest(TENANT_A, 'multi', 'Tài liệu của A.');
    const b = await ingest(TENANT_B, 'multi', 'Tài liệu của B.');

    assert.equal(await runWorkerOnce(db, createFakeProvider(), TEST_WORKER_OPTIONS), 2);

    for (const id of [a.id, b.id]) {
      const [chunk] = await chunksOf(id);
      assertVectorOf(chunk.vector, chunk.content);
    }
  });

  it('loses nothing when the document is re-ingested mid-processing', async () => {
    const provider = createFakeProvider();
    const first = await ingest(TENANT_A, 'race', 'Nội dung cũ.');
    const [job] = await claimJobs(db, 10, 300);

    // While the old chunks are being embedded, the document is replaced.
    provider.hook = async (call) => {
      if (call === 1) await ingest(TENANT_A, 'race', 'Nội dung mới.');
    };
    await processJob(db, provider, job!, 16);

    const queued = await jobOf(first.id);
    assert.equal(queued.generation, 2, 'the job for the new version must survive');

    provider.hook = undefined;
    await runWorkerOnce(db, provider, TEST_WORKER_OPTIONS);
    const [chunk] = await chunksOf(first.id);
    assert.equal(chunk.content, 'Nội dung mới.');
    assertVectorOf(chunk.vector, 'Nội dung mới.');
    assert.equal(await jobOf(first.id), undefined);
  });

  it('retries a failed job later, with backoff', async () => {
    const provider = createFakeProvider();
    provider.hook = (call) => {
      if (call === 1) throw new Error('model crashed');
    };
    const { id } = await ingest(TENANT_A, 'retry', 'Tài liệu.');

    await runWorkerOnce(db, provider, TEST_WORKER_OPTIONS);
    const job = await jobOf(id);
    assert.equal(job.attempts, 1);
    assert.equal(job.last_error, 'model crashed');
    assert.equal(job.locked_until, null);
    assert.ok(job.run_after.getTime() > Date.now() + 20_000, 'first retry waits ~30s');
    assert.equal(await runWorkerOnce(db, provider, TEST_WORKER_OPTIONS), 0, 'not retried during backoff');

    await makeReady(id);
    await runWorkerOnce(db, provider, TEST_WORKER_OPTIONS);
    assert.equal((await chunksOf(id))[0].embedded, true);
    assert.equal(await jobOf(id), undefined);
  });

  it('gives up after 5 attempts', async () => {
    const provider = createFakeProvider();
    provider.hook = () => {
      throw new Error('always failing');
    };
    const { id } = await ingest(TENANT_A, 'give-up', 'Tài liệu.');

    for (let attempt = 1; attempt <= 5; attempt++) {
      await makeReady(id);
      assert.equal(await runWorkerOnce(db, provider, TEST_WORKER_OPTIONS), 1, `attempt ${attempt}`);
    }
    const job = await jobOf(id);
    assert.equal(job.attempts, 5);
    assert.notEqual(job.failed_at, null);

    await makeReady(id);
    assert.equal(await runWorkerOnce(db, provider, TEST_WORKER_OPTIONS), 0, 'a failed job is not claimed again');
  });

  it('keeps the batches that succeeded and only retries the rest', async () => {
    const provider = createFakeProvider();
    provider.hook = (call) => {
      if (call === 2) throw new Error('second batch failed');
    };
    const { id, chunkCount } = await ingest(TENANT_A, 'partial', longContent('Một phần', 4));
    const batchSize = TEST_WORKER_OPTIONS.batchSize;

    await runWorkerOnce(db, provider, TEST_WORKER_OPTIONS);
    const embedded = (await chunksOf(id)).filter((c) => c.embedded).length;
    assert.equal(embedded, batchSize);

    await makeReady(id);
    const callsBefore = provider.calls.length;
    await runWorkerOnce(db, provider, TEST_WORKER_OPTIONS);
    const retried = provider.calls.slice(callsBefore).flat();
    assert.equal(retried.length, chunkCount - batchSize, 'only the remaining chunks are sent again');
    assert.ok((await chunksOf(id)).every((c) => c.embedded));
  });

  it('treats vectors of the wrong size as a failure, storing nothing', async () => {
    const provider = createFakeProvider();
    provider.dimensions = 768;
    const { id } = await ingest(TENANT_A, 'wrong-dims', 'Tài liệu.');

    await runWorkerOnce(db, provider, TEST_WORKER_OPTIONS);
    assert.match((await jobOf(id)).last_error, /768 dimensions, expected 1024/);
    assert.equal((await chunksOf(id))[0].embedded, false);
  });
});

describe('embedding queue isolation (as app_user)', () => {
  it('the queue table is not directly accessible', async () => {
    await assert.rejects(
      db.withTenant(TENANT_A, (tx) => tx.query('SELECT * FROM app.embedding_jobs')),
      { code: INSUFFICIENT_PRIVILEGE },
    );
    await assert.rejects(
      db.withoutTenant((tx) => tx.query('DELETE FROM app.embedding_jobs')),
      { code: INSUFFICIENT_PRIVILEGE },
    );
  });

  it("cannot queue a job for another tenant's document", async () => {
    const b = await ingest(TENANT_B, 'b-doc', 'Tài liệu của B.');
    await assert.rejects(
      db.withTenant(TENANT_A, (tx) => tx.query('SELECT app.enqueue_embedding_job($1)', [b.id])),
      { code: FOREIGN_KEY_VIOLATION },
    );
    await assert.rejects(
      db.withoutTenant((tx) => tx.query('SELECT app.enqueue_embedding_job($1)', [b.id])),
      { code: NOT_NULL_VIOLATION },
    );
  });

  it("cannot finish or fail another tenant's job", async () => {
    const a = await ingest(TENANT_A, 'a-doc', 'Tài liệu của A.');
    const before = await jobOf(a.id);

    const finished = await db.withTenant(TENANT_B, async (tx) => {
      await tx.query('SELECT app.fail_embedding_job($1, 1, $2)', [a.id, 'sabotage']);
      return (await tx.query('SELECT app.finish_embedding_job($1, 1) AS ok', [a.id])).rows[0]!.ok;
    });

    assert.equal(finished, false);
    assert.deepEqual(await jobOf(a.id), before);
  });

  it("deleting a document removes its job, even though app_user can't touch the queue", async () => {
    const a = await ingest(TENANT_A, 'deleted', 'Sẽ bị xóa.');
    await db.withTenant(TENANT_A, (tx) => tx.query('DELETE FROM documents WHERE id = $1', [a.id]));
    assert.equal(await jobOf(a.id), undefined);
  });
});
