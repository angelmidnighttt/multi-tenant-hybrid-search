import type { AuthedHandler } from './auth.ts';
import type { Db } from './db.ts';
import { HttpError } from './http.ts';

/** GET /me: the caller and their tenant, read through RLS. */
export function meHandler(db: Db): AuthedHandler {
  return async (_req, auth) => {
    const tenant = await db.withTenant(auth.tenantId, async (tx) => {
      const { rows } = await tx.query<{ id: string; slug: string; name: string }>(
        'SELECT id, slug, name FROM tenants',
      );
      return rows[0];
    });
    // A validly signed token can outlive its tenant (e.g. the tenant was deleted).
    if (!tenant) throw new HttpError(403, 'unknown_tenant', 'Tenant does not exist');

    return { status: 200, body: { subject: auth.subject, tenant } };
  };
}
