export type AuthorizationDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: 'authentication-required' | 'scope-missing' | 'policy-denied';
    };

export function hasRequiredScopes(
  actual: readonly string[] | undefined,
  required: readonly string[],
): boolean {
  if (required.length === 0) return true;
  const scopes = new Set(actual ?? []);
  return required.every((scope) => scopes.has(scope));
}

/** Evaluate authorization without coupling the decision to HTTP status codes. */
export function authorize(
  actualScopes: readonly string[] | undefined,
  requiredScopes: readonly string[],
  policyDecision: boolean | undefined,
): AuthorizationDecision {
  if (requiredScopes.length > 0 && actualScopes === undefined) {
    return { allowed: false, reason: 'authentication-required' };
  }
  if (!hasRequiredScopes(actualScopes, requiredScopes)) {
    return { allowed: false, reason: 'scope-missing' };
  }
  if (policyDecision === false) return { allowed: false, reason: 'policy-denied' };
  return { allowed: true };
}
