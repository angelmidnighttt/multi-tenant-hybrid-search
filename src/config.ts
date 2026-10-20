export interface Config {
  port: number;
  /** Connection string for app_user. NEVER use a superuser here. */
  databaseUrl: string;
  dbPoolMax: number;
  dbStatementTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: positiveInt(env, 'PORT', 3000),
    databaseUrl: required(env, 'DATABASE_URL'),
    dbPoolMax: positiveInt(env, 'DB_POOL_MAX', 10),
    dbStatementTimeoutMs: positiveInt(env, 'DB_STATEMENT_TIMEOUT_MS', 5000),
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}
