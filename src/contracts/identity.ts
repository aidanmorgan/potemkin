/** Canonical identity contracts shared by runtime, authoring, and transport boundaries. */
export interface Actor {
  readonly id: string;
  readonly scopes: readonly string[];
}

export interface JwtValidationConfig {
  readonly secret: string;
  readonly algorithm?: 'HS256';
  readonly issuer?: string;
  readonly audience?: string;
  readonly requiredClaims?: Readonly<Record<string, string>>;
  readonly subjectClaim?: string;
  readonly scopesClaim?: string;
}
