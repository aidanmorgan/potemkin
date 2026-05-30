import type { Intent, JsonObject, JsonValue } from '../types.js';

export interface EventCatalogEntry {
  readonly type: string;                              // event type key
  readonly payloadTemplate: Record<string, string>;   // map fieldName → CEL expression
  /** REQ-65: optional OpenAPI $ref path for runtime payload schema validation */
  readonly schemaRef?: string;
}

/** REQ-61: named guard evaluated before match.condition; failure → 422 */
export interface RequiresGuard {
  readonly name: string;
  readonly condition: string;     // CEL boolean (was "expression" in design.md — using "condition" per task spec)
  readonly errorCode: string;
  readonly errorMessage: string;
}

/** REQ-64: conditional event emission entry */
export interface EmitWhenEntry {
  readonly when: string;   // CEL boolean
  readonly emit: string;   // event catalog key
}

export interface BehaviorRule {
  readonly name: string;
  readonly match: {
    /** Canonical matcher: the OpenAPI operationId this behavior handles. */
    readonly operationId: string;
    readonly condition: string;
    /** REQ-61 */
    readonly requires?: readonly RequiresGuard[];
    /** REQ-84: RBAC scopes required to execute this behavior */
    readonly requiredScopes?: readonly string[];
    /** Optional HTTP method filter (e.g. 'GET', 'POST'). */
    readonly method?: string;
    /** Header matching: each header name → either expected value or "present". AND semantics. */
    readonly headers?: Record<string, string>;
  };
  /** Primary event to emit (optional when emitWhen is present). REQ-64 mutual exclusion with emitWhen. */
  readonly emit?: string;
  /** REQ-64: conditional multi-event emission */
  readonly emitWhen?: readonly EmitWhenEntry[];
  readonly dispatchCommands?: readonly SecondaryCommandSpec[];
  /** REQ-62: CEL expression evaluated post-projection; false → abort UoW */
  readonly postcondition?: string;
  /** HATEOAS link name this behavior advertises (e.g. "convert"). */
  readonly linkName?: string;
  /** CEL boolean — link is only listed when this is true. Independent of match.condition. */
  readonly linkCondition?: string;
}

export interface SecondaryCommandSpec {
  readonly boundary: string;
  readonly intent: Intent;
  /** OpenAPI operationId of the target boundary's behavior this cascade invokes. */
  readonly operationId: string;
  readonly targetId: string;                          // CEL expression resolving to a string
  readonly payload?: Record<string, string>;          // CEL expressions
  /** REQ-63: optional gate — false means skip this secondary command */
  readonly condition?: string;
}

export interface ReducerRule {
  readonly on: string;                                // event catalog key
  /** Patch list: { op, path, value }[]. Values are CEL expressions. */
  readonly patches?: readonly ReducerPatchOp[];
}

export interface ReducerPatchOp {
  readonly op: 'add' | 'remove' | 'replace' | 'append' | 'prepend' | 'increment' | 'merge' | 'upsert';
  readonly path: string;
  readonly value?: string | number | boolean | null | Record<string, unknown> | ReadonlyArray<unknown>;
  readonly by?: number;
  readonly key?: string;
  readonly deep?: boolean;
}

/** Identity key extraction policy: where to find the entity key on an incoming request. */
export interface IdentityKeyConfig {
  /** Source of the key value. Optional only when `cel` is provided. */
  readonly from?: 'path' | 'query' | 'header' | 'payload';
  /** Parameter / header name (lowercased for headers) — used by path/query/header sources. */
  readonly name?: string;
  /** Dot-path within the JSON body — used by payload source. Defaults to `name` if omitted. */
  readonly pointer?: string;
  /** CEL escape hatch — when provided, evaluated against ctx with `request`, `state`, `payload`. */
  readonly cel?: string;
}

export interface IdentityConfig {
  readonly creation?: { readonly generate?: string }; // e.g. '$uuidv7()'
  /** REQ — DSL-driven key extraction (path/query/header/payload + optional CEL). */
  readonly key?: IdentityKeyConfig;
}

/** REQ-66: named TypeScript module declared in a boundary config */
export interface ScriptDeclaration {
  readonly name: string;
  readonly code: string;   // TypeScript source (field is "code" in YAML; design uses "source" but task says "code")
}

/** A HATEOAS link entry: a relation name and its (templated) href. */
export interface HateoasLinkEntry {
  readonly rel: string;
  readonly href: string;
}

/** Per-boundary deprecation envelope: emit Deprecation + Sunset headers. */
export interface DeprecationConfig {
  /** ISO-8601 deprecation date (becomes `Deprecation:` header). */
  readonly date: string;
  /** ISO-8601 sunset date (becomes `Sunset:` header). */
  readonly sunset?: string;
  /** Optional replacement path (becomes `Link: <path>; rel="successor-version"`). */
  readonly replacement?: string;
}

