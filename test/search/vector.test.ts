// Vector search: ranking against brute force, both strategies (exact and
// HNSW), tenant isolation under RLS, pending chunks, and model failures.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ingestDocument } from '../../src/documents/documents.service.ts';
import { runWorkerOnce } from '../../src/embeddings/embeddings.service.ts';
import { createDb, type Db } from '../../src/lib/db.ts';
import { searchVector } from '../../src/search/search.service.ts';
import { startTestDatabase, TENANT_A, TENANT_B, testConfig, type TestDatabase } from '../helpers/db.ts';
import { createFakeProvider, TEST_WORKER_OPTIONS, type FakeProvider } from '../helpers/fake-embeddings.ts';
import { bruteForceVector } from '../helpers/reference.ts';
import { signToken, startTestServer, type TestServer } from '../helpers/server.ts';

const SHARED_TEXT = 'Quy chế học phí năm 2026'; // exists in both tenants: same vector
const CORPUS_A = [SHARED_TEXT, 'Đăng ký ký túc xá', 'Giờ mở cửa thư viện', 'Lịch thi học kỳ', 'Học bổng sinh viên giỏi'];
const CORPUS_B = [SHARED_TEXT, 'Chính sách học bổng Globex'];
const PENDING_TEXT = 'Tài liệu chưa được embed';

let testDb: TestDatabase;
let db: Db;
let server: TestServer;
let queryModel: FakeProvider; // embeds the queries of the API under test
const documentIds: Record<string, string[]> = { [TENANT_A]: [], [TENANT_B]: [] };

before(async () => {
  testDb = await startTestDatabase();
  db = await createDb(testConfig(testDb.appUrl));
  queryModel = createFakeProvider();
  server = await startTestServer(testDb.appUrl, { embeddings: queryModel });

  const ingest = async (tenantId: string, content: string) => {
    const { id } = await ingestDocument(db, tenantId, { title: `Doc: ${content}`, content, externalId: null, sourceUri: null, metadata: {} });
    documentIds[tenantId]!.push(id);
  };
  for (const content of CORPUS_A) await ingest(TENANT_A, content);
  for (const content of CORPUS_B) await ingest(TENANT_B, content);
  await runWorkerOnce(db, createFakeProvider(), TEST_WORKER_OPTIONS);
  await ingest(TENANT_A, PENDING_TEXT); // queued, never embedded
});

after(async () => {
  await server?.close();
  await db?.close();
  await testDb?.stop();
});

function assertSameRanking(actual: { content: string; score: number }[], expected: { content: string; score: number }[]) {
  assert.deepEqual(
    actual.map((r) => r.content),
    expected.map((r) => r.content),
  );
  // Vectors are stored as float4: compare scores approximately.
  actual.forEach((r, i) => assert.ok(Math.abs(r.score - expected[i]!.score) < 1e-5, `${r.content}: ${r.score}`));
}

async function search(tenantId: string, params: Record<string, string>) {
  const token = await signToken({ tenant_id: tenantId });
  const res = await fetch(`${server.url}/search?${new URLSearchParams({ mode: 'vector', ...params })}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe('GET /search?mode=vector', () => {
  it('ranks the identical chunk first, with a similarity of ~1', async () => {
    const { status, body } = await search(TENANT_A, { q: 'Đăng ký ký túc xá' });
    assert.equal(status, 200);
    assert.equal(body.mode, 'vector');
    assert.equal(body.strategy, 'exact');
    assert.equal(body.results[0].content, 'Đăng ký ký túc xá');
    assert.equal(body.results[0].title, 'Doc: Đăng ký ký túc xá');
    assert.ok(body.results[0].score > 0.9999);
  });

  it('matches an exact brute-force ranking', async () => {
    const query = 'chính sách miễn giảm cho sinh viên';
    const { body } = await search(TENANT_A, { q: query, limit: '3' });
    assertSameRanking(body.results, bruteForceVector(CORPUS_A, query, 3));
  });

  it("never returns another tenant's chunk, even one with the same vector", async () => {
    const { body } = await search(TENANT_B, { q: SHARED_TEXT, limit: '50' });
    assert.ok(body.results.length > 0);
    for (const r of body.results) assert.ok(documentIds[TENANT_B]!.includes(r.document_id), r.content);
    assert.equal(body.results[0].content, SHARED_TEXT);
  });

  it("is not crowded out by another tenant's closer chunks", async () => {
    // Only tenant A has this text (distance 0). If A's chunks were visible,
    // one would take a top-2 slot and then be dropped by the documents join
    // (which has its own RLS), leaving B with fewer results than it owns.
    const { body } = await search(TENANT_B, { q: 'Giờ mở cửa thư viện', limit: String(CORPUS_B.length) });
    assert.equal(body.results.length, CORPUS_B.length);
  });

  it('leaves out chunks whose embedding is still pending', async () => {
    const { body } = await search(TENANT_A, { q: PENDING_TEXT, limit: '50' });
    assert.equal(body.results.length, CORPUS_A.length);
    assert.ok(body.results.every((r: any) => r.content !== PENDING_TEXT));
  });

  it('returns 503 when the query cannot be embedded', async () => {
    queryModel.hook = () => {
      throw new Error('Ollama is down');
    };
    try {
      const { status, body } = await search(TENANT_A, { q: 'học phí' });
      assert.equal(status, 503);
      assert.equal(body.error.code, 'embedding_unavailable');
    } finally {
      queryModel.hook = undefined;
    }
  });

  it('returns 503 when the model returns vectors of the wrong size', async () => {
    queryModel.dimensions = 768;
    try {
      assert.equal((await search(TENANT_A, { q: 'học phí' })).status, 503);
    } finally {
      queryModel.dimensions = 1024;
    }
  });
});

describe('vector search strategies', () => {
  const query = 'học bổng và học phí';

  it('uses an exact scan up to the threshold', async () => {
    const { strategy, results } = await searchVector(db, queryModel, TENANT_A, query, 10);
    assert.equal(strategy, 'exact');
    assertSameRanking(results, bruteForceVector(CORPUS_A, query, 10));
  });

  it('uses HNSW above the threshold, with the same results and tenant', async () => {
    const opts = { exactSearchMaxChunks: 0 };
    const a = await searchVector(db, queryModel, TENANT_A, query, 10, opts);
    assert.equal(a.strategy, 'hnsw');
    assertSameRanking(a.results, bruteForceVector(CORPUS_A, query, 10));

    const b = await searchVector(db, queryModel, TENANT_B, SHARED_TEXT, 10, opts);
    assertSameRanking(b.results, bruteForceVector(CORPUS_B, SHARED_TEXT, 10));
    for (const r of b.results) assert.ok(documentIds[TENANT_B]!.includes(r.documentId));

    const crowded = await searchVector(db, queryModel, TENANT_B, 'Giờ mở cửa thư viện', CORPUS_B.length, opts);
    assert.equal(crowded.results.length, CORPUS_B.length, "not crowded out by tenant A's closer chunk");
  });

  it('respects the limit', async () => {
    assert.equal((await searchVector(db, queryModel, TENANT_A, query, 2)).results.length, 2);
  });
});
