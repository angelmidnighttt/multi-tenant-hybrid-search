import type { EmbeddingConfig } from '../config.ts';
import type { EmbeddingProvider } from './embedding.provider.ts';

export interface OllamaProvider extends EmbeddingProvider {
  /** Fails with an actionable message if Ollama is down or the model is not pulled. */
  assertModelAvailable(): Promise<void>;
}

export interface OllamaOptions {
  /**
   * Per-request timeout. The default is generous because the first request
   * also loads the model, which is slow on CPU; the API uses a shorter one so
   * a search request never hangs.
   */
  timeoutMs?: number;
}

export function createOllamaProvider(
  { ollamaUrl, model }: EmbeddingConfig,
  { timeoutMs = 120_000 }: OllamaOptions = {},
): OllamaProvider {
  const baseUrl = ollamaUrl.replace(/\/+$/, '');

  async function post(path: string, body: unknown): Promise<Response> {
    try {
      return await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if ((err as Error).name === 'TimeoutError') {
        throw new Error(`Ollama at ${baseUrl} did not respond within ${timeoutMs}ms`);
      }
      // fetch reports connection errors as "fetch failed" with the code in `cause`.
      const reason = (err as { cause?: { code?: string } }).cause?.code ?? (err as Error).message;
      throw new Error(`Cannot reach Ollama at ${baseUrl} (${reason}). Is it running? Try: npm run up`);
    }
  }

  return {
    model,

    async assertModelAvailable() {
      const res = await post('/api/show', { model });
      if (res.status === 404) throw new Error(`Ollama model "${model}" is not pulled yet. Run: npm run models:pull`);
      if (!res.ok) throw new Error(`Ollama /api/show failed: ${res.status} ${await res.text()}`);
    },

    async embed(texts) {
      const res = await post('/api/embed', { model, input: texts });
      if (!res.ok) throw new Error(`Ollama /api/embed failed: ${res.status} ${await res.text()}`);
      const { embeddings } = (await res.json()) as { embeddings?: unknown };
      if (!Array.isArray(embeddings)) throw new Error('Ollama /api/embed returned no embeddings');
      return embeddings as number[][];
    },
  };
}
