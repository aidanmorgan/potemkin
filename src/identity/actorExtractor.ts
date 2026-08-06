/**
 * Parses the `Authorization: Bearer <token>` header where the token has the
 * simulation shortcut format:  `<actorId>:<scope1>,<scope2>,...`
 *
 * Example:  `Bearer alice:admin,trader`  →  { id: 'alice', scopes: ['admin', 'trader'] }
 *
 * NOTE: This is a simulation shortcut.  In production you would validate a signed JWT.
 */

import type { Actor } from '../contracts/identity.js';

/**
 * Parse an Authorization header value into an Actor.
 *
 * Returns null when:
 *  - the header is absent or empty
 *  - the value does not start with `Bearer ` (case-insensitive)
 *  - the token portion does not contain a `:` separator
 */
export function extractActor(authorizationHeader: string | undefined): Actor | null {
  const token = extractBearerToken(authorizationHeader);
  if (token === null) return null;

  const colonIdx = token.indexOf(':');
  if (colonIdx === -1) {
    // No scopes portion — treat entire token as actor id with no scopes
    return { id: token, scopes: [] };
  }

  const id = token.slice(0, colonIdx);
  const scopesPart = token.slice(colonIdx + 1);
  const scopes = scopesPart
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (!id) return null;

  return { id, scopes };
}

/**
 * Extract the opaque credential from a Bearer authorization header.
 *
 * Header names and the Bearer scheme are case-insensitive, while the token
 * itself is returned verbatim apart from surrounding whitespace.
 */
export function extractBearerToken(authorizationHeader: string | undefined): string | null {
  const header = authorizationHeader?.trim();
  if (!header) return null;

  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match?.[1]?.trim();
  return token || null;
}
