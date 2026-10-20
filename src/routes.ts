import type { Auth } from './auth/auth.ts';
import { createDocumentHandler } from './documents/documents.handler.ts';
import type { EmbeddingProvider } from './embeddings/embedding.provider.ts';
import { healthHandler } from './health/health.handler.ts';
import type { Db } from './lib/db.ts';
import type { Routes } from './lib/http.ts';
import { searchHandler } from './search/search.handler.ts';
import { meHandler } from './tenants/me.handler.ts';

export interface Deps {
  db: Db;
  auth: Auth;
  /** Embeds search queries for mode=vector. */
  embeddings: EmbeddingProvider;
}

export function buildRoutes({ db, auth, embeddings }: Deps): Routes {
  return {
    'GET /health': healthHandler(db),
    'GET /me': auth.protect(meHandler(db)),
    'POST /documents': auth.protect(createDocumentHandler(db)),
    'GET /search': auth.protect(searchHandler(db, embeddings)),
  };
}
