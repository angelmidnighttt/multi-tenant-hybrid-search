import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { AuthConfig, Config } from '../../src/config.ts';

// Same image and init scripts as docker-compose.yml, so tests run against the
// real schema, roles and policies.
const IMAGE = 'pgvector/pgvector:0.8.1-pg17';
const INIT_DIR = fileURLToPath(new URL('../../db/init', import.meta.url));
const APP_PASSWORD = 'test_app_password';

export const TENANT_A = '11111111-1111-1111-1111-111111111111';
export const TENANT_B = '22222222-2222-2222-2222-222222222222';

export interface TestDatabase {
  /** Connects as app_user: always subject to RLS. */
  appUrl: string;
  /** Connects as the superuser: bypasses RLS. For seeding and assertions only. */
  superUrl: string;
  stop(): Promise<void>;
}

/** Starts a fresh PostgreSQL built from db/init/*.sql, with tenants A and B created. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer(IMAGE)
    .withDatabase('hybrid_search')
    .withUsername('postgres')
    .withPassword('test_super_password')
    .withEnvironment({ APP_DB_PASSWORD: APP_PASSWORD })
    .withCopyDirectoriesToContainer([{ source: INIT_DIR, target: '/docker-entrypoint-initdb.d' }])
    .start();

  const superUrl = container.getConnectionUri();
  const appUrl = new URL(superUrl);
  appUrl.username = 'app_user';
  appUrl.password = APP_PASSWORD;

  await withClient(superUrl, (client) =>
    client.query(
      `INSERT INTO app.tenants (id, slug, name)
       VALUES ($1, 'tenant-a', 'Tenant A'), ($2, 'tenant-b', 'Tenant B')`,
      [TENANT_A, TENANT_B],
    ),
  );

  return {
    appUrl: appUrl.toString(),
    superUrl,
    stop: async () => {
      await container.stop();
    },
  };
}

export async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export const TEST_AUTH: AuthConfig = {
  jwtSecret: 'test-secret-that-is-at-least-32-characters-long',
  jwtIssuer: 'hybrid-search',
  jwtAudience: 'hybrid-search-api',
};

export function testConfig(databaseUrl: string, dbPoolMax = 5): Config {
  return { port: 0, databaseUrl, dbPoolMax, dbStatementTimeoutMs: 5000, auth: TEST_AUTH };
}
