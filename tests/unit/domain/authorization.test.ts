import { authorize, hasRequiredScopes } from '../../../src/domain/authorization.js';

describe('authorization domain policy', () => {
  it('requires every declared scope and distinguishes missing authentication', () => {
    expect(hasRequiredScopes(['orders:read', 'orders:write'], ['orders:read'])).toBe(true);
    expect(hasRequiredScopes(['orders:read'], ['orders:read', 'orders:write'])).toBe(false);
    expect(authorize(undefined, ['orders:read'], undefined)).toEqual({
      allowed: false,
      reason: 'authentication-required',
    });
  });

  it('keeps policy denial distinct from a missing scope', () => {
    expect(authorize(['orders:read'], ['orders:write'], undefined)).toEqual({
      allowed: false,
      reason: 'scope-missing',
    });
    expect(authorize(['orders:write'], ['orders:write'], false)).toEqual({
      allowed: false,
      reason: 'policy-denied',
    });
    expect(authorize(['orders:write'], ['orders:write'], true)).toEqual({ allowed: true });
  });
});
