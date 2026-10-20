import { HttpError } from '../lib/http.ts';

export interface DocumentInput {
  title: string;
  content: string;
  externalId: string | null;
  sourceUri: string | null;
  metadata: Record<string, unknown>;
}

const ALLOWED_FIELDS = new Set(['title', 'content', 'external_id', 'source_uri', 'metadata']);

/** Validates the body of POST /documents. Throws HttpError(400) when invalid. */
export function parseDocumentInput(body: unknown): DocumentInput {
  if (!isPlainObject(body)) throw invalidBody('Body must be a JSON object');

  // Rejecting unknown fields makes it explicit that e.g. tenant_id cannot be
  // chosen by the client: it only ever comes from the token.
  const unknown = Object.keys(body).filter((key) => !ALLOWED_FIELDS.has(key));
  if (unknown.length > 0) throw invalidBody(`Unknown field(s): ${unknown.join(', ')}`);

  return {
    title: requiredString(body, 'title', 500),
    content: requiredString(body, 'content'),
    externalId: optionalString(body, 'external_id', 200),
    sourceUri: optionalString(body, 'source_uri', 2000),
    metadata: optionalObject(body, 'metadata'),
  };
}

function requiredString(body: Record<string, unknown>, field: string, maxLength = Infinity): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidBody(`"${field}" must be a non-empty string`);
  }
  if (value.length > maxLength) throw invalidBody(`"${field}" must be at most ${maxLength} characters`);
  return field === 'content' ? value : value.trim();
}

function optionalString(body: Record<string, unknown>, field: string, maxLength: number): string | null {
  if (body[field] === undefined || body[field] === null) return null;
  return requiredString(body, field, maxLength);
}

function optionalObject(body: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = body[field];
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) throw invalidBody(`"${field}" must be a JSON object`);
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidBody(message: string): HttpError {
  return new HttpError(400, 'invalid_body', message);
}
