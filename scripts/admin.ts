// Shared helpers for the dev scripts (seed, eval).
//
// withAdmin() connects as the SUPERUSER from .env, which the API and the
// worker never do. The scripts use it only for what app_user is not allowed
// to do: creating tenants, and looking up ids across tenants. Everything else,
// including every search, runs as app_user through the normal services.
import { readFileSync } from 'node:fs';
import pg from 'pg';

export interface DemoData {
  tenants: {
    slug: string;
    name: string;
    documents: { external_id: string; title: string; content: string }[];
  }[];
}

export interface EvalQuery {
  tenant: string;
  category: string;
  query: string;
  expected: string[];
}

/** Reads a JSON file relative to the repository root. */
export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')) as T;
}

export async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const password = process.env.POSTGRES_PASSWORD;
  if (!password) throw new Error('POSTGRES_PASSWORD is missing: these scripts read .env (see package.json)');
  const url = new URL('postgresql://localhost');
  url.username = process.env.POSTGRES_USER || 'postgres';
  url.password = password;
  url.port = process.env.DB_PORT || '5432';
  url.pathname = process.env.POSTGRES_DB || 'hybrid_search';

  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
