import { resolveActor, JwtValidationError } from '../../../src/identity/actorResolver';
import { signJwtHs256 } from '../../../src/identity/jwtValidator';
import type { AuthConfig } from '../../../src/dsl/types';

const SECRET = 'top-secret-key';
const JWT_AUTH: AuthConfig = { mode: 'jwt', jwt: { secret: SECRET } };

function validToken(): string {
  return signJwtHs256({ sub: 'alice', scopes: ['trader', 'admin'] }, SECRET);
}

describe('resolveActor — auth-mode-aware actor resolution', () => {
  describe('simple mode / no auth config — legacy bearer shortcut', () => {
    it('parses the legacy "Bearer <id>:<scopes>" shortcut when mode is simple', () => {
      const actor = resolveActor('Bearer mgr1:manager,admin', { mode: 'simple' });
      expect(actor).toEqual({ id: 'mgr1', scopes: ['manager', 'admin'] });
    });

    it('parses the legacy shortcut when no auth config is present (default)', () => {
      const actor = resolveActor('Bearer alice:trader', undefined);
      expect(actor).toEqual({ id: 'alice', scopes: ['trader'] });
    });
  });

  describe('jwt mode', () => {
    it('returns the actor from a valid signed JWT', () => {
      const actor = resolveActor(`Bearer ${validToken()}`, JWT_AUTH);
      expect(actor?.id).toBe('alice');
      expect(actor?.scopes).toEqual(expect.arrayContaining(['trader', 'admin']));
    });

    it('rejects the legacy "Bearer <id>:<scopes>" shortcut with a JwtValidationError', () => {
      expect(() => resolveActor('Bearer mgr1:manager', JWT_AUTH)).toThrow(JwtValidationError);
    });

    it('rejects a token signed with the wrong secret', () => {
      const forged = signJwtHs256({ sub: 'mallory', scopes: ['admin'] }, 'wrong-secret');
      expect(() => resolveActor(`Bearer ${forged}`, JWT_AUTH)).toThrow(JwtValidationError);
    });

    it('returns null when no Authorization header is present (caller decides 401 vs anonymous)', () => {
      expect(resolveActor(undefined, JWT_AUTH)).toBeNull();
    });

    it('throws when auth.mode is jwt but no jwt config is present', () => {
      expect(() => resolveActor('Bearer x.y.z', { mode: 'jwt' })).toThrow(JwtValidationError);
    });
  });
});
