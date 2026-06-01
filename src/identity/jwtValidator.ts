/**
 * JWT Validator
 *
 * Pure-TypeScript HS256 JWT validation using only `node:crypto` — no external
 * dependencies. Used when global AuthConfig.mode === 'jwt'.
 *
 * Supported:
 *  - Algorithm: HS256 (HMAC-SHA256). Other algorithms are explicitly rejected.
 *  - Claims:    exp, nbf, iss, aud, plus a configurable subject claim (default 'sub')
 *               and scopes claim (default 'scopes'; accepts string or string[]).
 *
 * Explicitly rejected:
 *  - alg = "none"   (unsigned tokens are never accepted)
 *  - alg ≠ HS256   (other algs unsupported until added)
 *  - tokens missing the configured subject claim
 *
 * Errors carry a structured `code` to allow callers (gateway, forwarding) to
 * translate to HTTP 401 responses with diagnostic detail.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Actor, JsonObject, JsonValue } from '../types.js';
import type { JwtAuthConfig } from '../dsl/types.js';

export type JwtErrorCode =
  | 'JWT_MALFORMED'
  | 'JWT_BLANK_SECRET'
  | 'JWT_UNSUPPORTED_ALG'
  | 'JWT_INVALID_SIGNATURE'
  | 'JWT_EXPIRED'
  | 'JWT_NOT_YET_VALID'
  | 'JWT_INVALID_ISSUER'
  | 'JWT_INVALID_AUDIENCE'
  | 'JWT_MISSING_CLAIM'
  | 'JWT_CLAIM_MISMATCH';

export class JwtValidationError extends Error {
  readonly code: JwtErrorCode;
  constructor(message: string, code: JwtErrorCode) {
    super(message);
    this.name = 'JwtValidationError';
    this.code = code;
  }
}

/** Decode a base64url-encoded string to a UTF-8 string. */
function base64urlToString(s: string): string {
  return Buffer.from(base64urlToBuffer(s)).toString('utf8');
}

/** Decode a base64url-encoded string to a Buffer. */
function base64urlToBuffer(s: string): Buffer {
  // base64url → base64: '-' → '+', '_' → '/', and pad to multiple of 4.
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64');
}

/** Encode a Buffer as a base64url string (no padding). */
export function bufferToBase64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Sign a JWT header+payload using HS256.
 * Returns the full compact token: `<header>.<payload>.<signature>`.
 *
 * This helper is exported so test fixtures can mint JWTs without pulling in a
 * third-party library. Production code should NOT call this — JWTs sent to
 * Potemkin are signed externally by the caller.
 */
