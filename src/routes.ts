import type { Db } from './db.ts';
import { healthHandler } from './health.ts';
import type { Routes } from './http.ts';

export interface Deps {
  db: Db;
}

export function buildRoutes({ db }: Deps): Routes {
  return {
    'GET /health': healthHandler(db),
  };
}
