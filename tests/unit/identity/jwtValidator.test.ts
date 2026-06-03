/**
 * Unit tests for the JWT validator. Verifies signature, algorithm, claim
 * validation and Actor extraction for the configurable HS256 mode.
 */
import { validateJwt, signJwtHs256, JwtValidationError } from '../../../src/identity/jwtValidator';
import type { JwtAuthConfig } from '../../../src/dsl/types';

const SECRET = 'test-secret';

function baseConfig(overrides: Partial<JwtAuthConfig> = {}): JwtAuthConfig {
  return {
    secret: SECRET,
    algorithm: 'HS256',
    issuer: 'tester',
    audience: 'api',
    ...overrides,
  };
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

describe('identity/jwtValidator', () => {
  it('returns Actor for a valid signed JWT', async () => {
    const token = await signJwtHs256(
      { sub: 'alice', scopes: 'manager admin', iss: 'tester', aud: 'api', exp: nowSec() + 60 },
      SECRET,
    );
    const actor = validateJwt(token, baseConfig());
    expect(actor.id).toBe('alice');
    expect(actor.scopes).toEqual(['manager', 'admin']);
  });

  it('accepts a scopes[] array', async () => {
    const token = await signJwtHs256(
      { sub: 'bob', scopes: ['viewer', 'agent'], iss: 'tester', aud: 'api', exp: nowSec() + 60 },
      SECRET,
    );
    const actor = validateJwt(token, baseConfig());
    expect(actor.scopes).toEqual(['viewer', 'agent']);
  });

  it('honours a configured subjectClaim', async () => {
    const token = await signJwtHs256(
      { user_id: 'carol', scopes: 'manager', iss: 'tester', aud: 'api', exp: nowSec() + 60 },
      SECRET,
    );
    const actor = validateJwt(token, baseConfig({ subjectClaim: 'user_id' }));
    expect(actor.id).toBe('carol');
  });

  it('rejects malformed JWTs (segment count)', () => {
    expect(() => validateJwt('not.a.valid.jwt.token', baseConfig()))
      .toThrow(JwtValidationError);
  });

  it('rejects JWTs signed with the wrong secret', async () => {
    const token = await signJwtHs256(
      { sub: 'alice', scopes: 'manager', iss: 'tester', aud: 'api', exp: nowSec() + 60 },
      'a-different-secret',
    );
    try {
      validateJwt(token, baseConfig());
      fail('expected JwtValidationError');
    } catch (err) {
      expect(err).toBeInstanceOf(JwtValidationError);
      expect((err as JwtValidationError).code).toBe('JWT_INVALID_SIGNATURE');
    }
  });

  it('rejects expired JWTs', async () => {
    const token = await signJwtHs256(
      { sub: 'alice', scopes: 'manager', iss: 'tester', aud: 'api', exp: nowSec() - 10 },
      SECRET,
    );
    try {
      validateJwt(token, baseConfig());
      fail('expected JwtValidationError');
    } catch (err) {
      expect((err as JwtValidationError).code).toBe('JWT_EXPIRED');
    }
  });

  it('rejects JWTs whose nbf is in the future', async () => {
    const token = await signJwtHs256(
      {
        sub: 'alice',
        scopes: 'manager',
        iss: 'tester',
        aud: 'api',
        nbf: nowSec() + 3600,
        exp: nowSec() + 7200,
      },
      SECRET,
    );
    try {
      validateJwt(token, baseConfig());
      fail('expected JwtValidationError');
    } catch (err) {
      expect((err as JwtValidationError).code).toBe('JWT_NOT_YET_VALID');
    }
  });

  it('rejects alg: none', async () => {
    const token = await signJwtHs256(
      { sub: 'alice', scopes: 'manager', iss: 'tester', aud: 'api', exp: nowSec() + 60 },
      SECRET,
      { alg: 'none' },
    );
    try {
      validateJwt(token, baseConfig());
      fail('expected JwtValidationError');
    } catch (err) {
      expect((err as JwtValidationError).code).toBe('JWT_UNSUPPORTED_ALG');
    }
  });

  it('rejects wrong issuer when issuer is configured', async () => {
    const token = await signJwtHs256(
      { sub: 'alice', scopes: 'manager', iss: 'evil', aud: 'api', exp: nowSec() + 60 },
      SECRET,
    );
    try {
      validateJwt(token, baseConfig());
      fail('expected JwtValidationError');
    } catch (err) {
      expect((err as JwtValidationError).code).toBe('JWT_INVALID_ISSUER');
    }
  });

  it('rejects wrong audience when audience is configured', async () => {
    const token = await signJwtHs256(
      { sub: 'alice', scopes: 'manager', iss: 'tester', aud: 'other', exp: nowSec() + 60 },
      SECRET,
    );
    try {
      validateJwt(token, baseConfig());
      fail('expected JwtValidationError');
    } catch (err) {
      expect((err as JwtValidationError).code).toBe('JWT_INVALID_AUDIENCE');
    }
  });

  it('accepts an aud array that contains the configured audience', async () => {
    const token = await signJwtHs256(
      {
        sub: 'alice',
        scopes: 'manager',
        iss: 'tester',
        aud: ['other', 'api'],
        exp: nowSec() + 60,
      },
      SECRET,
    );
    const actor = validateJwt(token, baseConfig());
    expect(actor.id).toBe('alice');
  });

  it('rejects JWTs missing the configured subject claim', async () => {
    const token = await signJwtHs256(
      { scopes: 'manager', iss: 'tester', aud: 'api', exp: nowSec() + 60 },
      SECRET,
    );
    try {
      validateJwt(token, baseConfig());
      fail('expected JwtValidationError');
    } catch (err) {
      expect((err as JwtValidationError).code).toBe('JWT_MISSING_CLAIM');
    }
  });

  describe('blank shared secret guard', () => {
    const blankSecrets = ['', ' ', '\t', '   \n'];

    it.each(blankSecrets)('rejects token when secret is %j', async (blankSecret) => {
      const token = await signJwtHs256(
        { sub: 'alice', scopes: 'manager', iss: 'tester', aud: 'api', exp: nowSec() + 60 },
        blankSecret,
      );
      try {
        validateJwt(token, baseConfig({ secret: blankSecret }));
        fail('expected JwtValidationError');
      } catch (err) {
        expect(err).toBeInstanceOf(JwtValidationError);
        expect((err as JwtValidationError).code).toBe('JWT_BLANK_SECRET');
      }
    });

    it('rejects a token signed with a real secret when config secret is blank', async () => {
      const token = await signJwtHs256(
        { sub: 'alice', scopes: 'manager', iss: 'tester', aud: 'api', exp: nowSec() + 60 },
        SECRET,
      );
      try {
        validateJwt(token, baseConfig({ secret: '' }));
        fail('expected JwtValidationError');
      } catch (err) {
        expect(err).toBeInstanceOf(JwtValidationError);
        expect((err as JwtValidationError).code).toBe('JWT_BLANK_SECRET');
      }
    });
  });

  describe('requiredClaims enforcement', () => {
    it('is a no-op when requiredClaims is not configured', async () => {
      const token = await signJwtHs256(
        { sub: 'alice', scopes: 'manager', iss: 'tester', aud: 'api', exp: nowSec() + 60 },
        SECRET,
      );
      const actor = validateJwt(token, baseConfig());
      expect(actor.id).toBe('alice');
    });

    it('is a no-op when requiredClaims is an empty object', async () => {
      const token = await signJwtHs256(
        { sub: 'alice', scopes: 'manager', iss: 'tester', aud: 'api', exp: nowSec() + 60 },
        SECRET,
      );
      const actor = validateJwt(token, baseConfig({ requiredClaims: {} }));
      expect(actor.id).toBe('alice');
    });

    it('accepts a token that has all required claims with matching values', async () => {
      const token = await signJwtHs256(
        { sub: 'alice', scopes: 'manager', iss: 'tester', aud: 'api', exp: nowSec() + 60, tenant: 'acme', role: 'admin' },
        SECRET,
      );
      const actor = validateJwt(token, baseConfig({ requiredClaims: { tenant: 'acme', role: 'admin' } }));
      expect(actor.id).toBe('alice');
    });

    it('accepts a token when expected is * and claim is present with any value', async () => {
      const token = await signJwtHs256(
        { sub: 'alice', scopes: 'manager', iss: 'tester', aud: 'api', exp: nowSec() + 60, tenant: 'anything' },
        SECRET,
      );
      const actor = validateJwt(token, baseConfig({ requiredClaims: { tenant: '*' } }));
      expect(actor.id).toBe('alice');
    });

    it('rejects a token that is missing a required claim', async () => {
      const token = await signJwtHs256(
        { sub: 'alice', scopes: 'manager', iss: 'tester', aud: 'api', exp: nowSec() + 60 },
        SECRET,
      );
      try {
        validateJwt(token, baseConfig({ requiredClaims: { tenant: 'acme' } }));
        fail('expected JwtValidationError');
      } catch (err) {
        expect(err).toBeInstanceOf(JwtValidationError);
        expect((err as JwtValidationError).code).toBe('JWT_MISSING_CLAIM');
        expect((err as JwtValidationError).message).toContain('tenant');
      }
    });

    it('rejects a token with a required claim present but wrong value', async () => {
      const token = await signJwtHs256(
        { sub: 'alice', scopes: 'manager', iss: 'tester', aud: 'api', exp: nowSec() + 60, tenant: 'wrong' },
        SECRET,
      );
      try {
        validateJwt(token, baseConfig({ requiredClaims: { tenant: 'acme' } }));
        fail('expected JwtValidationError');
      } catch (err) {
        expect(err).toBeInstanceOf(JwtValidationError);
        expect((err as JwtValidationError).code).toBe('JWT_CLAIM_MISMATCH');
        expect((err as JwtValidationError).message).toContain('tenant');
      }
    });

    it('rejects when expected is * but claim is absent', async () => {
      const token = await signJwtHs256(
        { sub: 'alice', scopes: 'manager', iss: 'tester', aud: 'api', exp: nowSec() + 60 },
        SECRET,
      );
      try {
        validateJwt(token, baseConfig({ requiredClaims: { tenant: '*' } }));
        fail('expected JwtValidationError');
      } catch (err) {
        expect(err).toBeInstanceOf(JwtValidationError);
        expect((err as JwtValidationError).code).toBe('JWT_MISSING_CLAIM');
      }
    });

    it('coerces non-string claim values to string for comparison', async () => {
      const token = await signJwtHs256(
        { sub: 'alice', scopes: 'manager', iss: 'tester', aud: 'api', exp: nowSec() + 60, level: 5 },
        SECRET,
      );
      const actor = validateJwt(token, baseConfig({ requiredClaims: { level: '5' } }));
      expect(actor.id).toBe('alice');
    });
  });
});
