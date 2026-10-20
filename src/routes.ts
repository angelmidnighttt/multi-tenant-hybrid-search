import type { Auth } from './auth/auth.ts';
import { createDocumentHandler } from './documents/documents.handler.ts';
import { healthHandler } from './health/health.handler.ts';
import type { Db } from './lib/db.ts';
import type { Routes } from './lib/http.ts';
import { meHandler } from './tenants/me.handler.ts';

export interface Deps {
  db: Db;
  auth: Auth;
}

export function buildRoutes({ db, auth }: Deps): Routes {
  return {
    'GET /health': healthHandler(db),
    'GET /me': auth.protect(meHandler(db)),
    'POST /documents': auth.protect(createDocumentHandler(db)),
  };
}
