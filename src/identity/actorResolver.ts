// Resolve the request Actor from the Authorization header according to the
// configured auth mode.
//
//  - auth.mode === 'jwt'  → the bearer token is verified via validateJwt; the
//    `Bearer <id>:<scopes>` shortcut is NOT accepted (validateJwt throws
//    JwtValidationError, which callers map to 401).
//  - auth.mode === 'simple' | 'session' | undefined → the simple
//    `Bearer <id>:<scopes>` simulation shortcut is parsed by extractActor.

import type { Actor } from '../contracts/identity.js';
import { extractActor } from './actorExtractor.js';
import { validateJwt, JwtValidationError } from './jwtValidator.js';
import type { RuntimeAuth, RuntimeAuthenticationPort, RuntimeRequest } from '../model/runtime.js';

export { JwtValidationError };

/** Pull the raw token out of an `Authorization: Bearer <token>` header. */
function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/**
 * Resolve the Actor for a request.
 *
 * Returns `null` when no credential is present (the caller decides whether that
 * is anonymous-allowed or a 401). In JWT mode an invalid token throws
 * {@link JwtValidationError}.
 */
export function resolveActor(
  authHeader: string | undefined,
  auth: Readonly<Pick<RuntimeAuth, 'mode' | 'jwt'>> | undefined,
): Actor | null {
  if (auth?.mode === 'jwt') {
    if (!auth.jwt) {
      throw new JwtValidationError(
        'auth.mode is "jwt" but no auth.jwt configuration is present',
        'JWT_MALFORMED',
      );
    }
    const token = extractBearerToken(authHeader);
    if (token === null) return null;
    // validateJwt rejects the simple `<id>:<scopes>` shortcut as JWT_MALFORMED.
    return validateJwt(token, auth.jwt);
  }
  return extractActor(authHeader);
}

/** Build the injected authentication implementation shared by all compilers. */
export function createRuntimeAuthenticationPort(): RuntimeAuthenticationPort {
  return {
    authenticate: (request: Readonly<RuntimeRequest>, policy: Readonly<RuntimeAuth>) => {
      const actor = resolveActor(
        request.headers.authorization ?? request.headers.Authorization,
        policy,
      );
      if (actor === null && policy.mode === 'jwt') {
        throw new JwtValidationError('Authorization header is required in JWT mode', 'JWT_MISSING');
      }
      return actor ?? undefined;
    },
  };
}
