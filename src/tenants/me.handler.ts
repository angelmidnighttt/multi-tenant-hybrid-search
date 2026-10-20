import type { AuthedHandler } from '../auth/auth.ts';
import type { Db } from '../lib/db.ts';
import { currentTenant } from './tenants.service.ts';

/** GET /me: the caller and their tenant, read through RLS. */
export function meHandler(db: Db): AuthedHandler {
  return async (_req, auth) => {
    const tenant = await db.withTenant(auth.tenantId, currentTenant);
    return { status: 200, body: { subject: auth.subject, tenant } };
  };
}
