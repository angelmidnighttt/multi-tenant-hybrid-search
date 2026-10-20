import type { Db } from '../lib/db.ts';
import type { Handler } from '../lib/http.ts';

export function healthHandler(db: Db): Handler {
  return async () => {
    try {
      await db.ping();
      return { status: 200, body: { status: 'ok' } };
    } catch (err) {
      // Connection errors (ECONNREFUSED...) often have an empty message, so
      // prefer the error code.
      const e = err as NodeJS.ErrnoException;
      console.error('[health] database unreachable:', e.code ?? e.message);
      return { status: 503, body: { status: 'unavailable' } };
    }
  };
}
