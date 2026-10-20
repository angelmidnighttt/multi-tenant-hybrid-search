// POST /documents: ingestion, replacement by external_id, and isolation.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { countWords } from '../../src/documents/chunker.ts';
import { startTestDatabase, TENANT_A, TENANT_B, withClient, type TestDatabase } from '../helpers/db.ts';
import { signToken, startTestServer, type TestServer } from '../helpers/server.ts';

let testDb: TestDatabase;
let server: TestServer;
let tokenA: string;
let tokenB: string;

before(async () => {
  testDb = await startTestDatabase();
  server = await startTestServer(testDb.appUrl);
  tokenA = await signToken({ tenant_id: TENANT_A });
  tokenB = await signToken({ tenant_id: TENANT_B });
});

after(async () => {
  await server?.close();
  await testDb?.stop();
});

async function postDocument(token: string | undefined, body: unknown, contentType = 'application/json') {
  const res = await fetch(`${server.url}/documents`, {
    method: 'POST',
    headers: { 'content-type': contentType, ...(token && { authorization: `Bearer ${token}` }) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** Reads as superuser, bypassing RLS, to check what was really stored. */
const query = (sql: string, params: unknown[] = []) =>
  withClient(testDb.superUrl, async (client) => (await client.query(sql, params)).rows);

const longText = (sentences: number) =>
  Array.from({ length: sentences }, (_, i) => `Học sinh số ${i + 1} được miễn học phí.`).join(' ');

describe('POST /documents', () => {
  it('requires a token', async () => {
    const { status } = await postDocument(undefined, { title: 't', content: 'c' });
    assert.equal(status, 401);
  });

  it("stores the document and its chunks under the token's tenant", async () => {
    const { status, body } = await postDocument(tokenA, {
      title: '  Quy chế học phí  ',
      content: 'Học sinh giỏi được miễn học phí.\n\nHồ sơ nộp tại phòng đào tạo.',
      source_uri: 'https://example.com/quy-che',
      metadata: { year: 2026 },
    });
    assert.equal(status, 202);
    assert.deepEqual(
      { ...body, id: undefined },
      { id: undefined, external_id: null, replaced: false, chunk_count: 1, embedding_status: 'pending' },
    );

    const [doc] = await query('SELECT tenant_id, title, source_uri, metadata FROM app.documents WHERE id = $1', [
      body.id,
    ]);
    assert.deepEqual(doc, {
      tenant_id: TENANT_A,
      title: 'Quy chế học phí',
      source_uri: 'https://example.com/quy-che',
      metadata: { year: 2026 },
    });

    const chunks = await query(
      `SELECT tenant_id, chunk_index, content, embedding IS NULL AS pending,
              tsv @@ plainto_tsquery('app.vn_unaccent', 'hoc phi') AS bm25_match
       FROM app.chunks WHERE document_id = $1`,
      [body.id],
    );
    assert.deepEqual(chunks, [
      {
        tenant_id: TENANT_A,
        chunk_index: 0,
        content: 'Học sinh giỏi được miễn học phí.\n\nHồ sơ nộp tại phòng đào tạo.',
        pending: true,
        bm25_match: true,
      },
    ]);
  });

  it('splits long content into ordered chunks of at most 250 words', async () => {
    const { body } = await postDocument(tokenA, { title: 'Dài', content: longText(100) }); // 800 words
    assert.ok(body.chunk_count >= 4, `${body.chunk_count} chunks`);

    const chunks = await query('SELECT chunk_index, content FROM app.chunks WHERE document_id = $1 ORDER BY 1', [
      body.id,
    ]);
    assert.deepEqual(
      chunks.map((c) => c.chunk_index),
      Array.from({ length: body.chunk_count }, (_, i) => i),
    );
    for (const chunk of chunks) assert.ok(countWords(chunk.content) <= 250);
  });

  it('replaces the document when the same external_id is sent again', async () => {
    const first = await postDocument(tokenA, { external_id: 'handbook', title: 'v1', content: 'Nội dung cũ.' });
    const second = await postDocument(tokenA, {
      external_id: 'handbook',
      title: 'v2',
      content: longText(60),
    });

    assert.equal(first.body.replaced, false);
    assert.equal(second.status, 202);
    assert.equal(second.body.replaced, true);
    assert.equal(second.body.id, first.body.id);

    const docs = await query("SELECT title FROM app.documents WHERE external_id = 'handbook'");
    assert.deepEqual(docs, [{ title: 'v2' }]);
    const chunks = await query('SELECT content FROM app.chunks WHERE document_id = $1', [first.body.id]);
    assert.equal(chunks.length, second.body.chunk_count);
    assert.ok(chunks.every((c) => !c.content.includes('Nội dung cũ')));
  });

  it('treats the same external_id in another tenant as a separate document', async () => {
    const a = await postDocument(tokenA, { external_id: 'shared-id', title: 'A version', content: 'Bản của A.' });
    const b = await postDocument(tokenB, { external_id: 'shared-id', title: 'B version', content: 'Bản của B.' });

    assert.equal(b.body.replaced, false);
    assert.notEqual(b.body.id, a.body.id);
    const docs = await query(
      "SELECT tenant_id, title FROM app.documents WHERE external_id = 'shared-id' ORDER BY title",
    );
    assert.deepEqual(docs, [
      { tenant_id: TENANT_A, title: 'A version' },
      { tenant_id: TENANT_B, title: 'B version' },
    ]);
  });

  it('does not let the client choose the tenant', async () => {
    const before = await query('SELECT count(*)::int AS n FROM app.documents WHERE tenant_id = $1', [TENANT_B]);
    const { status, body } = await postDocument(tokenA, { tenant_id: TENANT_B, title: 'x', content: 'y' });
    const after = await query('SELECT count(*)::int AS n FROM app.documents WHERE tenant_id = $1', [TENANT_B]);

    assert.equal(status, 400);
    assert.match(body.error.message, /Unknown field\(s\): tenant_id/);
    assert.deepEqual(after, before);
  });

  it('returns 403 when the token outlives its tenant', async () => {
    const token = await signToken({ tenant_id: '33333333-3333-3333-3333-333333333333' });
    const { status, body } = await postDocument(token, { title: 't', content: 'c' });
    assert.equal(status, 403);
    assert.equal(body.error.code, 'unknown_tenant');
  });

  it('rejects invalid bodies without writing anything', async () => {
    const countBefore = await query('SELECT count(*)::int AS n FROM app.documents');
    const cases: [unknown, string][] = [
      [['not', 'an', 'object'], 'array body'],
      [{ content: 'no title' }, 'missing title'],
      [{ title: 'no content' }, 'missing content'],
      [{ title: 't', content: '   \n\n  ' }, 'blank content'],
      [{ title: 'x'.repeat(501), content: 'c' }, 'title too long'],
      [{ title: 't', content: 'c', external_id: 42 }, 'non-string external_id'],
      [{ title: 't', content: 'c', metadata: [1, 2] }, 'array metadata'],
    ];
    for (const [body, label] of cases) {
      const res = await postDocument(tokenA, body);
      assert.equal(res.status, 400, label);
      assert.equal(res.body.error.code, 'invalid_body', label);
    }
    assert.equal((await postDocument(tokenA, '{"title":', 'application/json')).status, 400, 'malformed JSON');
    assert.equal((await postDocument(tokenA, 'title=t', 'text/plain')).status, 415, 'not JSON');

    assert.deepEqual(await query('SELECT count(*)::int AS n FROM app.documents'), countBefore);
  });
});
