// HTTP-level auth: the tenant must come only from a verified token, and every
// kind of bad token must be rejected before any tenant data is read.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { UnsecuredJWT } from 'jose';
import { startTestDatabase, TENANT_A, TENANT_B, TEST_AUTH, type TestDatabase } from '../helpers/db.ts';
import { signToken, startTestServer, type TestServer } from '../helpers/server.ts';

let testDb: TestDatabase;
let server: TestServer;

before(async () => {
  testDb = await startTestDatabase();
  server = await startTestServer(testDb.appUrl);
});

after(async () => {
  await server?.close();
  await testDb?.stop();
});

async function getMe(token?: string, authorization = token && `Bearer ${token}`) {
  const res = await fetch(`${server.url}/me`, {
    headers: authorization ? { authorization } : {},
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}

async function assertRejected(token: string, message: string) {
  const { status, headers, body } = await getMe(token);
  assert.equal(status, 401, message);
  assert.equal(body.error.code, 'invalid_token', message);
  assert.equal(headers.get('www-authenticate'), 'Bearer error="invalid_token"', message);
}

describe('GET /me with a valid token', () => {
  it('returns the tenant named in the token', async () => {
    const { status, body } = await getMe(await signToken({ tenant_id: TENANT_A }));
    assert.equal(status, 200);
    assert.deepEqual(body, {
      subject: 'user-1',
      tenant: { id: TENANT_A, slug: 'tenant-a', name: 'Tenant A' },
    });
  });

  it("never returns another tenant's data", async () => {
    const { body } = await getMe(await signToken({ tenant_id: TENANT_B }));
    assert.equal(body.tenant.id, TENANT_B);
    assert.equal(body.tenant.slug, 'tenant-b');
  });

  it('returns 403 when the token outlives its tenant', async () => {
    const { status, body } = await getMe(await signToken({ tenant_id: '33333333-3333-3333-3333-333333333333' }));
    assert.equal(status, 403);
    assert.equal(body.error.code, 'unknown_tenant');
  });
});

describe('GET /me without a usable Authorization header', () => {
  it('rejects a missing header', async () => {
    const { status, headers, body } = await getMe();
    assert.equal(status, 401);
    assert.equal(body.error.code, 'missing_token');
    assert.equal(headers.get('www-authenticate'), 'Bearer');
  });

  it('rejects a non-Bearer scheme', async () => {
    const { status, body } = await getMe(undefined, 'Basic dXNlcjpwYXNz');
    assert.equal(status, 401);
    assert.equal(body.error.code, 'missing_token');
  });
});

describe('GET /me rejects bad tokens', () => {
  it('expired', async () => {
    const twoMinutesAgo = Math.floor(Date.now() / 1000) - 120; // beyond the 30s clock tolerance
    await assertRejected(await signToken({ tenant_id: TENANT_A }, { expiresIn: twoMinutesAgo }), 'expired');
  });

  it('signed with another secret', async () => {
    const token = await signToken({ tenant_id: TENANT_A }, { secret: 'another-secret-that-is-also-32-chars-long!!' });
    await assertRejected(token, 'wrong secret');
  });

  it('unsigned (alg: none)', async () => {
    const token = new UnsecuredJWT({ tenant_id: TENANT_A })
      .setSubject('user-1')
      .setIssuer(TEST_AUTH.jwtIssuer)
      .setAudience(TEST_AUTH.jwtAudience)
      .setExpirationTime('5m')
      .encode();
    await assertRejected(token, 'alg none');
  });

  it('signed with the right secret but a different algorithm (HS512)', async () => {
    await assertRejected(await signToken({ tenant_id: TENANT_A }, { alg: 'HS512' }), 'HS512');
  });

  it('payload swapped to another tenant (signature no longer matches)', async () => {
    const [header, , signature] = (await signToken({ tenant_id: TENANT_A })).split('.');
    const [, payloadB] = (await signToken({ tenant_id: TENANT_B })).split('.');
    await assertRejected(`${header}.${payloadB}.${signature}`, 'tampered payload');
  });

  it('wrong issuer or audience', async () => {
    await assertRejected(await signToken({ tenant_id: TENANT_A }, { issuer: 'someone-else' }), 'issuer');
    await assertRejected(await signToken({ tenant_id: TENANT_A }, { audience: 'another-api' }), 'audience');
  });

  it('missing or malformed tenant_id claim', async () => {
    await assertRejected(await signToken({}), 'missing tenant_id');
    await assertRejected(await signToken({ tenant_id: "x' OR 1=1 --" }), 'non-uuid tenant_id');
    await assertRejected(await signToken({ tenant_id: 42 }), 'numeric tenant_id');
  });

  it('garbage', async () => {
    await assertRejected('not.a.jwt', 'garbage');
  });
});

describe('public routes', () => {
  it('GET /health needs no token', async () => {
    const res = await fetch(`${server.url}/health`);
    assert.equal(res.status, 200);
  });
});
