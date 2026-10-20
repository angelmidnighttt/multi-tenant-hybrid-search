import type { AddressInfo } from 'node:net';
import { SignJWT } from 'jose';
import { createAuth } from '../../src/auth.ts';
import { createDb } from '../../src/db.ts';
import { createHttpServer } from '../../src/http.ts';
import { buildRoutes } from '../../src/routes.ts';
import { TEST_AUTH, testConfig } from './db.ts';

export interface TestServer {
  /** Base URL, e.g. http://127.0.0.1:54321 */
  url: string;
  close(): Promise<void>;
}

/** Starts the real app (all routes) on a random port against the given database. */
export async function startTestServer(appUrl: string): Promise<TestServer> {
  const db = await createDb(testConfig(appUrl));
  const server = createHttpServer(buildRoutes({ db, auth: createAuth(TEST_AUTH) }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    },
  };
}

/** Signs a valid token for the test app. Pass overrides to build invalid ones. */
export function signToken(
  claims: Record<string, unknown>,
  {
    secret = TEST_AUTH.jwtSecret,
    alg = 'HS256',
    expiresIn = '5m' as string | number,
    issuer = TEST_AUTH.jwtIssuer,
    audience = TEST_AUTH.jwtAudience,
  } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg })
    .setSubject('user-1')
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(new TextEncoder().encode(secret));
}
