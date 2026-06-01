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
  it('returns Actor for a valid signed JWT', () => {
    const token = signJwtHs256(
      { sub: 'alice', scopes: 'manager admin', iss: 'tester', aud: 'api', exp: nowSec() + 60 },
      SECRET,
    );
    const actor = validateJwt(token, baseConfig());
    expect(actor.id).toBe('alice');
    expect(actor.scopes).toEqual(['manager', 'admin']);
  });

  it('accepts a scopes[] array', () => {
    const token = signJwtHs256(
      { sub: 'bob', scopes: ['viewer', 'agent'], iss: 'tester', aud: 'api', exp: nowSec() + 60 },
      SECRET,
    );
    const actor = validateJwt(token, baseConfig());
    expect(actor.scopes).toEqual(['viewer', 'agent']);
  });

  it('honours a configured subjectClaim', () => {
    const token = signJwtHs256(
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

  it('rejects JWTs signed with the wrong secret', () => {
    const token = signJwtHs256(
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

  it('rejects expired JWTs', () => {
    const token = signJwtHs256(
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

  it('rejects JWTs whose nbf is in the future', () => {
    const token = signJwtHs256(
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

  it('rejects alg: none', () => {
    const token = signJwtHs256(
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

  it('rejects wrong issuer when issuer is configured', () => {
    const token = signJwtHs256(
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

  it('rejects wrong audience when audience is configured', () => {
    const token = signJwtHs256(
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

  it('accepts an aud array that contains the configured audience', () => {
    const token = signJwtHs256(
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

  it('rejects JWTs missing the configured subject claim', () => {
    const token = signJwtHs256(
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

    it.each(blankSecrets)('rejects token when secret is %j', (blankSecret) => {
      const token = signJwtHs256(
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

    it('rejects a token signed with a real secret when config secret is blank', () => {
      const token = signJwtHs256(
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
});
