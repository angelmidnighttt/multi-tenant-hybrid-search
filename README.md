# Multi-tenant Hybrid Search

[![CI](https://github.com/angelmidnighttt/multi-tenant-hybrid-search/actions/workflows/ci.yml/badge.svg)](https://github.com/angelmidnighttt/multi-tenant-hybrid-search/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Multi-tenant search on PostgreSQL: **Row-Level Security** for tenant isolation,
**pgvector** for semantic search, and **BM25** for keyword ranking, fused into
one hybrid ranking. Built with plain Node.js (`node:http`, no framework) and
TypeScript executed directly by Node, without a build step.

> **Status: work in progress.** The database schema, tenant isolation, and the
> Node.js foundation are done and tested. Ingestion, BM25, vector, and hybrid
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
| Global BM25 statistics leak across tenants | IDF and average document length are stored **per tenant**. |

There is also one finding that shapes the design:

- **Under RLS, PostgreSQL does not use the GIN full-text index**, because the
  `@@` operator is not `LEAKPROOF`. BM25 search will therefore run through a
  `SECURITY DEFINER` function that filters by tenant explicitly and returns only
  `(id, score)`. Content is then fetched through RLS.
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

# 3. Install and run
npm install
npm run db:up        # starts PostgreSQL 17 + pgvector and applies db/init/*.sql
npm run dev          # starts the API with --watch

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
| `test/rls.test.ts` | The database policies themselves, queried directly as `app_user`. Without a tenant nothing is visible. A tenant sees and changes only its own rows. Cross-tenant inserts, moves, and foreign-key links are rejected. `app_user` cannot create tenants, disable RLS, or write BM25 stats. Vietnamese unaccented search works. |
| `test/with-tenant.test.ts` | The app's DB layer. It refuses to start as a role that bypasses RLS. A reused connection never leaks the previous tenant. Callbacks roll back on error. A stale `tx` is rejected, and so are non-UUID tenant ids. 200 concurrent transactions for two tenants stay isolated. |

CI runs type checking and the full suite on Node 22 and 24 for every push and
pull request.

## Project structure

```
db/init/                 SQL run once when the database volume is created
  001_extensions.sql     pgvector, unaccent
  002_roles.sql          app_owner (owns objects), app_user (used by the app)
  003_schema.sql         tables, Vietnamese full-text config, indexes
  004_rls.sql            RLS policies and grants
src/
  main.ts                entry point, graceful shutdown
  config.ts              environment variable loading and validation
  db.ts                  connection pool + withTenant()
  http.ts                minimal node:http server: routing, JSON body, errors
  routes.ts              route table
  health.ts              GET /health
test/
  helpers/db.ts          starts a throwaway database and seeds tenants A and B
  rls.test.ts            database-level isolation tests
  with-tenant.test.ts    withTenant() isolation tests
.github/workflows/ci.yml type check + tests on Node 22 and 24
docker-compose.yml       PostgreSQL 17 + pgvector 0.8.1
```

### Data model

| Table | Purpose |
|---|---|
| `tenants` | One row per customer. A tenant can only read its own row. |
| `documents` | Source documents (title, source URI, metadata). |
| `chunks` | The unit of search. Each chunk has its text, a generated `tsv` for BM25, `token_count` (document length), and a `vector(1024)` embedding. |
| `bm25_tenant_stats` | Per-tenant chunk count and total tokens (for average document length). |
| `bm25_term_stats` | Per-tenant document frequency of each term (for IDF). |

Full-text search uses a custom `app.vn_unaccent` configuration (whitespace
tokenization + diacritic removal), so `hoc sinh` matches `học sinh`.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Run the API and restart on file changes |
| `npm start` | Run the API |
| `npm run typecheck` | Type-check with `tsc` (no output files) |
| `npm test` | Run the test suite (requires Docker) |
| `npm run db:up` | Start the database and wait until it is healthy |
| `npm run db:reset` | **Delete all data** and recreate the database from `db/init/` |

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

`app.env` is used by the Node app:

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | (required) | Must connect as `app_user` |
| `PORT` | `3000` | HTTP port |
| `DB_POOL_MAX` | `10` | Maximum pool connections |
| `DB_STATEMENT_TIMEOUT_MS` | `5000` | Per-statement timeout |

## Roadmap

- [x] Schema, roles, and RLS policies
- [x] Docker setup (PostgreSQL 17 + pgvector)
- [x] Node.js foundation: config, `withTenant()`, HTTP server, health check
- [x] Automated isolation test suite (`node:test` + Testcontainers) and CI
- [ ] Authentication: tenant taken from a verified JWT claim
- [ ] Ingestion: `POST /documents` → chunking → embeddings (Ollama `bge-m3`)
- [ ] BM25 search with per-tenant statistics
- [ ] Vector search with good recall for small tenants
- [ ] Hybrid search with Reciprocal Rank Fusion (RRF)
- [ ] Seed data and quality and latency benchmarks

## License

[MIT](LICENSE)
