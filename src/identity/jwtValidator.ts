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
import type { Algorithm, SignOptions, VerifyOptions, JwtPayload } from 'jsonwebtoken';
import type { Actor, JsonObject } from '../types.js';
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

/**
 * Sign a JWT using HS256 via jsonwebtoken.
 * Returns the full compact token: `<header>.<payload>.<signature>`.
 *
 * When `headerOverrides.alg` is set to `'none'`, an unsecured JWT (no
 * signature) is produced — used only in tests that verify the validator
 * rejects alg:none tokens.
 *
 * This helper is exported so test fixtures can mint JWTs. Production code
 * should NOT call this — JWTs sent to Potemkin are signed externally.
 */
export function signJwtHs256(
  payload: JsonObject,
  secret: string,
  headerOverrides: { alg?: string; typ?: string } = {},
): string {
  const alg = (headerOverrides.alg ?? 'HS256') as Algorithm | 'none';

  const options: SignOptions = {
    algorithm: alg as Algorithm,
    // Preserve any caller-supplied claims verbatim (exp/nbf/iss/aud may live in
    // the payload); do not let jsonwebtoken inject its own iat/exp.
    noTimestamp: true,
  };
  if (headerOverrides.typ !== undefined) {
    options.header = { alg: alg as Algorithm, typ: headerOverrides.typ };
  }

  // alg:none yields an unsecured token (empty signature). jsonwebtoken signs
  // 'none' with an empty key.
  if (alg === 'none') {
    return jwt.sign(payload, '', { ...options, algorithm: 'none' });
  }

  // Blank/whitespace secrets are used only by tests that verify validateJwt's
  // blank-secret guard fires. jsonwebtoken refuses to sign with an empty key, so
  // mint with a placeholder — the resulting token is rejected on validate before
  // any signature check because the config secret is blank.
  const signingSecret = secret.trim() === '' ? 'x' : secret;
  return jwt.sign(payload, signingSecret, options);
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
export function validateJwt(token: string, config: JwtAuthConfig): Actor {
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

  const configuredAlg = (config.algorithm ?? 'HS256') as Algorithm;

  // Enforce the algorithm allow-list from the token header BEFORE verification,
  // rejecting alg:none and algorithm-confusion with a precise code. (Reading the
  // header's alg field is not cryptographic work — jsonwebtoken still performs
  // the signature and registered-claim verification below.)
  let headerAlg: unknown;
  try {
    headerAlg = (JSON.parse(Buffer.from(parts[0] as string, 'base64url').toString('utf8')) as Record<string, unknown>)['alg'];
  } catch {
    throw new JwtValidationError('JWT header is not a valid JSON object', 'JWT_MALFORMED');
  }
  if (headerAlg !== configuredAlg) {
    throw new JwtValidationError(
      `JWT algorithm "${String(headerAlg)}" is not supported (expected "${configuredAlg}")`,
      'JWT_UNSUPPORTED_ALG',
    );
  }

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
    if (expected !== '*' && String((payload as Record<string, unknown>)[claim]) !== expected) {
      throw new JwtValidationError(`JWT claim ${claim} mismatch`, 'JWT_CLAIM_MISMATCH');
    }
  }

  // Extract actor identity from configured claims.
  const subjectClaim = config.subjectClaim ?? 'sub';
  const scopesClaim = config.scopesClaim ?? 'scopes';

  const subjectValue = (payload as Record<string, unknown>)[subjectClaim];
  if (typeof subjectValue !== 'string' || subjectValue.trim() === '') {
    throw new JwtValidationError(
      `JWT is missing required subject claim "${subjectClaim}"`,
      'JWT_MISSING_CLAIM',
    );
  }

  const scopesValue = (payload as Record<string, unknown>)[scopesClaim];
  let scopes: readonly string[] = [];
  if (typeof scopesValue === 'string') {
    scopes = scopesValue.split(/\s+/).map((s) => s.trim()).filter((s) => s.length > 0);
  } else if (Array.isArray(scopesValue)) {
    scopes = (scopesValue as unknown[])
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
    return new JwtValidationError(`JWT not valid until ${err.date.toISOString()}`, 'JWT_NOT_YET_VALID');
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