/** Per-boundary configurable latency (uniform random in [min, max]). */
export interface LatencyConfig {
  readonly min_ms?: number;
  readonly max_ms?: number;
}

export interface BoundaryConfig {
  readonly boundary: string;                          // logical namespace
  readonly contractPath: string;                      // OpenAPI route
  readonly fallbackOverride: boolean;
  readonly identity?: IdentityConfig;
  readonly queryMapping?: Record<string, string>;
  readonly behaviors: readonly BehaviorRule[];
  readonly reducers: readonly ReducerRule[];
  readonly eventCatalog: readonly EventCatalogEntry[];
  readonly initialization?: readonly JsonObject[];
  /** REQ-66: optional inline TypeScript scripts */
  readonly scripts?: readonly ScriptDeclaration[];
  /** Per-boundary deprecation envelope. */
  readonly deprecated?: DeprecationConfig;
  /** Per-boundary HATEOAS link entries injected into the response `_links` (D1). */
  readonly hateoas?: readonly HateoasLinkEntry[];
  /** Per-boundary response field mask: these fields are removed from responses (D3). */
  readonly mask?: readonly string[];
  /** Per-boundary uniform-random response latency. */
  readonly latency?: LatencyConfig;
  /** When true, projection auto-sets updatedAt/updatedBy on every non-baseline event. */
  readonly auditFields?: boolean;
  /**
   * Declared state schema: computed (formula-derived, recomputed after patches)
   * and internal (typed) fields. Feeds buildInferredSchema at boot and
   * recomputeComputedFields at projection time.
   */
  readonly state?: import('./schemaInference.js').DeclaredState;
  /** When false, downgrades the computed-field INCOMPLETE_DEPS check to a WARN. */
  readonly strictSchema?: boolean;
}

// ── Tier-2 DSL additions ──────────────────────────────────────────────────────

/** REQ-73: Compensation handler for a saga step — runs in reverse order on failure */
export interface SagaCompensation {
  readonly intent: Intent;
  /** OpenAPI operationId of the target boundary behavior this compensation invokes. */
  readonly operationId: string;
  /** CEL expression resolving to target aggregate ID */
  readonly targetId?: string;
  readonly payload?: Record<string, string>;  // CEL expressions
}

/** REQ-73: A single step in a saga */
export interface SagaStep {
  readonly name: string;
  readonly boundary: string;
  readonly intent: Intent;
  /** OpenAPI operationId of the target boundary behavior this step invokes. */
  readonly operationId: string;
  /** CEL expression resolving to target aggregate ID */
  readonly targetId?: string;
  readonly payload?: Record<string, string>;  // CEL expressions
  readonly compensation?: SagaCompensation;
}

/** REQ-73: Trigger condition for a saga */
export interface SagaTrigger {
  readonly boundary: string;
  readonly intent: Intent;
  readonly condition: string;  // CEL boolean
}

/** REQ-73: Saga definition */
export interface SagaConfig {
  readonly name: string;
  readonly trigger: SagaTrigger;
  readonly steps: readonly SagaStep[];
}

/** REQ-81: Top-level idempotency configuration */
export interface IdempotencyConfig {
  readonly enabled: boolean;
  readonly ttlSeconds: number;
  readonly hashIncludesBody: boolean;
}

/** REQ-88: Key expression (CEL) for derived projection — which entity gets updated */
export interface DerivedProjectionReduceEntry {
  readonly on: string;                            // event type (e.g. "Lead:LeadCreated" or just "LeadCreated")
  readonly assign?: Record<string, string>;        // dot-path → CEL
  readonly append?: Record<string, string>;        // array path → CEL
  readonly patches?: readonly ReducerPatchOp[];    // new-format patches list
}

/** REQ-88: Derived projection declaration */
export interface DerivedProjectionConfig {
  readonly name: string;
  /** CEL expression that returns the derived entity key from the event context */
  readonly key: string;
  /** Subscribed events in "<Boundary>:<EventType>" or just "<EventType>" format */
  readonly subscribe: readonly string[];
  readonly reduce: readonly DerivedProjectionReduceEntry[];
}

// ── Tier-3 DSL additions: header-driven faults, auth modes, hateoas, versioning ──

/** A canned fault rule response shape — what the engine returns when the rule fires. */
export interface FaultResponse {
  readonly status: number;
  readonly body?: JsonValue;
  readonly headers?: Record<string, string>;
}

