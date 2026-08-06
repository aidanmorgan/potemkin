/**
 * JWT Validator
 *
 * HS256 JWT validation and signing via the `jsonwebtoken` library. Used when
 * global AuthConfig.mode === 'jwt'.
 *
 * Supported:
 *  - Algorithm: HS256 (HMAC-SHA256). Other algorithms are explicitly rejected
 *               (alg:none included) by allow-listing the configured algorithm.
 *  - Claims:    exp, nbf, iss, aud, plus a configurable subject claim (default
 *               'sub') and scopes claim (default 'scopes'; accepts string or
 *               string[]).
 *
 * Verification, signature checking, algorithm allow-listing and the standard
 * registered-claim checks (exp/nbf/iss/aud) are delegated to `jsonwebtoken`
 * (synchronous API), so the call stays synchronous for its callers in the
 * gateway/forwarding pipeline. Errors carry a structured `code` so callers can
 * translate to HTTP 401 responses with diagnostic detail.
 */

import jwt from 'jsonwebtoken';
import type { Algorithm, Jwt, JwtPayload, VerifyOptions } from 'jsonwebtoken';
import type { Actor, JwtValidationConfig } from '../contracts/identity.js';
import { isRecord } from '../contracts/value.js';

export type { JwtValidationConfig };

export type JwtErrorCode =
  | 'JWT_MALFORMED'
  | 'JWT_MISSING'
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

/**
 * Validate a JWT against the provided config and return the corresponding Actor.
 *
 * Signature verification, the HS256 algorithm allow-list (rejecting alg:none and
 * algorithm-confusion), and the exp/nbf/iss/aud registered-claim checks are
 * performed by jsonwebtoken. requiredClaims and the configurable subject/scopes
 * extraction are applied on top of the verified payload.
 *
 * @throws {JwtValidationError} with a structured `code` on any failure.
 */
export function validateJwt(token: string, config: JwtValidationConfig): Actor {
  if (typeof config.secret !== 'string' || config.secret.trim() === '') {
    throw new JwtValidationError(
      'JWT shared secret must not be empty or whitespace',
      'JWT_BLANK_SECRET',
    );
  }

  if (typeof token !== 'string' || token.trim() === '') {
    throw new JwtValidationError('JWT is empty', 'JWT_MALFORMED');
  }

  // Emit a precise JWT_MALFORMED (rather than jsonwebtoken's generic message)
  // when the compact structure is wrong.
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new JwtValidationError(
      `JWT must have exactly 3 segments separated by '.', got ${parts.length}`,
      'JWT_MALFORMED',
    );
  }

  const configuredAlg: Algorithm = config.algorithm ?? 'HS256';

  const verifyOptions: VerifyOptions = {
    // Allow-list the single configured algorithm: any other alg value
    // (including 'none') is rejected as JWT_UNSUPPORTED_ALG.
    algorithms: [configuredAlg],
  };
  if (config.issuer !== undefined) {
    verifyOptions.issuer = config.issuer;
  }
  if (config.audience !== undefined) {
    verifyOptions.audience = config.audience;
  }

  // Decode the complete token through jsonwebtoken before verification so the
  // algorithm allow-list can be enforced before cryptographic verification.
  // This is decoding only; signature and registered-claim checks still happen
  // in jwt.verify below.
  let decoded: Jwt | null;
  try {
    decoded = jwt.decode(token, { complete: true });
  } catch {
    // jsonwebtoken parses JWT payloads while decoding complete tokens. If that
    // parsing fails, let verify produce the same dependency-owned error that
    // the previous header-only path would have mapped.
    try {
      jwt.verify(token, config.secret, verifyOptions);
    } catch (err) {
      throw mapJwtError(err, configuredAlg);
    }
    throw new JwtValidationError('JWT validation failed', 'JWT_MALFORMED');
  }
  if (decoded === null || !isRecord(decoded.header)) {
    throw new JwtValidationError('JWT header is not a valid JSON object', 'JWT_MALFORMED');
  }
  const headerAlg = decoded.header['alg'];
  if (headerAlg !== configuredAlg) {
    throw new JwtValidationError(
      `JWT algorithm "${String(headerAlg)}" is not supported (expected "${configuredAlg}")`,
      'JWT_UNSUPPORTED_ALG',
    );
  }

  let payload: JwtPayload;
  try {
    const verified = jwt.verify(token, config.secret, verifyOptions);
    // With a non-empty token jsonwebtoken returns the decoded payload object;
    // a bare string payload is not used by this engine.
    if (typeof verified === 'string') {
      throw new JwtValidationError('JWT payload is not a JSON object', 'JWT_MALFORMED');
    }
    payload = verified;
  } catch (err) {
    if (err instanceof JwtValidationError) {
      throw err;
    }
    throw mapJwtError(err, configuredAlg);
  }

  // requiredClaims: each [claim, expected] must be present; '*' means
  // "present with any value".
  for (const [claim, expected] of Object.entries(config.requiredClaims ?? {})) {
    if (!(claim in payload)) {
      throw new JwtValidationError(`JWT missing required claim: ${claim}`, 'JWT_MISSING_CLAIM');
    }
    if (expected !== '*' && String(payload[claim]) !== expected) {
      throw new JwtValidationError(`JWT claim ${claim} mismatch`, 'JWT_CLAIM_MISMATCH');
    }
  }

  // Extract actor identity from configured claims.
  const subjectClaim = config.subjectClaim ?? 'sub';
  const scopesClaim = config.scopesClaim ?? 'scopes';

  const subjectValue = payload[subjectClaim];
  if (typeof subjectValue !== 'string' || subjectValue.trim() === '') {
    throw new JwtValidationError(
      `JWT is missing required subject claim "${subjectClaim}"`,
      'JWT_MISSING_CLAIM',
    );
  }

  const scopesValue = payload[scopesClaim];
  let scopes: readonly string[] = [];
  if (typeof scopesValue === 'string') {
    scopes = scopesValue
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } else if (Array.isArray(scopesValue)) {
    scopes = scopesValue
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .map((s) => s.trim());
  }

  return { id: subjectValue, scopes };
}

/**
 * Translate a jsonwebtoken error into a structured JwtValidationError.
 */
function mapJwtError(err: unknown, configuredAlg: string): JwtValidationError {
  if (err instanceof jwt.TokenExpiredError) {
    return new JwtValidationError(`JWT expired at ${err.expiredAt.toISOString()}`, 'JWT_EXPIRED');
  }
  if (err instanceof jwt.NotBeforeError) {
    return new JwtValidationError(
      `JWT not valid until ${err.date.toISOString()}`,
      'JWT_NOT_YET_VALID',
    );
  }
  if (err instanceof jwt.JsonWebTokenError) {
    const msg = err.message;
    if (msg.includes('invalid algorithm')) {
      return new JwtValidationError(
        `JWT algorithm is not supported (expected "${configuredAlg}")`,
        'JWT_UNSUPPORTED_ALG',
      );
    }
    if (msg.includes('invalid signature')) {
      return new JwtValidationError('JWT signature does not match', 'JWT_INVALID_SIGNATURE');
    }
    if (msg.startsWith('jwt issuer invalid')) {
      return new JwtValidationError(msg, 'JWT_INVALID_ISSUER');
    }
    if (msg.startsWith('jwt audience invalid')) {
      return new JwtValidationError(msg, 'JWT_INVALID_AUDIENCE');
    }
    // 'jwt malformed', 'invalid token', 'jwt signature is required', etc.
    return new JwtValidationError(msg, 'JWT_MALFORMED');
  }
  return new JwtValidationError('JWT validation failed', 'JWT_MALFORMED');
}
