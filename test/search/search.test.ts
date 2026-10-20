// BM25 search: scores against a reference implementation, per-tenant
// statistics, isolation of the RLS-bypassing function, and GET /search.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ingestDocument } from '../../src/documents/documents.service.ts';
import { createDb, type Db } from '../../src/lib/db.ts';
import { startTestDatabase, TENANT_A, TENANT_B, testConfig, type TestDatabase } from '../helpers/db.ts';
import { signToken, startTestServer, type TestServer } from '../helpers/server.ts';

// ASCII-only texts, so the reference tokenizer is a plain split on spaces.
const CORPUS_A = ['mien hoc phi cho sinh vien gioi', 'hoc phi tang', 'thu vien mo cua', 'hoc hoc hoc bong'];
// Same "hoc phi tang" text, but "hoc" is far more common here.
const CORPUS_B = ['hoc phi tang', ...Array.from({ length: 5 }, (_, i) => `hoc sinh lop ${i + 1}`)];

let testDb: TestDatabase;
let db: Db;
let server: TestServer;
const documentIds: Record<string, string[]> = { [TENANT_A]: [], [TENANT_B]: [] };

before(async () => {
  testDb = await startTestDatabase();
  db = await createDb(testConfig(testDb.appUrl));
  server = await startTestServer(testDb.appUrl);
  for (const [tenantId, corpus] of [
    [TENANT_A, CORPUS_A],
    [TENANT_B, CORPUS_B],
  ] as const) {
    for (const content of corpus) {
      const { id } = await ingestDocument(db, tenantId, {
        title: `Doc: ${content}`,
        content,
        externalId: null,
        sourceUri: null,
        metadata: {},
      });
      documentIds[tenantId]!.push(id);
    }
  }
});

after(async () => {
  await server?.close();
  await db?.close();
  await testDb?.stop();
});

/** Lucene-style BM25, written independently of the SQL. Returns a score per document. */
function referenceBm25(corpus: string[], query: string, k1 = 1.2, b = 0.75): Map<string, number> {
  const docs = corpus.map((text) => text.split(' '));
  const avgdl = docs.reduce((sum, d) => sum + d.length, 0) / docs.length;
  const terms = [...new Set(query.split(' '))];
  const scores = new Map<string, number>();
  docs.forEach((doc, i) => {
    let score = 0;
    let matched = false;
    for (const term of terms) {
      const tf = doc.filter((token) => token === term).length;
      if (tf === 0) continue;
      matched = true;
      const df = docs.filter((d) => d.includes(term)).length;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / avgdl));
    }
    if (matched) scores.set(corpus[i]!, score);
  });
  return scores;
}

/** Calls the SQL function as app_user and returns content -> score, in rank order. */
const bm25 = (tenantId: string, query: string, limit = 10) =>
  db.withTenant(tenantId, async (tx) => {
    const { rows } = await tx.query<{ content: string; score: number }>(
      `SELECT c.content, r.score FROM app.bm25_search($1, $2) AS r JOIN chunks AS c ON c.id = r.chunk_id
        ORDER BY r.score DESC`,
      [query, limit],
    );
    return new Map(rows.map((row) => [row.content, row.score]));
  });

function assertScoresEqual(actual: Map<string, number>, expected: Map<string, number>) {
  const ranked = [...expected].sort((x, y) => y[1] - x[1]).map(([content]) => content);
  assert.deepEqual([...actual.keys()], ranked, 'ranking');
  for (const [content, score] of expected) {
    assert.ok(Math.abs(actual.get(content)! - score) < 1e-9, `${content}: ${actual.get(content)} vs ${score}`);
  }
}

