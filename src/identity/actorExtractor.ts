/**
 * Actor Extractor — REQ-84
 *
 * Parses the `Authorization: Bearer <token>` header where the token has the
 * simulation shortcut format:  `<actorId>:<scope1>,<scope2>,...`
 *
 * Example:  `Bearer alice:admin,trader`  →  { id: 'alice', scopes: ['admin', 'trader'] }
 *
 * NOTE: This is a simulation shortcut.  In production you would validate a signed JWT.
 */

import type { Actor } from '../types.js';

/**
 * Parse an Authorization header value into an Actor.
 *
 * Returns null when:
 *  - the header is absent or empty
 *  - the value does not start with `Bearer ` (case-insensitive)
 *  - the token portion does not contain a `:` separator
 */
export function extractActor(authorizationHeader: string | undefined): Actor | null {
  if (!authorizationHeader || authorizationHeader.trim() === '') return null;

  const BEARER_PREFIX = 'Bearer ';
  if (!authorizationHeader.startsWith(BEARER_PREFIX) &&
      !authorizationHeader.startsWith('bearer ')) {
    return null;
  }

  const token = authorizationHeader.slice(BEARER_PREFIX.length).trim();
  if (!token) return null;

  const colonIdx = token.indexOf(':');
  if (colonIdx === -1) {
    // No scopes portion — treat entire token as actor id with no scopes
    return { id: token, scopes: [] };
  }

  const id = token.slice(0, colonIdx);
  const scopesPart = token.slice(colonIdx + 1);
  const scopes = scopesPart
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (!id) return null;

  return { id, scopes };
}
