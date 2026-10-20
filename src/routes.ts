import type { Auth } from './auth.ts';
import type { Db } from './db.ts';
import { healthHandler } from './health.ts';
import type { Routes } from './http.ts';
import { meHandler } from './me.ts';

export interface Deps {
  db: Db;
  auth: Auth;
}

export function buildRoutes({ db, auth }: Deps): Routes {
  return {
    'GET /health': healthHandler(db),
    'GET /me': auth.protect(meHandler(db)),
  };
}
