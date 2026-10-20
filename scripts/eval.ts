// Measures search quality and latency on the demo data (run npm run seed first).
//
// Every question in data/eval.json is asked in the three modes, as app_user
// through the same services as GET /search (latency therefore excludes HTTP
// and JWT overhead, which is about a millisecond). Results are reduced to
// distinct documents; a question is answered at k if one of its expected
// documents is among the top k.
//
//   npm run eval
import { loadWorkerConfig } from '../src/config.ts';
import { createOllamaProvider } from '../src/embeddings/ollama.provider.ts';
import { createDb } from '../src/lib/db.ts';
import { searchBm25, searchHybrid, searchVector, type SearchResult } from '../src/search/search.service.ts';
import { readJson, withAdmin, type EvalQuery } from './admin.ts';

const LIMIT = 10;
const { queries } = readJson<{ queries: EvalQuery[] }>('data/eval.json');
const slugs = [...new Set(queries.map((q) => q.tenant))];

const config = loadWorkerConfig();
const embeddings = createOllamaProvider(config.embedding, { timeoutMs: 30_000 });
await embeddings.assertModelAvailable();

// Read-only lookups across tenants (admin): tenant ids, and which documents
// belong to which tenant, to translate results and to detect any leak.
const lookup = await withAdmin(async (client) => {
  const { rows } = await client.query<{ slug: string; tenant_id: string; document_id: string; external_id: string }>(
    `SELECT t.slug, t.id AS tenant_id, d.id AS document_id, d.external_id
       FROM app.tenants AS t JOIN app.documents AS d ON d.tenant_id = t.id
      WHERE t.slug = ANY ($1)`,
    [slugs],
  );
  const { rows: pending } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM app.chunks AS c JOIN app.tenants AS t ON t.id = c.tenant_id
      WHERE t.slug = ANY ($1) AND c.embedding IS NULL`,
    [slugs],
  );
  return { rows, pending: pending[0]!.n };
});

const tenantIdOf = new Map(lookup.rows.map((r) => [r.slug, r.tenant_id]));
const externalIdOf = new Map(lookup.rows.map((r) => [r.document_id, r.external_id]));
const documentsOf = new Map<string, Set<string>>();
for (const r of lookup.rows) documentsOf.set(r.slug, (documentsOf.get(r.slug) ?? new Set()).add(r.document_id));

const missing = slugs.filter((slug) => !tenantIdOf.has(slug));
if (missing.length > 0) throw new Error(`Tenant(s) ${missing.join(', ')} not found: run npm run seed first`);
if (lookup.pending > 0) throw new Error(`${lookup.pending} chunks are not embedded yet: run npm run worker first`);

const db = await createDb(config);
type Mode = 'bm25' | 'vector' | 'hybrid';
const search: Record<Mode, (tenantId: string, q: string) => Promise<SearchResult[]>> = {
  bm25: (tenantId, q) => searchBm25(db, tenantId, q, LIMIT),
  vector: async (tenantId, q) => (await searchVector(db, embeddings, tenantId, q, LIMIT)).results,
  hybrid: async (tenantId, q) => (await searchHybrid(db, embeddings, tenantId, q, LIMIT)).results,
};
const modes = Object.keys(search) as Mode[];

// Warm-up: the first embedding call loads the model.
await search.hybrid(tenantIdOf.get(slugs[0]!)!, 'khởi động');

interface Outcome {
  mode: Mode;
  query: EvalQuery;
  rank: number; // 1-based rank of the first expected document, Infinity if absent
  top: string | undefined;
  ms: number;
  leaks: number;
}
const outcomes: Outcome[] = [];

for (const query of queries) {
  const tenantId = tenantIdOf.get(query.tenant)!;
  const ownDocuments = documentsOf.get(query.tenant)!;
  for (const mode of modes) {
    const startedAt = performance.now();
    const results = await search[mode](tenantId, query.query);
    const ms = performance.now() - startedAt;

    const documents = [...new Set(results.map((r) => externalIdOf.get(r.documentId) ?? `?${r.documentId}`))];
    const index = documents.findIndex((id) => query.expected.includes(id));
    outcomes.push({
      mode,
      query,
      rank: index < 0 ? Infinity : index + 1,
      top: documents[0],
      ms,
      leaks: results.filter((r) => !ownDocuments.has(r.documentId)).length,
    });
  }
}
await db.close();

// -----------------------------------------------------------------------------
// Report (Markdown)
// -----------------------------------------------------------------------------
const pct = (n: number, total: number) => `${Math.round((100 * n) / total)}%`;
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
};
const of = (mode: Mode, category?: string) =>
  outcomes.filter((o) => o.mode === mode && (!category || o.query.category === category));

console.log(`\n${queries.length} questions, ${slugs.length} tenants, top ${LIMIT} results\n`);
console.log('| Mode | Hit@1 | Hit@5 | MRR@10 | p50 latency | p95 latency | Cross-tenant results |');
console.log('|---|---|---|---|---|---|---|');
for (const mode of modes) {
  const rows = of(mode);
  const mrr = rows.reduce((sum, o) => sum + (o.rank <= LIMIT ? 1 / o.rank : 0), 0) / rows.length;
  const ms = rows.map((o) => o.ms);
  console.log(
    `| ${mode} | ${pct(rows.filter((o) => o.rank === 1).length, rows.length)} | ` +
      `${pct(rows.filter((o) => o.rank <= 5).length, rows.length)} | ${mrr.toFixed(2)} | ` +
      `${percentile(ms, 50).toFixed(0)} ms | ${percentile(ms, 95).toFixed(0)} ms | ` +
      `${rows.reduce((sum, o) => sum + o.leaks, 0)} |`,
  );
}

const categories = [...new Set(queries.map((q) => q.category))];
console.log('\nHit@1 by kind of question:\n');
console.log(`| Kind | Questions | ${modes.join(' | ')} |`);
console.log(`|---|---|${modes.map(() => '---').join('|')}|`);
for (const category of categories) {
  const cells = modes.map((mode) => {
    const rows = of(mode, category);
    return pct(rows.filter((o) => o.rank === 1).length, rows.length);
  });
  console.log(`| ${category} | ${of('bm25', category).length} | ${cells.join(' | ')} |`);
}

const misses = outcomes.filter((o) => o.rank !== 1);
console.log(`\nQuestions not answered first (${misses.length}):\n`);
for (const o of misses) {
  const rank = o.rank === Infinity ? 'not found' : `rank ${o.rank}`;
  console.log(`- [${o.mode}] "${o.query.query}": expected ${o.query.expected.join('/')}, ${rank}; top was ${o.top}`);
}

if (outcomes.some((o) => o.leaks > 0)) {
  console.error('\nFAIL: results from another tenant were returned');
  process.exitCode = 1;
}
