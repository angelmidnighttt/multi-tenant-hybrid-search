import type { TenantTx } from '../lib/db.ts';
import { HttpError } from '../lib/http.ts';

export interface Tenant {
  id: string;
  slug: string;
  name: string;
}

/**
 * The tenant of the current transaction (RLS exposes only that one row).
 * Throws 403 when it does not exist: a validly signed token can outlive its
 * tenant, e.g. after the tenant was deleted.
 */
export async function currentTenant(tx: TenantTx): Promise<Tenant> {
  const { rows } = await tx.query<Tenant>('SELECT id, slug, name FROM tenants');
  const tenant = rows[0];
  if (!tenant) throw new HttpError(403, 'unknown_tenant', 'Tenant does not exist');
  return tenant;
}
