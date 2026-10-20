import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

export interface HttpRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  /** Parsed JSON; undefined if the request has no body. */
  body: unknown;
}

export interface HttpResponse {
  status: number;
  body?: unknown;
}

export type Handler = (req: HttpRequest) => Promise<HttpResponse>;

/** Keys look like "METHOD /path", e.g. "GET /health". */
export type Routes = Record<string, Handler>;

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const MAX_BODY_BYTES = 1_000_000;

export function createHttpServer(routes: Routes): Server {
  return createServer((req, res) => {
    void handle(routes, req, res);
  });
}

async function handle(routes: Routes, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let response: HttpResponse;
  try {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) throw new HttpError(404, 'not_found', `Route not found: ${method} ${url.pathname}`);

    response = await handler({
      method,
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      body: await readJsonBody(req),
    });
  } catch (err) {
    response = toErrorResponse(err);
  }
  send(res, response);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large', 'Body exceeds 1MB');
    chunks.push(chunk);
  }
  if (size === 0) return undefined;

  if (!req.headers['content-type']?.startsWith('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'Only Content-Type: application/json is accepted');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'Body is not valid JSON');
  }
}

function toErrorResponse(err: unknown): HttpResponse {
  if (err instanceof HttpError) {
    return { status: err.status, body: { error: { code: err.code, message: err.message } } };
  }
  // Unexpected errors (including SQL errors) are only logged, never returned to
  // the client, because error messages may contain data.
  console.error('[http] unhandled error:', err);
  return { status: 500, body: { error: { code: 'internal', message: 'Internal server error' } } };
}

function send(res: ServerResponse, { status, body }: HttpResponse): void {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
