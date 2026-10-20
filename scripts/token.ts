// Development helper: mints a signed JWT for a tenant, using JWT_* from app.env.
// In production, tokens are issued by your identity provider instead.
//
//   npm run -s token -- <tenant-id> [--sub <subject>] [--ttl <duration>]
import { parseArgs } from 'node:util';
import { SignJWT } from 'jose';
import { loadAuthConfig } from '../src/config.ts';
import { isUuid } from '../src/lib/uuid.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    sub: { type: 'string', default: 'dev-user' },
    ttl: { type: 'string', default: '1h' },
  },
});

const tenantId = positionals[0];
if (!isUuid(tenantId)) {
  console.error('Usage: npm run -s token -- <tenant-id (uuid)> [--sub <subject>] [--ttl 1h]');
  process.exit(1);
}

const config = loadAuthConfig();
const token = await new SignJWT({ tenant_id: tenantId })
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject(values.sub)
  .setIssuer(config.jwtIssuer)
  .setAudience(config.jwtAudience)
  .setIssuedAt()
  .setExpirationTime(values.ttl)
  .sign(new TextEncoder().encode(config.jwtSecret));

console.log(token);