/** Declarative chaos / fault rule (loaded from YAML `faults:` block). */
export interface FaultRule {
  readonly name: string;
  readonly match: {
    /** Optional boundary filter. */
    readonly boundary?: string;
    /** Optional intent filter. */
    readonly intent?: Intent;
    /** Required-header matching: name → expected value (or "present" / "*" sentinel). */
    readonly headers?: Record<string, string>;
    /** CEL expression — main guard (defaults to "true"). */
    readonly condition: string;
    /** Named requires guards. */
    readonly requires?: readonly RequiresGuard[];
    /** RBAC scopes required to apply this rule. */
    readonly requiredScopes?: readonly string[];
    /** Probability gate (0..1). */
    readonly probability?: number;
    /** Convenience `potemkin:` block (aliases expanded to headers). */
    readonly potemkin?: Record<string, string>;
  };
  /** Static or templated response. */
  readonly response: FaultResponse;
  /** Pre-response delay in milliseconds. */
  readonly delay_ms?: number;
}

/** JWT (HS256) validator config. */
export interface JwtAuthConfig {
  readonly enabled?: boolean;
  /** Shared secret for HS256. */
  readonly secret: string;
  /** Algorithm — must be 'HS256'. */
  readonly algorithm?: 'HS256';
  /** Required issuer. */
  readonly issuer?: string;
  /** Required audience. */
  readonly audience?: string;
  /** Claim → scope mapping (claim name → expected value or '*'). */
  readonly requiredClaims?: Record<string, string>;
  /** Claim path that contains the subject. Default: 'sub'. */
  readonly subjectClaim?: string;
  /** Claim path that contains scopes (string array or space-delimited string). Default: 'scopes'. */
  readonly scopesClaim?: string;
}

/** Session/cookie auth config. */
export interface SessionAuthConfig {
  readonly enabled?: boolean;
  /** Cookie name. Default: `sid`. */
  readonly cookieName?: string;
  /** TTL in seconds. */
  readonly ttlSeconds?: number;
  /** Require CSRF token on state-changing requests. Default: true. */
  readonly csrf?: boolean;
  /** Path of the login endpoint. */
  readonly loginPath?: string;
  /** Path of the logout endpoint. */
  readonly logoutPath?: string;
}

/** Top-level auth mode selection. */
export interface AuthConfig {
  readonly mode?: 'simple' | 'jwt' | 'session';
  readonly jwt?: JwtAuthConfig;
  readonly session?: SessionAuthConfig;
}

/** Security response headers config. */
export interface SecurityHeadersConfig {
  readonly hsts?: boolean;
  readonly nosniff?: boolean;
  readonly frame_deny?: boolean;
  readonly referrer_policy?: string;
}

/** HATEOAS link generation config. */
export interface HateoasConfig {
  readonly enabled?: boolean;
  /** Optional URL prefix for absolute hrefs. */
  readonly baseUrl?: string;
  /** Include `self` links. Default: true. */
  readonly selfLinks?: boolean;
}

/** API versioning config. */
export interface VersioningConfig {
  readonly mode?: 'url' | 'header';
  readonly default?: string;
  readonly versions?: readonly { readonly name: string; readonly openapi?: string; readonly dsl?: readonly string[] }[];
}

/** Event snapshot of request that produced an event (for reducer chaining). */
export interface EventRequestSnapshot {
  readonly method?: string;
  readonly path?: string;
  readonly query?: Record<string, string | string[]>;
  readonly headers?: Record<string, string>;
  readonly payload?: JsonValue;
}

/** Event snapshot of response emitted for the request that produced this event. */
export interface EventResponseSnapshot {
  readonly status: number;
  readonly body?: JsonValue;
  readonly headers?: Record<string, string>;
}

export interface CompiledDsl {
  readonly boundaries: readonly BoundaryConfig[];
  readonly byContractPath: Record<string, BoundaryConfig>;
  readonly byBoundaryName: Record<string, BoundaryConfig>;
  /** REQ-68: script registry built at boot time, attached to CompiledDsl */
  readonly scriptRegistry?: import('../scripts/types.js').ScriptRegistry;
  /** REQ-73: saga declarations */
  readonly sagas?: readonly SagaConfig[];
  /** REQ-81: idempotency configuration */
  readonly idempotency?: IdempotencyConfig;
  /** REQ-88: derived projection declarations */
  readonly derivedProjections?: readonly DerivedProjectionConfig[];
  /** Header-driven fault / chaos rules. */
  readonly faults?: readonly FaultRule[];
  /** Auth configuration (JWT, session, simple bearer). */
  readonly auth?: AuthConfig;
  /** Security response headers. */
  readonly securityHeaders?: SecurityHeadersConfig;
  /** HATEOAS link generation. */
  readonly hateoas?: HateoasConfig;
  /** API versioning. */
  readonly versioning?: VersioningConfig;
}

// suppress unused import lint warning — JsonValue used by SagaStep indirectly
export type { JsonValue };
