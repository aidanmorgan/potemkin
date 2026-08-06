import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import type { JsonObject } from '../../src/contracts/value.js';

/** Test-only JWT minting helper for validator and actor-resolution fixtures. */
export function signJwtHs256(
  payload: JsonObject,
  secret: string,
  headerOverrides: { alg?: 'HS256' | 'none'; typ?: string } = {},
): string {
  const alg = headerOverrides.alg ?? 'HS256';
  const options: SignOptions = {
    algorithm: alg,
    noTimestamp: true,
    ...(headerOverrides.typ === undefined ? {} : { header: { alg, typ: headerOverrides.typ } }),
  };
  if (alg === 'none') return jwt.sign(payload, '', { ...options, algorithm: 'none' });
  return jwt.sign(payload, secret.trim() === '' ? 'x' : secret, options);
}
