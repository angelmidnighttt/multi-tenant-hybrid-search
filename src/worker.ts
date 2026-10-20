// Embedding worker: a separate process from the API (npm run worker).
// Polls the job queue, embeds pending chunks with Ollama, and stops cleanly on
// Ctrl+C after finishing the current round (press twice to force quit).
import { setTimeout as sleep } from 'node:timers/promises';
import { loadWorkerConfig } from './config.ts';
import { runWorkerOnce } from './embeddings/embeddings.service.ts';
import { createOllamaProvider } from './embeddings/ollama.provider.ts';
import { createDb } from './lib/db.ts';

const POLL_INTERVAL_MS = 2000;

const config = loadWorkerConfig();
const db = await createDb(config);
const provider = createOllamaProvider(config.embedding);

try {
  await provider.assertModelAvailable();
} catch (err) {
  console.error(`[worker] ${(err as Error).message}`);
  await db.close();
  process.exit(1);
}
console.log(`[worker] embedding with "${provider.model}" via ${config.embedding.ollamaUrl}`);

const stop = new AbortController();
function onSignal(signal: string): void {
  if (stop.signal.aborted) process.exit(1);
  console.log(`[worker] received ${signal}, finishing the current round...`);
  stop.abort();
}
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));

while (!stop.signal.aborted) {
  let claimed = 0;
  try {
    claimed = await runWorkerOnce(db, provider);
  } catch (err) {
    // E.g. the database is restarting: try again on the next round.
    console.error('[worker] round failed:', (err as Error).message);
  }
  if (claimed === 0) {
    await sleep(POLL_INTERVAL_MS, undefined, { signal: stop.signal }).catch(() => {});
  }
}

await db.close();
console.log('[worker] stopped');
