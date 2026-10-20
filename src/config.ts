export interface AuthConfig {
  /** HS256 shared secret. At least 32 characters (256 bits). */
  jwtSecret: string;
  /** Expected `iss` claim. */
  jwtIssuer: string;
  /** Expected `aud` claim. */
  jwtAudience: string;
}

export interface Config {
  port: number;
  /** Connection string for app_user. NEVER use a superuser here. */
  databaseUrl: string;
  dbPoolMax: number;
  dbStatementTimeoutMs: number;
  auth: AuthConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: positiveInt(env, 'PORT', 3000),
    databaseUrl: required(env, 'DATABASE_URL'),
    dbPoolMax: positiveInt(env, 'DB_POOL_MAX', 10),
    dbStatementTimeoutMs: positiveInt(env, 'DB_STATEMENT_TIMEOUT_MS', 5000),
    auth: loadAuthConfig(env),
  };
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const jwtSecret = required(env, 'JWT_SECRET');
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  // The placeholder in app.env.example is public: anyone could sign tokens with it.
  if (jwtSecret.startsWith('change-me')) throw new Error('JWT_SECRET is still the placeholder value');
  return {
    jwtSecret,
    jwtIssuer: env.JWT_ISSUER || 'hybrid-search',
    jwtAudience: env.JWT_AUDIENCE || 'hybrid-search-api',
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