describe('app.bm25_search()', () => {
  it('matches a reference BM25 implementation, term frequency included', async () => {
    assertScoresEqual(await bm25(TENANT_A, 'hoc phi'), referenceBm25(CORPUS_A, 'hoc phi'));
  });

  it("uses each tenant's own statistics: the same text scores differently", async () => {
    const a = await bm25(TENANT_A, 'hoc phi');
    const b = await bm25(TENANT_B, 'hoc phi');
    assertScoresEqual(b, referenceBm25(CORPUS_B, 'hoc phi'));
    assert.notEqual(a.get('hoc phi tang'), b.get('hoc phi tang'));
  });

  it('ignores diacritics in the query', async () => {
    assert.deepEqual(await bm25(TENANT_A, 'Học PHÍ'), await bm25(TENANT_A, 'hoc phi'));
  });

  it('finds chunks that match any query term (OR)', async () => {
    const results = await bm25(TENANT_A, 'phi bong');
    assert.deepEqual(new Set(results.keys()), new Set(['mien hoc phi cho sinh vien gioi', 'hoc phi tang', 'hoc hoc hoc bong']));
  });

  it('respects the limit', async () => {
    assert.equal((await bm25(TENANT_A, 'hoc', 2)).size, 2);
  });

  it('returns nothing for a query without searchable words', async () => {
    assert.equal((await bm25(TENANT_A, '?! ...')).size, 0);
  });

  it("never returns another tenant's chunk ids, although it bypasses RLS", async () => {
    // Look at the function's raw output: joining it with chunks would go
    // through RLS and hide a leak instead of exposing it.
    const rawIds = (tenantId: string, query: string) =>
      db.withTenant(tenantId, async (tx) =>
        (await tx.query<{ chunk_id: string }>('SELECT chunk_id FROM app.bm25_search($1, 100)', [query])).rows.map(
          (row) => row.chunk_id,
        ),
      );
    assert.deepEqual(await rawIds(TENANT_B, 'mien gioi'), [], 'only tenant A has these words');
    assert.deepEqual(await rawIds(TENANT_A, 'lop'), [], 'only tenant B has this word');

    const ownChunks = await db.withTenant(TENANT_B, async (tx) =>
      (await tx.query<{ id: string }>('SELECT id FROM chunks')).rows.map((row) => row.id),
    );
    for (const id of await rawIds(TENANT_B, 'hoc phi mien gioi bong')) assert.ok(ownChunks.includes(id), id);
  });

  it('returns nothing when no tenant is set', async () => {
    const { rows } = await db.withoutTenant((tx) => tx.query("SELECT * FROM app.bm25_search('hoc', 10)"));
    assert.equal(rows.length, 0);
  });
});

describe('GET /search', () => {
  async function search(token: string | undefined, params: Record<string, string>) {
    const res = await fetch(`${server.url}/search?${new URLSearchParams(params)}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  it('requires a token', async () => {
    assert.equal((await search(undefined, { q: 'hoc' })).status, 401);
  });

  it("returns the tenant's best matches with title, content and score", async () => {
    const { status, body } = await search(await signToken({ tenant_id: TENANT_A }), { q: 'học phí' });

    assert.equal(status, 200);
    assert.equal(body.mode, 'bm25');
    assert.deepEqual(
      body.results.map((r: any) => r.content),
      ['hoc phi tang', 'mien hoc phi cho sinh vien gioi', 'hoc hoc hoc bong'],
    );
    const [top] = body.results;
    assert.equal(top.title, 'Doc: hoc phi tang');
    assert.ok(documentIds[TENANT_A]!.includes(top.document_id));
    assert.equal(typeof top.score, 'number');
  });

  it("only ever returns the token's tenant", async () => {
    const { body } = await search(await signToken({ tenant_id: TENANT_B }), { q: 'hoc phi mien gioi', limit: '50' });
    assert.ok(body.results.length > 0);
    for (const r of body.results) assert.ok(documentIds[TENANT_B]!.includes(r.document_id));
  });

  it('rejects invalid parameters', async () => {
    const token = await signToken({ tenant_id: TENANT_A });
    const cases: [Record<string, string>, string][] = [
      [{}, 'missing q'],
      [{ q: '   ' }, 'blank q'],
      [{ q: 'x'.repeat(501) }, 'q too long'],
      [{ q: 'hoc', mode: 'hybrid' }, 'mode not available yet'],
      [{ q: 'hoc', limit: '0' }, 'limit too small'],
      [{ q: 'hoc', limit: '51' }, 'limit too large'],
      [{ q: 'hoc', limit: 'ten' }, 'limit not a number'],
    ];
    for (const [params, label] of cases) {
      const { status, body } = await search(token, params);
      assert.equal(status, 400, label);
      assert.equal(body.error.code, 'invalid_query', label);
    }
  });

  it('returns 403 when the token outlives its tenant', async () => {
    const { status } = await search(await signToken({ tenant_id: '33333333-3333-3333-3333-333333333333' }), { q: 'hoc' });
    assert.equal(status, 403);
  });
});
