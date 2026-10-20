import pg from 'pg';
import type { Config } from './config.ts';

/**
 * A transaction bound to a tenant. Only exists inside withTenant(), and every
 * query run through it is filtered by RLS to tenantId.
 */
export interface TenantTx {
  readonly tenantId: string;
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}

export interface Db {
  /**
   * The ONLY way to query tenant data: borrows one connection, BEGIN, sets
   * app.tenant_id at transaction scope, runs fn, COMMIT (ROLLBACK on error),
   * then returns the connection to the pool. A returned connection carries no
   * tenant.
   */
  withTenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createDb(config: Config): Promise<Db> {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    statement_timeout: config.dbStatementTimeoutMs,
    idle_in_transaction_session_timeout: config.dbStatementTimeoutMs * 2,
    application_name: 'hybrid-search',
  });
  // Errors on idle connections (e.g. a DB restart) are emitted here; without a
  // listener the whole process crashes.
  pool.on('error', (err) => console.error('[db] idle connection error:', err.message));

  try {
    await assertRlsEnforced(pool);
  } catch (err) {
    await pool.end();
    throw err;
  }

  return {
    async withTenant(tenantId, fn) {
      if (!UUID_RE.test(tenantId)) throw new Error('tenantId is not a valid UUID');

      const client = await pool.connect();
      // Block using tx after withTenant returns: by then the connection is back
      // in the pool and may be serving another tenant's transaction.
      let open = true;
      const tx: TenantTx = {
        tenantId,
        query(text, values) {
          if (!open) {
            return Promise.reject(new Error('Transaction has ended; tx must not be used outside withTenant()'));
          }
          return client.query(text, values);
        },
      };

      let brokenConnection: Error | undefined;
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch((rollbackErr: Error) => {
          brokenConnection = rollbackErr;
        });
        throw err;
      } finally {
        open = false;
        // Passing an error to release() makes the pool destroy the connection
        // instead of reusing it.
        client.release(brokenConnection);
      }
    },

    async ping() {
      await pool.query('SELECT 1');
    },

    close: () => pool.end(),
  };
}

/** Refuse to start if the app connects as a role that can bypass RLS. */
async function assertRlsEnforced(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  );
  const role = rows[0];
  if (!role || role.rolsuper || role.rolbypassrls) {
    throw new Error(
      `Role "${role?.rolname}" bypasses RLS (superuser or BYPASSRLS). The app must connect as app_user.`,
    );
  }
}
