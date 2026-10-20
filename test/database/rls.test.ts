// Database-level isolation: talks to PostgreSQL directly as app_user (no
// withTenant), so it verifies the policies themselves, including what happens
// when the application forgets to set a tenant.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { startTestDatabase, TENANT_A, TENANT_B, withClient, type TestDatabase } from '../helpers/db.ts';

// PostgreSQL error codes
const INSUFFICIENT_PRIVILEGE = '42501'; // RLS violation or missing grant
const FOREIGN_KEY_VIOLATION = '23503';
const INVALID_TEXT_REPRESENTATION = '22P02';

let db: TestDatabase;
let app: pg.Client;
let docB: string;

/**
 * Runs fn in a transaction with the given tenant set (null = no tenant), then
 * rolls back so every test starts from the same seeded data.
 */
async function inTenant<T>(tenantId: string | null, fn: () => Promise<T>): Promise<T> {
  await app.query('BEGIN');
  try {
    if (tenantId) await app.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    return await fn();
  } finally {
    await app.query('ROLLBACK');
  }
}

async function seed(tenantId: string, title: string, contents: string[]): Promise<string> {
  await app.query('BEGIN');
  await app.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
  const { rows } = await app.query<{ id: string }>('INSERT INTO documents (title) VALUES ($1) RETURNING id', [title]);
  const docId = rows[0]!.id;
  for (const [index, content] of contents.entries()) {
    await app.query('INSERT INTO chunks (document_id, chunk_index, content) VALUES ($1, $2, $3)', [
      docId,
      index,
      content,
    ]);
  }
  await app.query('COMMIT');
  return docId;
}

const count = async (table: string) => Number((await app.query(`SELECT count(*) FROM ${table}`)).rows[0].count);

before(async () => {
  db = await startTestDatabase();
  app = new pg.Client({ connectionString: db.appUrl });
  await app.connect();

  await seed(TENANT_A, 'Doc A', [
    'Học sinh Đà Nẵng đạt giải nhất kỳ thi học sinh giỏi',
    'Học sinh Đà Nẵng'.normalize('NFD'), // decomposed diacritics
  ]);
  docB = await seed(TENANT_B, 'Doc B (secret)', ['Hợp đồng mật của Globex']);
});

after(async () => {
  await app?.end();
  await db?.stop();
});

describe('RLS: reads', () => {
  it('app_user is neither superuser nor BYPASSRLS', async () => {
    const { rows } = await app.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    assert.deepEqual(rows[0], { rolsuper: false, rolbypassrls: false });
  });

  it('without a tenant, nothing is visible', async () => {
    await inTenant(null, async () => {
      assert.equal(await count('documents'), 0);
      assert.equal(await count('chunks'), 0);
      assert.equal(await count('tenants'), 0);
    });
  });

  it('each tenant sees only its own rows', async () => {
    await inTenant(TENANT_A, async () => {
      assert.deepEqual((await app.query('SELECT slug FROM tenants')).rows, [{ slug: 'tenant-a' }]);
      assert.deepEqual((await app.query('SELECT title FROM documents')).rows, [{ title: 'Doc A' }]);
      assert.equal(await count('chunks'), 2);
    });
    await inTenant(TENANT_B, async () => {
      assert.deepEqual((await app.query('SELECT title FROM documents')).rows, [{ title: 'Doc B (secret)' }]);
      assert.equal(await count('chunks'), 1);
    });
  });

  it('the tenant does not survive the end of its transaction', async () => {
    await app.query('BEGIN');
    await app.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT_A]);
    await app.query('COMMIT');

    const { rows } = await app.query("SELECT current_setting('app.tenant_id', true) AS leftover");
    assert.equal(rows[0].leftover, '');
    assert.equal(await count('documents'), 0);
  });

  it('a malformed tenant id fails instead of silently matching', async () => {
    await assert.rejects(
      inTenant('not-a-uuid', () => count('documents')),
      { code: INVALID_TEXT_REPRESENTATION },
    );
  });
});

describe('RLS: writes', () => {
  it('rejects writes when no tenant is set', async () => {
    await assert.rejects(
      inTenant(null, () => app.query("INSERT INTO documents (title) VALUES ('no tenant')")),
      { code: INSUFFICIENT_PRIVILEGE },
    );
  });

  it('rejects inserting a row for another tenant', async () => {
    await assert.rejects(
      inTenant(TENANT_A, () =>
        app.query("INSERT INTO documents (tenant_id, title) VALUES ($1, 'into B')", [TENANT_B]),
      ),
      { code: INSUFFICIENT_PRIVILEGE },
    );
  });

  it('rejects moving a row to another tenant', async () => {
    await assert.rejects(
      inTenant(TENANT_A, () => app.query('UPDATE documents SET tenant_id = $1', [TENANT_B])),
      { code: INSUFFICIENT_PRIVILEGE },
    );
  });

  it("rejects attaching a chunk to another tenant's document", async () => {
    // Foreign key checks bypass RLS; only the composite (tenant_id, document_id)
    // key stops this.
    await assert.rejects(
      inTenant(TENANT_A, () =>
        app.query("INSERT INTO chunks (document_id, chunk_index, content) VALUES ($1, 99, 'hijack')", [docB]),
      ),
      { code: FOREIGN_KEY_VIOLATION },
    );
  });

  it("cannot update or delete another tenant's rows", async () => {
    await inTenant(TENANT_A, async () => {
      const updated = await app.query("UPDATE documents SET title = 'hacked' WHERE id = $1", [docB]);
      const deleted = await app.query('DELETE FROM chunks WHERE document_id = $1', [docB]);
      assert.equal(updated.rowCount, 0);
      assert.equal(deleted.rowCount, 0);
    });
    const intact = await withClient(db.superUrl, (c) =>
      c.query('SELECT title FROM app.documents WHERE id = $1', [docB]),
    );
    assert.equal(intact.rows[0].title, 'Doc B (secret)');
  });
});

describe('RLS: privileges', () => {
  it('app_user cannot create tenants', async () => {
    await assert.rejects(
      inTenant(TENANT_A, () => app.query("INSERT INTO tenants (slug, name) VALUES ('evil', 'Evil')")),
      { code: INSUFFICIENT_PRIVILEGE },
    );
  });

  it('app_user cannot turn row security off', async () => {
    await assert.rejects(
      inTenant(TENANT_A, async () => {
        await app.query('SET LOCAL row_security = off');
        return count('documents');
      }),
      { code: INSUFFICIENT_PRIVILEGE },
    );
  });

  it('app_user cannot become app_search, the role that bypasses RLS', async () => {
    await assert.rejects(
      inTenant(TENANT_A, () => app.query('SET LOCAL ROLE app_search')),
      { code: INSUFFICIENT_PRIVILEGE },
    );
  });
});

describe('Vietnamese full-text search', () => {
  it('an unaccented query matches accented and NFD text', async () => {
    await inTenant(TENANT_A, async () => {
      const { rows } = await app.query(
        "SELECT chunk_index FROM chunks WHERE tsv @@ plainto_tsquery('app.vn_unaccent', 'hoc sinh da nang') ORDER BY 1",
      );
      assert.deepEqual(rows, [{ chunk_index: 0 }, { chunk_index: 1 }]);
    });
  });

  it('token_count counts repeated tokens', async () => {
    await inTenant(TENANT_A, async () => {
      const { rows } = await app.query('SELECT token_count FROM chunks ORDER BY chunk_index');
      assert.deepEqual(rows, [{ token_count: 12 }, { token_count: 4 }]);
    });
  });
});