export function signJwtHs256(
  payload: JsonObject,
  secret: string,
  headerOverrides: { alg?: string; typ?: string } = {},
): string {
  const header = { alg: headerOverrides.alg ?? 'HS256', typ: headerOverrides.typ ?? 'JWT' };
  const headerEncoded = bufferToBase64url(Buffer.from(JSON.stringify(header), 'utf8'));
  const payloadEncoded = bufferToBase64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signingInput = `${headerEncoded}.${payloadEncoded}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest();
  return `${signingInput}.${bufferToBase64url(signature)}`;
}

function safeParseJson(s: string): JsonValue | undefined {
  try {
    return JSON.parse(s) as JsonValue;
  } catch {
    return undefined;
  }
}

function asObject(v: JsonValue | undefined): JsonObject | undefined {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as JsonObject;
  return undefined;
}

/**
 * Validate a JWT against the provided config and return the corresponding Actor.
 *
 * @throws {JwtValidationError} with a structured `code` on any failure.
 */
export function validateJwt(token: string, config: JwtAuthConfig): Actor {
  // Fail fast on a blank secret — an empty/whitespace secret produces a
  // deterministic, forgeable HMAC and must never be used for validation.
  if (typeof config.secret !== 'string' || config.secret.trim() === '') {
    throw new JwtValidationError(
      'JWT shared secret must not be empty or whitespace',
      'JWT_BLANK_SECRET',
    );
  }

  if (typeof token !== 'string' || token.trim() === '') {
    throw new JwtValidationError('JWT is empty', 'JWT_MALFORMED');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new JwtValidationError(
      `JWT must have exactly 3 segments separated by '.', got ${parts.length}`,
      'JWT_MALFORMED',
    );
  }
  const [headerSeg, payloadSeg, signatureSeg] = parts;

  // 1. Decode header and validate algorithm BEFORE checking signature so we
  //    reject `alg: none` outright rather than trying to verify an empty sig.
  const headerJson = safeParseJson(base64urlToString(headerSeg));
  const header = asObject(headerJson);
  if (!header) {
    throw new JwtValidationError('JWT header is not a valid JSON object', 'JWT_MALFORMED');
  }
  const alg = header['alg'];
  if (typeof alg !== 'string') {
    throw new JwtValidationError('JWT header missing "alg" claim', 'JWT_MALFORMED');
  }
  // Explicit rejection of "alg: none" and any unsupported algorithm.
  const configuredAlg = config.algorithm ?? 'HS256';
  if (alg !== configuredAlg) {
    throw new JwtValidationError(
      `JWT algorithm "${alg}" is not supported (expected "${configuredAlg}")`,
      'JWT_UNSUPPORTED_ALG',
    );
  }

  // 2. Verify HMAC-SHA256 signature against the configured secret.
  const signingInput = `${headerSeg}.${payloadSeg}`;
  const expectedSig = createHmac('sha256', config.secret).update(signingInput).digest();
  const providedSig = base64urlToBuffer(signatureSeg);
  // Both buffers must be equal length for timingSafeEqual.
  if (providedSig.length !== expectedSig.length ||
      !timingSafeEqual(providedSig, expectedSig)) {
    throw new JwtValidationError('JWT signature does not match', 'JWT_INVALID_SIGNATURE');
  }

  // 3. Decode and validate payload claims.
  const payloadJson = safeParseJson(base64urlToString(payloadSeg));
  const payload = asObject(payloadJson);
  if (!payload) {
    throw new JwtValidationError('JWT payload is not a valid JSON object', 'JWT_MALFORMED');
  }

  const nowSec = Math.floor(Date.now() / 1000);

  // exp: expiration time (must be in the future when present)
  const exp = payload['exp'];
  if (typeof exp === 'number') {
    if (nowSec >= exp) {
      throw new JwtValidationError(
        `JWT expired at ${new Date(exp * 1000).toISOString()}`,
        'JWT_EXPIRED',
      );
    }
  }

  // nbf: not-before (must be in the past when present)
  const nbf = payload['nbf'];
  if (typeof nbf === 'number') {
    if (nowSec < nbf) {
      throw new JwtValidationError(
        `JWT not valid until ${new Date(nbf * 1000).toISOString()}`,
        'JWT_NOT_YET_VALID',
      );
    }
  }

  // iss: issuer (must match config.issuer if configured)
  if (config.issuer !== undefined) {
    if (payload['iss'] !== config.issuer) {
      throw new JwtValidationError(
        `JWT issuer "${String(payload['iss'])}" does not match expected "${config.issuer}"`,
        'JWT_INVALID_ISSUER',
      );
    }
  }

  // aud: audience (string or string[]; must match config.audience if configured)
  if (config.audience !== undefined) {
    const aud = payload['aud'];
    let matches = false;
    if (typeof aud === 'string') {
      matches = aud === config.audience;
    } else if (Array.isArray(aud)) {
      matches = aud.some((a) => a === config.audience);
    }
    if (!matches) {
      throw new JwtValidationError(
        `JWT audience "${JSON.stringify(aud)}" does not match expected "${config.audience}"`,
        'JWT_INVALID_AUDIENCE',
      );
    }
  }

  // 4. Enforce requiredClaims: each [claim, expected] must be present and match.
  for (const [claim, expected] of Object.entries(config.requiredClaims ?? {})) {
    if (!(claim in payload)) {
      throw new JwtValidationError(
        `JWT missing required claim: ${claim}`,
        'JWT_MISSING_CLAIM',
      );
    }
    if (expected !== '*' && String(payload[claim]) !== expected) {
      throw new JwtValidationError(
        `JWT claim ${claim} mismatch`,
        'JWT_CLAIM_MISMATCH',
      );
    }
  }

  // 5. Extract actor identity from configured claims.
  const subjectClaim = config.subjectClaim ?? 'sub';
  const scopesClaim = config.scopesClaim ?? 'scopes';

  const subjectValue = payload[subjectClaim];
  if (typeof subjectValue !== 'string' || subjectValue.trim() === '') {
    throw new JwtValidationError(
      `JWT is missing required subject claim "${subjectClaim}"`,
      'JWT_MISSING_CLAIM',
    );
  }

  // Scopes: accept string (space-separated, per RFC 8693) or string[].
  const scopesValue = payload[scopesClaim];
  let scopes: readonly string[] = [];
  if (typeof scopesValue === 'string') {
    scopes = scopesValue.split(/\s+/).map((s) => s.trim()).filter((s) => s.length > 0);
  } else if (Array.isArray(scopesValue)) {
    scopes = scopesValue
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .map((s) => s.trim());
  }

  return { id: subjectValue, scopes };
}
