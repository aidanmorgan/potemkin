/**
 * Validates that a command actor's scopes are a superset of the required scopes
 * declared on a behavior's `match.required_scopes` field.
 */

import type { Actor } from '../types.js';
import {
  AuthenticationRequiredError,
  AuthorizationDeniedError,
} from '../errors.js';

/**
 * Check that `actor` has all `requiredScopes`.
 *
 * @throws {AuthenticationRequiredError} (401) if requiredScopes is non-empty but actor is absent.
 * @throws {AuthorizationDeniedError}    (403) if actor exists but scopes are insufficient.
 */
export function checkScopes(
  actor: Actor | undefined,
  requiredScopes: readonly string[],
  behaviorName: string,
): void {
  if (!requiredScopes || requiredScopes.length === 0) return;

  if (!actor) {
    throw new AuthenticationRequiredError(
      `Behavior "${behaviorName}" requires authentication (scopes: ${requiredScopes.join(', ')})`,
      { behavior: behaviorName, requiredScopes: requiredScopes as string[] },
    );
  }

  const actorScopeSet = new Set(actor.scopes);
  const missing = requiredScopes.filter(s => !actorScopeSet.has(s));

  if (missing.length > 0) {
    throw new AuthorizationDeniedError(
      `Actor "${actor.id}" lacks required scopes for behavior "${behaviorName}": ${missing.join(', ')}`,
      {
        behavior: behaviorName,
        actorId: actor.id,
        requiredScopes: requiredScopes as string[],
        missingScopes: missing,
        actorScopes: actor.scopes as string[],
      },
    );
  }
}
