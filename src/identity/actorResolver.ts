// Resolve the request Actor from the Authorization header according to the
// configured auth mode.
//
//  - auth.mode === 'jwt'  → the bearer token is verified via validateJwt; the
//    legacy `Bearer <id>:<scopes>` shortcut is NOT accepted (validateJwt throws
//    JwtValidationError, which callers map to 401).
//  - auth.mode === 'simple' | 'session' | undefined → the legacy
//    `Bearer <id>:<scopes>` simulation shortcut is parsed by extractActor.

import type { Actor } from '../types.js';
import type { AuthConfig } from '../dsl/types.js';
import { extractActor } from './actorExtractor.js';
import { validateJwt, JwtValidationError } from './jwtValidator.js';

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
  auth: AuthConfig | undefined,
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
    // validateJwt rejects the legacy `<id>:<scopes>` shortcut as JWT_MALFORMED.
    return validateJwt(token, auth.jwt);
  }
  return extractActor(authHeader);
}
