import { HttpError } from '../lib/http.ts';

// "vector" and "hybrid" are added in the next steps.
const MODES = ['bm25'] as const;
export type SearchMode = (typeof MODES)[number];

export interface SearchInput {
  query: string;
  mode: SearchMode;
  limit: number;
}

/** Validates the query string of GET /search. Throws HttpError(400) when invalid. */
export function parseSearchInput(params: URLSearchParams): SearchInput {
  const query = (params.get('q') ?? '').trim();
  if (!query) throw invalidQuery('"q" is required');
  if (query.length > 500) throw invalidQuery('"q" must be at most 500 characters');

  const mode = params.get('mode') ?? 'bm25';
  if (!isMode(mode)) throw invalidQuery(`"mode" must be one of: ${MODES.join(', ')}`);

  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? 10 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw invalidQuery('"limit" must be an integer from 1 to 50');
  }

  return { query, mode, limit };
}

function isMode(value: string): value is SearchMode {
  return (MODES as readonly string[]).includes(value);
}

function invalidQuery(message: string): HttpError {
  return new HttpError(400, 'invalid_query', message);
}
