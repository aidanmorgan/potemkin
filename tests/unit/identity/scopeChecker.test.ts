/**
 * REQ-85/86: Scope checking — AuthenticationRequiredError and AuthorizationDeniedError
 */
import { checkScopes } from '../../../src/identity/scopeChecker';
import { AuthenticationRequiredError, AuthorizationDeniedError } from '../../../src/errors';
import type { Actor } from '../../../src/types';

const adminTrader: Actor = { id: 'alice', scopes: ['admin', 'trader'] };
const viewerOnly: Actor = { id: 'bob', scopes: ['viewer'] };

describe('identity/scopeChecker', () => {
  it('passes when no scopes required', () => {
    expect(() => checkScopes(undefined, [], 'testBehavior')).not.toThrow();
    expect(() => checkScopes(adminTrader, [], 'testBehavior')).not.toThrow();
  });

  it('passes when actor has all required scopes', () => {
    expect(() => checkScopes(adminTrader, ['admin'], 'testBehavior')).not.toThrow();
    expect(() => checkScopes(adminTrader, ['admin', 'trader'], 'testBehavior')).not.toThrow();
  });

  it('throws AuthenticationRequiredError (401) when actor is absent and scopes required', () => {
    expect(() => checkScopes(undefined, ['admin'], 'secureBehavior'))
      .toThrow(AuthenticationRequiredError);
  });

  it('AuthenticationRequiredError has status 401 and code AUTH_MISSING', () => {
    try {
      checkScopes(undefined, ['admin'], 'secureBehavior');
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthenticationRequiredError);
      expect((err as AuthenticationRequiredError).status).toBe(401);
      expect((err as AuthenticationRequiredError).code).toBe('AUTH_MISSING');
    }
  });

  it('throws AuthorizationDeniedError (403) when actor lacks required scopes', () => {
    expect(() => checkScopes(viewerOnly, ['admin'], 'secureBehavior'))
      .toThrow(AuthorizationDeniedError);
  });

  it('AuthorizationDeniedError has status 403 and code AUTH_INSUFFICIENT_SCOPES', () => {
    try {
      checkScopes(viewerOnly, ['admin', 'trader'], 'secureBehavior');
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthorizationDeniedError);
      expect((err as AuthorizationDeniedError).status).toBe(403);
      expect((err as AuthorizationDeniedError).code).toBe('AUTH_INSUFFICIENT_SCOPES');
    }
  });

  it('includes missing scopes in error details', () => {
    try {
      checkScopes(viewerOnly, ['admin', 'trader'], 'secureBehavior');
    } catch (err) {
      const details = (err as AuthorizationDeniedError).details as Record<string, unknown>;
      expect(details['missingScopes']).toEqual(['admin', 'trader']);
    }
  });
});
