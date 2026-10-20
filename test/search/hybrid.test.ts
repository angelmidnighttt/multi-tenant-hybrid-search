// Hybrid search: RRF math, fusion of the real BM25 and vector rankings,
// pending chunks, isolation, and model failures.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ingestDocument } from '../../src/documents/documents.service.ts';
import { runWorkerOnce } from '../../src/embeddings/embeddings.service.ts';
import { createDb, type Db } from '../../src/lib/db.ts';
import { fuseRankings } from '../../src/search/rrf.ts';
import { searchHybrid } from '../../src/search/search.service.ts';
import { startTestDatabase, TENANT_A, TENANT_B, testConfig, type TestDatabase } from '../helpers/db.ts';
import { createFakeProvider, TEST_WORKER_OPTIONS, type FakeProvider } from '../helpers/fake-embeddings.ts';
import { bruteForceVector, rankedKeys, referenceBm25, referenceRrf } from '../helpers/reference.ts';
import { signToken, startTestServer, type TestServer } from '../helpers/server.ts';

describe('fuseRankings (RRF)', () => {
  it('sums 1 / (60 + rank) over both lists', () => {
    const [top] = fuseRankings(['7', '8'], ['8']);
    assert.equal(top!.chunkId, '8');
    assert.equal(top!.score, 1 / 62 + 1 / 61);
    assert.deepEqual({ bm25: top!.bm25Rank, vector: top!.vectorRank }, { bm25: 2, vector: 1 });
  });

  it('puts a chunk found by both lists above chunks found by one', () => {
    const fused = fuseRankings(['1', '2', '3'], ['3', '4', '5']);
    assert.equal(fused[0]!.chunkId, '3');
  });

  it('breaks a tie with the better vector rank', () => {
    // Same ranks swapped: 1/61 + 1/62 for both.
    assert.deepEqual(
      fuseRankings(['1', '2'], ['2', '1']).map((f) => f.chunkId),
      ['2', '1'],
    );
    // Vector-only first beats BM25-only first.
    assert.deepEqual(
      fuseRankings(['1'], ['2']).map((f) => f.chunkId),
      ['2', '1'],
    );
  });
});

// ASCII texts so the BM25 reference can tokenize by splitting on spaces.
const CORPUS_A = [
  'mien hoc phi cho sinh vien gioi',
  'hoc phi tang tu nam sau',
  'dang ky ky tuc xa truoc thang tam',
  'thu vien mo cua tu bay gio sang',
  'hoc bong cho sinh vien xuat sac',
  'lich thi cuoi ky',
];
const PENDING_A = 'hoc phi bo sung chua embed'; // BM25 can find it, vector cannot
const CORPUS_B = ['hoc phi tang tu nam sau', 'chinh sach nghi phep', 'ho tro hoc phi khoa hoc'];

let testDb: TestDatabase;
let db: Db;
let server: TestServer;
let queryModel: FakeProvider;
const documentIds: Record<string, string[]> = { [TENANT_A]: [], [TENANT_B]: [] };

before(async () => {
  testDb = await startTestDatabase();
  db = await createDb(testConfig(testDb.appUrl));
  queryModel = createFakeProvider();
  server = await startTestServer(testDb.appUrl, { embeddings: queryModel });

  const ingest = async (tenantId: string, content: string) => {
    const { id } = await ingestDocument(db, tenantId, { title: content, content, externalId: null, sourceUri: null, metadata: {} });
    documentIds[tenantId]!.push(id);
  };
  for (const content of CORPUS_A) await ingest(TENANT_A, content);
  for (const content of CORPUS_B) await ingest(TENANT_B, content);
  await runWorkerOnce(db, createFakeProvider(), TEST_WORKER_OPTIONS);
  await ingest(TENANT_A, PENDING_A);
});

after(async () => {
  await server?.close();
  await db?.close();
  await testDb?.stop();
});

