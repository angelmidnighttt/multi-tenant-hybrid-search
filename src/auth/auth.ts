import { errors, jwtVerify, type JWTPayload } from 'jose';
import type { AuthConfig } from '../config.ts';
import { HttpError, type Handler, type HttpRequest, type HttpResponse } from '../lib/http.ts';
import { isUuid } from '../lib/uuid.ts';

/** Who is calling. tenantId comes ONLY from a verified token, never from the request body or query. */
export interface AuthContext {
  tenantId: string;
  subject: string;
}

export type AuthedHandler = (req: HttpRequest, auth: AuthContext) => Promise<HttpResponse>;

export interface Auth {
  /** Verifies a JWT and extracts the caller. Throws HttpError(401) on any problem. */
  verify(token: string): Promise<AuthContext>;
  /** Wraps a handler so it only runs for requests carrying a valid bearer token. */
  protect(handler: AuthedHandler): Handler;
}

const BEARER_RE = /^Bearer (\S+)$/i;

export function createAuth(config: AuthConfig): Auth {
  const key = new TextEncoder().encode(config.jwtSecret);

  async function verify(token: string): Promise<AuthContext> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, key, {
        // Pin the algorithm: rejects "alg: none" and algorithm-confusion tokens.
        algorithms: ['HS256'],
        issuer: config.jwtIssuer,
        audience: config.jwtAudience,
        requiredClaims: ['exp', 'sub', 'tenant_id'],
        clockTolerance: '30s',
      }));
    } catch (err) {
      if (err instanceof errors.JOSEError) throw invalidToken();
      throw err;
    }

    const { sub, tenant_id: tenantId } = payload;
    if (typeof sub !== 'string' || !isUuid(tenantId)) throw invalidToken();
    return { tenantId, subject: sub };
  }

  return {
    verify,
    protect(handler) {
      return async (req) => {
        const token = BEARER_RE.exec(req.headers.authorization ?? '')?.[1];
        if (!token) {
          throw new HttpError(401, 'missing_token', 'Authorization: Bearer <token> header is required', {
            'www-authenticate': 'Bearer',
          });
        }
        return handler(req, await verify(token));
      };
    },
  };
}

// The reason (expired, bad signature, wrong audience...) is deliberately not
// returned to the client.
function invalidToken(): HttpError {
  return new HttpError(401, 'invalid_token', 'Token is invalid or expired', {
    'www-authenticate': 'Bearer error="invalid_token"',
  });
}
