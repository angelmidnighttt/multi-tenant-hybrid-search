// Application-level isolation: the guarantees of createDb() / withTenant().
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createDb, type Db, type TenantTx } from '../src/db.ts';
import { startTestDatabase, TENANT_A, TENANT_B, testConfig, type TestDatabase } from './helpers/db.ts';

let testDb: TestDatabase;

before(async () => {
  testDb = await startTestDatabase();
  const db = await createDb(testConfig(testDb.appUrl));
  await db.withTenant(TENANT_A, (tx) => tx.query("INSERT INTO documents (title) VALUES ('doc A')"));
  await db.withTenant(TENANT_B, (tx) => tx.query("INSERT INTO documents (title) VALUES ('doc B')"));
  await db.close();
});

after(async () => {
  await testDb?.stop();
});

/** Opens a Db, runs fn, and always closes the pool. */
async function usingDb(poolMax: number, fn: (db: Db) => Promise<void>): Promise<void> {
  const db = await createDb(testConfig(testDb.appUrl, poolMax));
  try {
    await fn(db);
  } finally {
    await db.close();
  }
}

const visibleTitles = (db: Db, tenantId: string) =>
  db.withTenant(tenantId, async (tx) => {
    const { rows } = await tx.query<{ title: string }>('SELECT title FROM documents ORDER BY id');
    return rows.map((row) => row.title);
  });

describe('createDb', () => {
  it('refuses to start when connected as a role that bypasses RLS', async () => {
    await assert.rejects(createDb(testConfig(testDb.superUrl)), /bypasses RLS/);
  });
});

describe('withTenant', () => {
  it('never leaks the previous tenant when a connection is reused', async () => {
    // A pool of 1 forces both transactions onto the same physical connection.
    await usingDb(1, async (db) => {
      const pid = (tenantId: string) =>
        db.withTenant(tenantId, async (tx) => (await tx.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);

      const pidA = await pid(TENANT_A);
      assert.deepEqual(await visibleTitles(db, TENANT_A), ['doc A']);
      assert.deepEqual(await visibleTitles(db, TENANT_B), ['doc B']);
      assert.equal(await pid(TENANT_B), pidA);
    });
  });

  it('rolls back when the callback throws', async () => {
    await usingDb(1, async (db) => {
      await assert.rejects(
        db.withTenant(TENANT_A, async (tx) => {
          await tx.query("INSERT INTO documents (title) VALUES ('should be rolled back')");
          throw new Error('boom');
        }),
        /boom/,
      );
      assert.deepEqual(await visibleTitles(db, TENANT_A), ['doc A']);
    });
  });

  it('rejects using tx after withTenant has returned', async () => {
    await usingDb(1, async (db) => {
      let leaked: TenantTx | undefined;
      await db.withTenant(TENANT_A, async (tx) => {
        leaked = tx;
      });
      await assert.rejects(leaked!.query('SELECT 1'), /Transaction has ended/);
    });
  });

  it('rejects a tenant id that is not a UUID before touching the database', async () => {
    await usingDb(1, async (db) => {
      await assert.rejects(
        db.withTenant("x' OR 1=1 --", async () => 1),
        /not a valid UUID/,
      );
    });
  });

  it('keeps the connection usable after a failed statement', async () => {
    await usingDb(1, async (db) => {
      await assert.rejects(db.withTenant(TENANT_A, (tx) => tx.query('SELECT 1/0')), /division by zero/);
      assert.deepEqual(await visibleTitles(db, TENANT_B), ['doc B']);
    });
  });

  it('keeps concurrent transactions of different tenants isolated', async () => {
    await usingDb(5, async (db) => {
      const results = await Promise.all(
        Array.from({ length: 200 }, (_, i) => {
          const tenantId = i % 2 ? TENANT_A : TENANT_B;
          return db.withTenant(tenantId, async (tx) => {
            await tx.query('SELECT pg_sleep(random() * 0.01)');
            const { rows } = await tx.query<{ tenant_id: string }>('SELECT DISTINCT tenant_id FROM documents');
            return { tenantId, seen: rows.map((row) => row.tenant_id) };
          });
        }),
      );
      for (const { tenantId, seen } of results) assert.deepEqual(seen, [tenantId]);
    });
  });
});
