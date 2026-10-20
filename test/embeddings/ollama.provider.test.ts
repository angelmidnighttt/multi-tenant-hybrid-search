// The Ollama client against a stand-in HTTP server: no Docker, no model.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createOllamaProvider } from '../../src/embeddings/ollama.provider.ts';

let server: Server;
let baseUrl: string;
const requests: { path: string; body: any }[] = [];
const INSTALLED_MODEL = 'bge-m3';

before(async () => {
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ path: req.url!, body });

    res.setHeader('content-type', 'application/json');
    if (body.model !== INSTALLED_MODEL) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: `model '${body.model}' not found` }));
    } else if (req.url === '/api/show') {
      res.end(JSON.stringify({ details: {} }));
    } else if (req.url === '/api/embed') {
      res.end(JSON.stringify({ embeddings: body.input.map((_: string, i: number) => [i, i + 0.5]) }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('Ollama provider', () => {
  it('sends the texts to /api/embed and returns one vector per text', async () => {
    const provider = createOllamaProvider({ ollamaUrl: `${baseUrl}/`, model: 'bge-m3' });
    const vectors = await provider.embed(['một', 'hai']);

    assert.deepEqual(vectors, [
      [0, 0.5],
      [1, 1.5],
    ]);
    assert.deepEqual(requests.at(-1), { path: '/api/embed', body: { model: 'bge-m3', input: ['một', 'hai'] } });
  });

  it('accepts an installed model', async () => {
    await createOllamaProvider({ ollamaUrl: baseUrl, model: 'bge-m3' }).assertModelAvailable();
  });

  it('explains how to fix a model that is not pulled', async () => {
    const provider = createOllamaProvider({ ollamaUrl: baseUrl, model: 'missing-model' });
    await assert.rejects(provider.assertModelAvailable(), /not pulled yet\. Run: npm run models:pull/);
    await assert.rejects(provider.embed(['x']), /\/api\/embed failed: 404/);
  });

  it('explains an unreachable Ollama', async () => {
    // A port that was just freed, so nothing listens on it. (fetch refuses
    // well-known "bad ports" such as 1 before even connecting.)
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const provider = createOllamaProvider({ ollamaUrl: `http://127.0.0.1:${port}`, model: 'bge-m3' });
    await assert.rejects(provider.embed(['x']), /Cannot reach Ollama at .+ \(ECONNREFUSED\)\. Is it running\?/);
  });
});