async function search(tenantId: string, params: Record<string, string>) {
  const token = await signToken({ tenant_id: tenantId });
  const res = await fetch(`${server.url}/search?${new URLSearchParams(params)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** What hybrid search must return, built only from the reference implementations. */
function expectedHybrid(bm25Corpus: string[], vectorCorpus: string[], query: string, limit: number) {
  const bm25 = rankedKeys(referenceBm25(bm25Corpus, query)).slice(0, 50);
  const vector = bruteForceVector(vectorCorpus, query, 50).map((r) => r.content);
  return referenceRrf(bm25, vector).slice(0, limit);
}

describe('GET /search (hybrid)', () => {
  const query = 'hoc phi sinh vien';

  it('is the default mode and equals RRF over the reference rankings', async () => {
    const { status, body } = await search(TENANT_A, { q: query, limit: '5' });
    const expected = expectedHybrid([...CORPUS_A, PENDING_A], CORPUS_A, query, 5);

    assert.equal(status, 200);
    assert.equal(body.mode, 'hybrid');
    assert.equal(body.strategy, 'exact');
    assert.deepEqual(
      body.results.map((r: any) => ({ content: r.content, bm25: r.bm25_rank, vector: r.vector_rank })),
      expected.map((e) => ({ content: e.key, bm25: e.bm25Rank, vector: e.vectorRank })),
    );
    body.results.forEach((r: any, i: number) => assert.ok(Math.abs(r.score - expected[i]!.score) < 1e-12));
  });

  it('reports the same ranks as mode=bm25 and mode=vector', async () => {
    const hybrid = (await search(TENANT_A, { q: query, limit: '50' })).body.results;
    const bm25 = (await search(TENANT_A, { q: query, mode: 'bm25', limit: '50' })).body.results.map((r: any) => r.chunk_id);
    const vector = (await search(TENANT_A, { q: query, mode: 'vector', limit: '50' })).body.results.map((r: any) => r.chunk_id);

    for (const r of hybrid) {
      assert.equal(r.bm25_rank, bm25.includes(r.chunk_id) ? bm25.indexOf(r.chunk_id) + 1 : null);
      assert.equal(r.vector_rank, vector.includes(r.chunk_id) ? vector.indexOf(r.chunk_id) + 1 : null);
    }
  });

  it('still finds a chunk whose embedding is pending, through BM25', async () => {
    const { body } = await search(TENANT_A, { q: 'bo sung chua embed', limit: '50' });
    const pending = body.results.find((r: any) => r.content === PENDING_A);
    assert.ok(pending, 'pending chunk is in the results');
    assert.equal(pending.vector_rank, null);
    assert.equal(pending.bm25_rank, 1);
  });

  it("only returns the token's tenant, and is not crowded out by another tenant", async () => {
    // These words exist only in tenant A. A leak in either branch would put
    // A's chunks into the fused top 3, where reading content through RLS would
    // drop them and leave B with fewer results than it owns.
    const { body } = await search(TENANT_B, { q: 'ky tuc xa thu vien lich thi', limit: String(CORPUS_B.length) });
    assert.equal(body.results.length, CORPUS_B.length);
    for (const r of body.results) assert.ok(documentIds[TENANT_B]!.includes(r.document_id));
  });

  it('returns 503 when the query cannot be embedded', async () => {
    queryModel.hook = () => {
      throw new Error('Ollama is down');
    };
    try {
      const { status, body } = await search(TENANT_A, { q: query });
      assert.equal(status, 503);
      assert.equal(body.error.code, 'embedding_unavailable');
    } finally {
      queryModel.hook = undefined;
    }
  });

  it('gives the same results with the HNSW strategy', async () => {
    const exact = await searchHybrid(db, queryModel, TENANT_A, query, 10);
    const hnsw = await searchHybrid(db, queryModel, TENANT_A, query, 10, { exactSearchMaxChunks: 0 });
    assert.equal(hnsw.strategy, 'hnsw');
    assert.deepEqual(
      hnsw.results.map((r) => r.chunkId),
      exact.results.map((r) => r.chunkId),
    );
  });
});
