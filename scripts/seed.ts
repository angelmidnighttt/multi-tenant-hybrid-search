// Loads the demo data (data/demo.json): creates the tenants, ingests their
// documents through the same service as POST /documents (as app_user), and
// embeds them with Ollama. Safe to run again: tenants are matched by slug and
// documents by external_id, so re-running replaces them.
//
//   npm run seed
import { loadWorkerConfig } from '../src/config.ts';
import { ingestDocument } from '../src/documents/documents.service.ts';
import { DEFAULT_WORKER_OPTIONS, runWorkerOnce } from '../src/embeddings/embeddings.service.ts';
import { createOllamaProvider } from '../src/embeddings/ollama.provider.ts';
import { createDb } from '../src/lib/db.ts';
import { readJson, withAdmin, type DemoData } from './admin.ts';

const data = readJson<DemoData>('data/demo.json');
const config = loadWorkerConfig();
const embeddings = createOllamaProvider(config.embedding);
await embeddings.assertModelAvailable();

// 1. Tenants: an admin operation.
const tenantIds = await withAdmin(async (client) => {
  const ids = new Map<string, string>();
  for (const tenant of data.tenants) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO app.tenants (slug, name) VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [tenant.slug, tenant.name],
    );
    ids.set(tenant.slug, rows[0]!.id);
  }
  return ids;
});

const db = await createDb(config);
try {
  // 2. Documents: as app_user, exactly like the API.
  for (const tenant of data.tenants) {
    let chunks = 0;
    for (const doc of tenant.documents) {
      const result = await ingestDocument(db, tenantIds.get(tenant.slug)!, {
        title: doc.title,
        content: doc.content,
        externalId: doc.external_id,
        sourceUri: null,
        metadata: { demo: true },
      });
      chunks += result.chunkCount;
    }
    console.log(`[seed] ${tenant.slug}: ${tenant.documents.length} documents, ${chunks} chunks`);
  }

  // 3. Embeddings: run the worker loop until the queue is empty.
  const startedAt = Date.now();
  const options = { ...DEFAULT_WORKER_OPTIONS, logger: { log() {}, error: console.error } };
  let jobs = 0;
  for (let claimed; (claimed = await runWorkerOnce(db, embeddings, options)) > 0; ) jobs += claimed;
  console.log(`[seed] embedded ${jobs} documents in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
} finally {
  await db.close();
}

const pending = await withAdmin(async (client) => {
  const { rows } = await client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM app.chunks WHERE tenant_id = ANY ($1::uuid[]) AND embedding IS NULL',
    [[...tenantIds.values()]],
  );
  return rows[0]!.n;
});
if (pending > 0) console.warn(`[seed] ${pending} chunks are still waiting for embeddings: run npm run worker`);

console.log('\nTenants:');
for (const [slug, id] of tenantIds) console.log(`  ${slug.padEnd(22)} ${id}`);
console.log('\nGet a token with: npm run -s token -- <tenant id>');
