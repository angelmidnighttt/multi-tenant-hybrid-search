import { createAuth } from './auth/auth.ts';
import { loadConfig } from './config.ts';
import { createOllamaProvider } from './embeddings/ollama.provider.ts';
import { createDb } from './lib/db.ts';
import { createHttpServer } from './lib/http.ts';
import { buildRoutes } from './routes.ts';

const config = loadConfig();
const db = await createDb(config);
const auth = createAuth(config.auth);
// A search request should fail fast rather than wait on a stuck model.
const embeddings = createOllamaProvider(config.embedding, { timeoutMs: 30_000 });
const server = createHttpServer(buildRoutes({ db, auth, embeddings }));

// The API still starts without Ollama: only mode=vector is affected (503).
embeddings.assertModelAvailable().catch((err: Error) => {
  console.warn(`[main] vector search unavailable for now: ${err.message}`);
});

server.listen(config.port, () => {
  console.log(`[http] listening on http://localhost:${config.port}`);
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[main] received ${signal}, shutting down...`);
  // Stop accepting new requests and let in-flight ones finish before closing
  // the pool.
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
  console.log('[main] stopped');
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
