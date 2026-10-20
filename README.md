# Multi-tenant Hybrid Search

[![CI](https://github.com/angelmidnighttt/multi-tenant-hybrid-search/actions/workflows/ci.yml/badge.svg)](https://github.com/angelmidnighttt/multi-tenant-hybrid-search/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Multi-tenant search on PostgreSQL: **Row-Level Security** for tenant isolation,
**pgvector** for semantic search, and **BM25** for keyword ranking, fused into
one hybrid ranking. Built with plain Node.js (`node:http`, no framework) and
TypeScript executed directly by Node, without a build step.

> **Status: work in progress.** The database schema, tenant isolation, the
> Node.js foundation, JWT authentication, document ingestion, background
> embeddings, and BM25 keyword search are done and tested. Vector and hybrid
> search are next (see [Roadmap](#roadmap)).

## Why this design

Every tenant's data lives in **shared tables** with a `tenant_id` column.
PostgreSQL RLS policies filter every query to the current tenant, so isolation
is enforced by the database rather than by every `WHERE` clause in the app.

RLS is only as safe as the details around it. This project handles them as
follows:

| Pitfall | How it is handled |
|---|---|
| Table owners and superusers bypass RLS | The app connects as `app_user` (not the owner, `NOBYPASSRLS`). Tables use `FORCE ROW LEVEL SECURITY`. The app refuses to start if its role can bypass RLS. |
| Connection pools leak session state | The tenant is set with `set_config('app.tenant_id', $1, true)` and is **transaction-local**. A connection returned to the pool carries no tenant. |
| Forgetting to set the tenant | If no tenant is set, the policy compares against `NULL`, so queries return 0 rows and writes are rejected (fails closed). |
| Foreign key checks bypass RLS | Foreign keys are composite `(tenant_id, id)`, so a row can never reference another tenant's row. |
| Unique violations reveal other tenants' data | Every `UNIQUE` constraint includes `tenant_id`. |
| Global BM25 statistics leak across tenants | IDF and average document length are computed **per tenant**, at query time. |
| A background worker must see every tenant's pending work | The embedding queue has no direct privileges for any role. It is reachable only through `SECURITY DEFINER` functions, and only `claim_embedding_jobs()` crosses tenants, returning ids only. Chunk content is still read and written through `withTenant()`. |

Two measured findings shape the design:

- **Under RLS, PostgreSQL does not use the GIN full-text index**, because the
  `@@` operator is not `LEAKPROOF`. With `FORCE ROW LEVEL SECURITY` this holds
  even for the table owner. BM25 therefore runs in `app.bm25_search()`, a
  `SECURITY DEFINER` function owned by `app_search`: a `NOLOGIN` role with
  `BYPASSRLS` whose only privilege is `SELECT` on chunks, and which no other role
  can become. The function filters by tenant explicitly and returns only
  `(chunk_id, score)`. Titles and content are then read through RLS, so even a
  bug in the function could not expose another tenant's text.
- **HNSW + tenant filter is a post-filter**, so small tenants can get poor
  recall. This will be addressed in the vector search step.

## Requirements

- Docker (with Docker Compose)
- Node.js **22.18+**. The app's `.ts` files run directly through Node's type
  stripping.

## Quick start

```bash
git clone https://github.com/angelmidnighttt/multi-tenant-hybrid-search.git
cd multi-tenant-hybrid-search

# 1. Database secrets (used by docker compose only)
cp .env.example .env
#    -> edit .env and set POSTGRES_PASSWORD and APP_DB_PASSWORD

# 2. App config. The app gets its own file so it never sees the superuser password.
cp app.env.example app.env
#    -> put the same APP_DB_PASSWORD into DATABASE_URL
#    -> set JWT_SECRET to a random value (the app refuses to start with the placeholder):
#       node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

# 3. Install and start the containers
npm install
npm run up           # PostgreSQL 17 + pgvector (applies db/init/*.sql) and Ollama
npm run models:pull  # one time: downloads the bge-m3 embedding model (~1.2 GB)

# 4. Run the API and the embedding worker (two terminals)
npm run dev          # API with --watch
npm run worker       # embeds new chunks in the background

curl http://localhost:3000/health
# {"status":"ok"}
```

### Create a tenant

Creating tenants is an admin operation. It runs as the superuser, never as
`app_user`:

```bash
docker exec -it hybrid-search-db psql -U postgres -d hybrid_search -c \
  "INSERT INTO app.tenants (slug, name) VALUES ('acme', 'Acme Corp') RETURNING id;"
```

### Call the API as that tenant

Requests are authenticated with a JWT (HS256). The tenant is taken **only**
from the token's `tenant_id` claim, never from the URL or the body. For local
development, mint a token with the secret from `app.env`:

```bash
TOKEN=$(npm run -s token -- <tenant-id> --sub alice --ttl 1h)

curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/me
# {"subject":"alice","tenant":{"id":"<tenant-id>","slug":"acme","name":"Acme Corp"}}
```

In production, tokens come from your identity provider. They must be signed
with HS256 using `JWT_SECRET`, and must carry `sub`, `tenant_id` (UUID), `exp`,
and the configured `iss` and `aud`. Every other token gets a `401`: expired,
unsigned (`alg: none`), signed with another algorithm, tampered with, or with a
wrong issuer or audience. A valid token whose tenant no longer exists gets a
`403`.

### Add a document

```bash
cat > document.json <<'EOF'
{
  "external_id": "tuition-policy-2026",
  "title": "Quy chế học phí 2026",
  "content": "Điều 1. Sinh viên đạt loại giỏi được xét miễn học phí.\n\nĐiều 2. Hồ sơ nộp tại phòng đào tạo.",
  "source_uri": "https://example.com/tuition-policy",
  "metadata": { "year": 2026 }
}
EOF

curl -X POST http://localhost:3000/documents \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data-binary @document.json
# 202 {"id":"1","external_id":"tuition-policy-2026","replaced":false,"chunk_count":1,"embedding_status":"pending"}
```

| Field | Required | Notes |
|---|---|---|
| `title` | yes | Up to 500 characters |
| `content` | yes | Plain text. Paragraphs are separated by blank lines. |
| `external_id` | no | Your own id, up to 200 characters. Sending an existing `external_id` again **replaces** that document and its chunks (`"replaced": true`, same `id`), so re-ingesting is idempotent. Ids are scoped per tenant. |
| `source_uri` | no | Up to 2000 characters |
| `metadata` | no | Any JSON object |

Any other field is rejected with `400`. In particular, `tenant_id` cannot be
sent: the tenant always comes from the token.

The content is split into chunks of at most **250 words** that never end
mid-sentence. Each chunk repeats up to **40 words** from the end of the previous
chunk, so a passage that spans a boundary is still found. Chunks are searchable
by keyword immediately. The response is `202` because embeddings are computed
afterwards (`embedding_status: "pending"`).

> **Windows tip:** send non-ASCII text from a file (`--data-binary @file.json`)
> rather than inline (`-d '...'`). Command-line arguments can be re-encoded by
> the console code page, which turns Vietnamese characters into `?`.

### Embeddings

`npm run worker` runs separately from the API. Ingesting a document queues an
embedding job in the same transaction, so a stored document always has its
job. The worker then repeats this loop:

1. **Claim** up to 5 ready jobs across all tenants (`FOR UPDATE SKIP LOCKED`,
   with a 5-minute lease, so several workers can run side by side).
2. For each job, inside `withTenant(job.tenant)`, **read** the chunks that have
   no embedding yet.
3. **Embed** them with Ollama in batches of 16. This happens outside any
   transaction, so no database connection is held during the slow model call.
4. **Write** each batch in its own short transaction, so progress survives a
   failure and a retry only embeds what is left. Then **finish** the job.

A failed job is retried after 30 s, 1 min, 2 min, and 4 min. The fifth failure
is final, and the error is kept in `last_error`. If a document is re-ingested
while its job is being processed, the job's `generation` changes. The old run
cannot finish it, so the new chunks are embedded too. Vectors with the wrong
number of dimensions (a misconfigured `EMBEDDING_MODEL`) fail the job instead
of being stored.

The worker refuses to start if Ollama is unreachable or the model has not been
pulled. On `Ctrl+C` it finishes the current round and exits; press it twice to
quit immediately.

### Search

```bash
curl -G http://localhost:3000/search -H "Authorization: Bearer $TOKEN" \
  --data-urlencode "q=học phí" --data-urlencode "mode=bm25" --data-urlencode "limit=3"
# 200 {"mode":"bm25","results":[
#   {"chunk_id":"1","document_id":"1","title":"Quy chế học phí","content":"...","score":2.347}, ...]}
```

| Parameter | Default | Notes |
|---|---|---|
| `q` | (required) | Up to 500 characters. Diacritics are optional: `hoc phi` matches `học phí`. |
| `mode` | `bm25` | `vector` and `hybrid` come in the next steps |
| `limit` | `10` | 1 to 50 |

BM25 ranking works like Lucene's: `k1 = 1.2`, `b = 0.75`, and
`idf = ln(1 + (N − df + 0.5) / (df + 0.5))`. A chunk matching **any** query word
is a candidate. Chunks that match more words, rarer words, or the same word more
often rank higher. `N`, the average chunk length, and each `df` are computed at
query time from **the caller's tenant only**, so they are always exact and no
other tenant's data affects the ranking.

BM25 matches words, not meaning, and Vietnamese is matched syllable by syllable.
"Làm sao để không phải đóng tiền học?" finds the tuition document only through
the syllable "học", which also gives unrelated documents a score. Vector search
and the hybrid ranking (next steps) address this.

### See the isolation yourself

```bash
docker exec -it hybrid-search-db psql -h 127.0.0.1 -U app_user -d hybrid_search
```

```sql
-- No tenant set: nothing is visible
SELECT count(*) FROM documents;                       -- 0

BEGIN;
SELECT set_config('app.tenant_id', '<tenant-uuid>', true);
INSERT INTO documents (title) VALUES ('Hello');       -- tenant_id is filled in automatically
SELECT id, title FROM documents;                      -- only this tenant's rows
COMMIT;
```

## Using the database from code

All tenant data access goes through `db.withTenant()`. The connection pool
itself is not exported, so it is impossible to run a query without a tenant.

```ts
const docs = await db.withTenant(tenantId, async (tx) => {
  const { rows } = await tx.query('SELECT id, title FROM documents ORDER BY id');
  return rows; // RLS has already filtered these to tenantId
});
```

`withTenant` opens a transaction, sets the tenant, and commits, or rolls back on
error. Any attempt to use `tx` after it returns is rejected, because by then the
connection may be serving another tenant.

## Testing

```bash
npm test
```

Docker must be running. Each test file starts its own throwaway PostgreSQL
container ([Testcontainers](https://node.testcontainers.org/)) built from the
same image and `db/init/` scripts as `docker-compose.yml`, with two tenants
(A and B) seeded. The tests never touch your development database.

| File | What it proves |
|---|---|
| `test/database/rls.test.ts` | The database policies themselves, queried directly as `app_user`. Without a tenant nothing is visible. A tenant sees and changes only its own rows. Cross-tenant inserts, moves, and foreign-key links are rejected. `app_user` cannot create tenants, disable RLS, or become the `app_search` role. Vietnamese unaccented search works. |
| `test/search/search.test.ts` | BM25 scores equal an independent reference implementation. The same text scores differently in two tenants because statistics are per tenant. Diacritics are ignored, and OR semantics and the limit work. The RLS-bypassing function never returns another tenant's chunk ids, checked on its raw output, and returns nothing without a tenant. `GET /search` returns only the token's tenant and validates its parameters. |
| `test/documents/chunker.test.ts` | Chunking (no database): never exceeds the size limit, never cuts a sentence, covers all text in order, overlaps consecutive chunks, keeps paragraph breaks, and normalizes NFD to NFC. |
| `test/documents/documents.test.ts` | `POST /documents`. Documents and chunks are stored under the token's tenant. Re-sending an `external_id` replaces the document. The same `external_id` in two tenants gives two separate documents. A `tenant_id` in the body is rejected. Invalid bodies write nothing. |
| `test/auth/auth.test.ts` | The HTTP API end to end. A token for tenant A only ever returns tenant A. Every kind of bad token is rejected before any data is read: missing, expired, wrong secret, `alg: none`, HS512, tampered payload, wrong issuer or audience, missing or non-UUID `tenant_id`. |
| `test/embeddings/embeddings.test.ts` | The job queue and worker, with a fake model. Every chunk is embedded in batches and the job finishes. A claimed job is never handed out twice. A re-ingest during processing loses nothing. Failures back off and stop after 5 attempts. Successful batches are kept. Wrong vector sizes are rejected. `app_user` cannot read the queue table, cannot queue another tenant's document, and cannot finish or fail another tenant's job. |
| `test/embeddings/ollama.provider.test.ts` | The Ollama client against a stand-in HTTP server: request format, and clear errors when the model is missing or Ollama is unreachable. |
| `test/lib/with-tenant.test.ts` | The app's DB layer. It refuses to start as a role that bypasses RLS. A reused connection never leaks the previous tenant. Callbacks roll back on error. A stale `tx` is rejected, and so are non-UUID tenant ids. 200 concurrent transactions for two tenants stay isolated. |

CI runs type checking and the full suite on Node 22 and 24 for every push and
pull request. CI does not need Ollama: tests use a deterministic fake model.

## Project structure

```
db/init/                 SQL run once when the database volume is created
  001_extensions.sql     pgvector, unaccent
  002_roles.sql          app_owner (owns objects), app_user (used by the app), app_search
  003_schema.sql         tables, Vietnamese full-text config, indexes
  004_rls.sql            RLS policies and grants
  005_embedding_jobs.sql embedding job queue + its SECURITY DEFINER functions
  006_bm25_search.sql    app.bm25_search(): BM25 with per-tenant statistics
src/
  main.ts                       API entry point: config → db → auth → HTTP server
  worker.ts                     embedding worker entry point (separate process)
  config.ts                     environment variable loading and validation
  routes.ts                     route table: which handler serves which path
  lib/                          shared infrastructure, no business logic
    db.ts                       connection pool + withTenant() / withoutTenant()
    http.ts                     minimal node:http server: routing, JSON body, errors
    uuid.ts                     UUID validation
  auth/
    auth.ts                     JWT verification, protect() wrapper for routes
  health/
    health.handler.ts           GET /health (public)
  tenants/
    tenants.service.ts          current tenant lookup (403 if it no longer exists)
    me.handler.ts               GET /me
  documents/
    documents.handler.ts        POST /documents: HTTP in/out
    documents.validation.ts     request body validation
    documents.service.ts        upsert by external_id + chunk insert, in a tenant transaction
    chunker.ts                  sentence-aware chunking with overlap
  embeddings/
    embedding.provider.ts       EmbeddingProvider interface (1024 dimensions)
    ollama.provider.ts          Ollama /api/embed client
    embeddings.service.ts       claim → embed in batches → write → finish/fail
  search/
    search.handler.ts           GET /search: HTTP in/out
    search.validation.ts        query string validation (q, mode, limit)
    search.service.ts           calls app.bm25_search(), reads titles/content through RLS
scripts/
  token.ts                      dev helper: mint a JWT for a tenant
test/                           mirrors src/
  helpers/db.ts                 starts a throwaway database and seeds tenants A and B
  helpers/server.ts             starts the real app on a random port, signs test tokens
  helpers/fake-embeddings.ts    deterministic fake embedding model
  database/rls.test.ts          database-level isolation
  lib/with-tenant.test.ts       withTenant() isolation
  auth/auth.test.ts             HTTP + JWT
  documents/chunker.test.ts     chunking (no database)
  documents/documents.test.ts   ingestion
  embeddings/*.test.ts          job queue, worker, Ollama client
  search/search.test.ts         BM25 scoring, isolation, GET /search
.github/workflows/ci.yml        type check + tests on Node 22 and 24
docker-compose.yml              PostgreSQL 17 + pgvector 0.8.1, Ollama 0.35.1 (CPU)
```

Each feature lives in its own folder and follows the same split: a
`*.handler.ts` turns HTTP into a function call, a `*.service.ts` holds the
logic and SQL (always inside `db.withTenant()`), and a `*.validation.ts`
checks input. `lib/` holds infrastructure that knows nothing about features.

### Data model

| Table | Purpose |
|---|---|
| `tenants` | One row per customer. A tenant can only read its own row. |
| `documents` | Source documents (title, source URI, metadata). |
| `chunks` | The unit of search. Each chunk has its text, a generated `tsv` for BM25, `token_count` (document length), and a `vector(1024)` embedding. |
| `embedding_jobs` | One pending embedding job per document: attempts, backoff, lease, last error. No direct access; see [Embeddings](#embeddings). |

Full-text search uses a custom `app.vn_unaccent` configuration (whitespace
tokenization + diacritic removal), so `hoc sinh` matches `học sinh`.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Run the API and restart on file changes |
| `npm start` | Run the API |
| `npm run typecheck` | Type-check with `tsc` (no output files) |
| `npm test` | Run the test suite (requires Docker) |
| `npm run -s token -- <tenant-id>` | Print a dev JWT for a tenant (`--sub`, `--ttl` optional) |
| `npm run worker` | Run the embedding worker |
| `npm run up` | Start all containers (database + Ollama) and wait until healthy |
| `npm run db:up` | Start only the database |
| `npm run db:reset` | **Delete all database data** and recreate it from `db/init/`. Downloaded models are kept. |
| `npm run models:pull` | Download the `bge-m3` model into the Ollama container (one time) |

Scripts in `db/init/` run only when the database volume is empty. After you
change them, run `npm run db:reset`.

## Configuration

`.env` is used by docker compose:

| Variable | Description |
|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` | Superuser, for admin tasks only |
| `POSTGRES_DB` | Database name (default `hybrid_search`) |
| `APP_DB_PASSWORD` | Password assigned to `app_user` on first start |
| `DB_PORT` | Host port (default `5432`, bound to `127.0.0.1` only) |
| `OLLAMA_PORT` | Host port for Ollama (default `11434`, bound to `127.0.0.1` only) |

`app.env` is used by the Node app:

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | (required) | Must connect as `app_user` |
| `PORT` | `3000` | HTTP port |
| `DB_POOL_MAX` | `10` | Maximum pool connections |
| `DB_STATEMENT_TIMEOUT_MS` | `5000` | Per-statement timeout |
| `JWT_SECRET` | (required) | HS256 secret, at least 32 characters |
| `JWT_ISSUER` | `hybrid-search` | Required `iss` claim |
| `JWT_AUDIENCE` | `hybrid-search-api` | Required `aud` claim |
| `OLLAMA_URL` | `http://localhost:11434` | Worker only: Ollama server |
| `EMBEDDING_MODEL` | `bge-m3` | Worker only: must produce 1024-dimension vectors |

The API needs `DATABASE_URL` and `JWT_SECRET`. The worker needs `DATABASE_URL`
and the Ollama settings, but not `JWT_SECRET`.

## Roadmap

- [x] Schema, roles, and RLS policies
- [x] Docker setup (PostgreSQL 17 + pgvector)
- [x] Node.js foundation: config, `withTenant()`, HTTP server, health check
- [x] Automated isolation test suite (`node:test` + Testcontainers) and CI
- [x] Authentication: tenant taken from a verified JWT claim (`GET /me`)
- [x] Ingestion: `POST /documents`, sentence-aware chunking, idempotent re-ingest by `external_id`
- [x] Embeddings: background worker with Ollama `bge-m3`, job queue with retries
- [x] BM25 search with per-tenant statistics (`GET /search?mode=bm25`)
- [ ] Vector search with good recall for small tenants
- [ ] Hybrid search with Reciprocal Rank Fusion (RRF)
- [ ] Seed data and quality and latency benchmarks

## License

[MIT](LICENSE)
