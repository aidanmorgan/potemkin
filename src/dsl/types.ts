import type { Intent, JsonObject, JsonValue } from '../types.js';
import type { DeclaredState } from './schemaInference.js';
import type { ScriptRegistry } from '../scripts/types.js';

export interface EventCatalogEntry {
  readonly type: string;                              // event type key
  readonly payloadTemplate: Record<string, string>;   // map fieldName → CEL expression
  /** Optional OpenAPI $ref path for runtime payload schema validation */
  readonly schemaRef?: string;
}

/** Named guard evaluated before match.condition; failure → 422 */
export interface RequiresGuard {
  readonly name: string;
  readonly condition: string;     // CEL boolean
  readonly errorCode: string;
  readonly errorMessage: string;
}

/** Conditional event emission entry */
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
    readonly requires?: readonly RequiresGuard[];
    /** RBAC scopes required to execute this behavior */
    readonly requiredScopes?: readonly string[];
    /** HTTP method for the generated HATEOAS link (e.g. 'GET', 'POST'). Not a request filter — operationId already pins the method. */
    readonly method?: string;
    /** Header matching: each header name → either expected value or "present". AND semantics. */
    readonly headers?: Record<string, string>;
  };
  /** Primary event to emit (optional when emitWhen is present). Mutually exclusive with emitWhen. */
  readonly emit?: string;
  /** Conditional multi-event emission */
  readonly emitWhen?: readonly EmitWhenEntry[];
  readonly dispatchCommands?: readonly SecondaryCommandSpec[];
  /** CEL expression evaluated post-projection; false → abort UoW */
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
  /** Optional gate — false means skip this secondary command */
  readonly condition?: string;
}

export interface ReducerRule {
  readonly on: string;                                // event catalog key
  /** Patch list: { op, path, value }[]. Values are CEL expressions. */
  readonly patches?: readonly ReducerPatchOp[];
  /**
   * Whole-payload replace: set state := the event payload object wholesale,
   * before any `patches:` apply. Cuts per-field boilerplate when an event carries
   * the full next state (common for create events on large schemas).
   */
  readonly replaceState?: boolean;
  /** When 'typescript', the reducer logic lives in a registered TS file — no patches needed. */
  readonly implementation?: 'typescript';
}

export interface ReducerPatchOp {
  readonly op: 'add' | 'remove' | 'replace' | 'append' | 'prepend' | 'increment' | 'merge' | 'upsert' | 'move' | 'copy';
  readonly path: string;
  readonly value?: string | number | boolean | null | Record<string, unknown> | ReadonlyArray<unknown>;
  readonly by?: number;
  readonly key?: string;
  readonly deep?: boolean;
  /** Source JSON Pointer for move/copy ops. */
  readonly from?: string;
}

/** Identity key extraction policy: where to find the entity key on an incoming request. */
export interface IdentityKeyConfig {
  /** Source of the key value. */
  readonly from?: 'path' | 'query' | 'header' | 'payload';
  /** Parameter / header name (lowercased for headers) — used by path/query/header sources. */
  readonly name?: string;
  /** Dot-path within the JSON body — used by payload source. Defaults to `name` if omitted. */
  readonly pointer?: string;
}

export interface IdentityConfig {
  readonly creation?: { readonly generate?: string }; // e.g. '$uuidv7()'
  /** DSL-driven key extraction (path/query/header/payload). */
  readonly key?: IdentityKeyConfig;
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
  /** Fixed pre-response delay in milliseconds (stacks on top of any min/max range). */
  readonly fixed_ms?: number;
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
  /** Per-boundary deprecation envelope. */
  readonly deprecated?: DeprecationConfig;
  /** Per-boundary HATEOAS link entries injected into the response `_links`. */
  readonly hateoas?: readonly HateoasLinkEntry[];
  /** Per-boundary response field mask: these fields are removed from responses. */
  readonly mask?: readonly string[];
  /** Per-boundary uniform-random response latency. */
  readonly latency?: LatencyConfig;
  /** When true, projection auto-sets updatedAt/updatedBy on every non-baseline event. */
  readonly auditFields?: boolean;
  /** Boundary-scoped fault rules — evaluated before global faults for commands on this boundary. */
  readonly faults?: readonly FaultRule[];
  /**
   * Declared state schema: computed (formula-derived, recomputed after patches)
   * and internal (typed) fields.
   */
  readonly state?: DeclaredState;
  /** When false, downgrades the computed-field INCOMPLETE_DEPS check to a WARN. */
  readonly strictSchema?: boolean;
  /**
   * Optional `response: ts:<id>` transform — a registered @Script run on every
   * successful (2xx) response for this boundary. It receives the matched
   * operationId + the engine-computed { status, body } and may return overrides.
   * The generic extension point for response-shape customisation (e.g. a Stripe
   * list envelope or deleted-object shape) without framework changes.
   */
  readonly responseScript?: string;
  /** Choreography reaction rules declared in this boundary file. */
  readonly reactions?: readonly ReactionRule[];
  /** Fragment mixins to merge into this boundary at link time (C4). */
  readonly include?: readonly IncludeEntry[];
}

// ── Cross-file composition (C1: grammar + types) ─────────────────────────────

/**
 * Allowed types for a component parameter declaration.
 * Distinct from the DSL field-type system — these are link-time substitution types.
 */
export type ParameterType = 'string' | 'number' | 'boolean';

/** Declaration of a single named parameter in a component. */
export interface ParameterDecl {
  /** Substitution type — controls type-checking at link time (C2). */
  readonly type: ParameterType;
  /** Default value used when the caller omits this parameter. */
  readonly default?: string | number | boolean;
  /** When true, callers must supply a value (no default allowed simultaneously). */
  readonly required?: boolean;
}

/**
 * A `use:` entry: activates a component as one concrete live boundary.
 * Stashed on CompiledDsl.use for the C3 linker; not resolved in C1.
 */
export interface UseEntry {
  /** Component name to instantiate. */
  readonly component: string;
  /** Concrete boundary name the instantiated boundary will carry. */
  readonly as: string;
  /** OpenAPI route path for the concrete boundary. */
  readonly contractPath: string;
  /** Parameter bindings passed to the component at link time. */
  readonly with?: Record<string, string | number | boolean>;
  /** Maps component-local sibling alias names to concrete boundary names (C5). */
  readonly bind?: Record<string, string>;
}

/**
 * An `include:` entry: merges a component's event_catalog/reducers/behaviors
 * into the containing boundary or component at link time (C4).
 * Stashed on BoundaryConfig/ComponentDefinition for C4; not resolved in C1.
 */
export interface IncludeEntry {
  /** Component name whose fragments are merged in. */
  readonly component: string;
  /** Parameter bindings for this inclusion. */
  readonly with?: Record<string, string | number | boolean>;
}

/**
 * An inert component definition loaded from a `kind: component` file.
 * Components are not live boundaries — they are instantiated via `use:` (C3)
 * or included via `include:` (C4). Stored in CompiledDsl.components.
 */
export interface ComponentDefinition {
  readonly kind: 'component';
  /** Logical component name (must be unique across the catalog). */
  readonly name: string;
  /** Named parameter declarations for link-time substitution. */
  readonly parameters?: Record<string, ParameterDecl>;
  /** Reusable event catalog entries. */
  readonly eventCatalog?: readonly EventCatalogEntry[];
  /** Reusable reducer rules. */
  readonly reducers?: readonly ReducerRule[];
  /** Reusable behavior rules. */
  readonly behaviors?: readonly BehaviorRule[];
  /** Optional identity config (merged into concrete boundary at link time). */
  readonly identity?: IdentityConfig;
  /** Optional declared state schema (merged at link time). */
  readonly state?: DeclaredState;
  /** Choreography reactions declared inside this component. */
  readonly reactions?: readonly ReactionRule[];
  /** Fragment mixins to merge into this component at link time. */
  readonly include?: readonly IncludeEntry[];
}

// ── Reactions (R1: DSL grammar + boot validation) ────────────────────────────

/**
 * A single choreography reaction rule: subscribes to a committed-to-shadow
 * event and emits a new event in the reacting boundary within the same UoW.
 */
export interface ReactionRule {
  /** Optional label for trace logs. */
  readonly name?: string;
  /** Trigger subscription: "Boundary:EventType" or bare "EventType". */
  readonly on: string;
  /** CEL gate — reaction fires only when true (default: true). */
  readonly when?: string;
  /** Reacting boundary name. Required when declared in the global file. */
  readonly boundary?: string;
  /** Event type to emit, resolved against the reacting boundary's event_catalog. */
  readonly emit: string;
  /** mutation (default) or creation. */
  readonly intent?: 'mutation' | 'creation';
  /** CEL resolving to the aggregate id the emitted event applies to. */
  readonly target?: string;
  /** CEL map merged over the emitted event's payload_template. */
  readonly payload?: Record<string, string>;
}

// ── Tier-2 DSL additions ──────────────────────────────────────────────────────

/** Compensation handler for a saga step — runs in reverse order on failure */
export interface SagaCompensation {
  readonly intent: Intent;
  /** OpenAPI operationId of the target boundary behavior this compensation invokes. */
  readonly operationId: string;
  /** CEL expression resolving to target aggregate ID */
  readonly targetId?: string;
  readonly payload?: Record<string, string>;  // CEL expressions
}

/** A single step in a saga */
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

/** Trigger condition for a saga */
export interface SagaTrigger {
  readonly boundary: string;
  readonly intent: Intent;
  readonly condition: string;  // CEL boolean
}

/** Saga definition */
export interface SagaConfig {
  readonly name: string;
  readonly trigger: SagaTrigger;
  readonly steps: readonly SagaStep[];
}

/** Top-level idempotency configuration */
export interface IdempotencyConfig {
  readonly enabled: boolean;
  readonly ttlSeconds: number;
  readonly hashIncludesBody: boolean;
}

/** Key expression (CEL) for derived projection — which entity gets updated */
export interface DerivedProjectionReduceEntry {
  readonly on: string;                            // event type (e.g. "Lead:LeadCreated" or just "LeadCreated")
  readonly patches?: readonly ReducerPatchOp[];
}

/** Derived projection declaration */
export interface DerivedProjectionConfig {
  readonly name: string;
  /** CEL expression that returns the derived entity key from the event context */
  readonly key: string;
  /** Subscribed events in "<Boundary>:<EventType>" or just "<EventType>" format */
  readonly subscribe: readonly string[];
  readonly reduce: readonly DerivedProjectionReduceEntry[];
}

// ── Tier-3 DSL additions ──────────────────────────────────────────────────────

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
  /** Cookie name. Default: `sid`. */
  readonly cookieName?: string;
  /** TTL in seconds. */
  readonly ttlSeconds?: number;
  /** Require CSRF token on state-changing requests. Default: true. */
  readonly csrf?: boolean;
  /**
   * Header carrying the per-session CSRF token. When set, state-changing
   * requests with a live session must present a matching value or receive 403.
   */
  readonly csrfHeader?: string;
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
  /** Master switch. When false, no security headers are injected. Default: true. */
  readonly enabled?: boolean;
  /** Emit `Strict-Transport-Security`. */
  readonly hsts?: boolean;
  /** Emit `X-Content-Type-Options: nosniff`. */
  readonly nosniff?: boolean;
  /** Emit `X-Frame-Options: DENY`. */
  readonly frame_deny?: boolean;
  /** Emit `Referrer-Policy: <value>`. */
  readonly referrer_policy?: string;
  /** Arbitrary additional response headers (name → value). */
  readonly custom_headers?: Record<string, string>;
}

/** HATEOAS link generation config. */
export interface HateoasConfig {
  readonly enabled?: boolean;
  /** Optional URL prefix for absolute hrefs. */
  readonly baseUrl?: string;
  /** Include `self` links. Default: true. */
  readonly selfLinks?: boolean;
}

/** A single declared API version. */
export interface VersionDecl {
  /** Version name, e.g. "v1". */
  readonly version: string;
  /** URL path prefix that selects this version, e.g. "/v1". */
  readonly prefix: string;
  /** When true, requests without a recognised version prefix route to this version. */
  readonly default?: boolean;
}

/**
 * API versioning config. When `enabled`, the router strips the matching version
 * prefix from the request path before contract lookup, and responses are tagged
 * with `X-Potemkin-Version`.
 */
export interface VersioningConfig {
  readonly enabled?: boolean;
  readonly versions?: readonly VersionDecl[];
}

/** Outbound webhook declaration: HMAC-signed HTTP POST on matching event emission. */
export interface WebhookConfig {
  readonly name: string;
  readonly trigger: {
    readonly boundary?: string;
    readonly intent?: Intent;
    /** CEL guard evaluated against the emitted event (defaults to "true"). */
    readonly condition: string;
  };
  /** Destination URL (CEL string expression or literal). */
  readonly url: string;
  /** Shared secret used to compute the HMAC-SHA256 signature. */
  readonly secret?: string;
  /** Payload template (CEL string values), serialised to JSON for the POST body. */
  readonly payload?: Record<string, string>;
  readonly retry?: {
    readonly maxAttempts?: number;
    readonly delayMs?: number;
  };
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

/**
 * Reaction registry keyed by trigger event string.
 *
 * Each key is either a qualified "<Boundary>:<EventType>" or a bare "<EventType>".
 * At runtime, for a given emitted event, look up both the qualified key and the
 * bare key to find all reactions that should fire.
 *
 * Built at compile time from all reactions (boundary files + global config) and
 * attached to the CompiledDsl so boot-time cross-reference validation and the
 * runtime UoW (R3) can share a single pre-built index.
 */
export type ReactionsByTrigger = ReadonlyMap<string, readonly ReactionRule[]>;

/** Static response produced by a fallback rule / default (for unmatched requests). */
export interface FallbackResponse {
  readonly status: number;
  readonly body?: JsonValue;
}

/** Match predicate for a fallback rule. All present fields must hold (AND). */
export interface FallbackRuleMatch {
  /** Glob over the request path (`*` within a segment, `**` across segments). */
  readonly path?: string;
  /** HTTP method (case-insensitive). */
  readonly method?: string;
  /** Whether the request path matches a declared OpenAPI path template. */
  readonly inContract?: boolean;
}

export interface FallbackRule {
  readonly match: FallbackRuleMatch;
  readonly respond: FallbackResponse;
}

/**
 * `fallback:` — policy for requests that match no boundary. Ordered rules
 * (first match wins) plus an optional default. With no config the engine
 * defaults to 501 for in-contract paths and 404 otherwise.
 */
export interface FallbackConfig {
  readonly rules?: readonly FallbackRule[];
  readonly default?: FallbackResponse;
}

export interface CompiledDsl {
  readonly boundaries: readonly BoundaryConfig[];
  readonly byContractPath: Record<string, BoundaryConfig>;
  readonly byBoundaryName: Record<string, BoundaryConfig>;
  /**
   * Component catalog: inert definitions parsed from `kind: component` files.
   * Populated by C1; consumed by the C3 linker (use:) and C4 merger (include:).
   * Absent when no component files were loaded.
   */
  readonly components?: Record<string, ComponentDefinition>;
  /**
   * Unresolved `use:` entries from mapping/simulation files.
   * Stashed here by C1 for the C3 linker to consume; not live boundaries yet.
   */
  readonly use?: readonly UseEntry[];
  /** Script registry built at boot time */
  readonly scriptRegistry?: ScriptRegistry;
  readonly sagas?: readonly SagaConfig[];
  readonly idempotency?: IdempotencyConfig;
  readonly derivedProjections?: readonly DerivedProjectionConfig[];
  /** Header-driven fault / chaos rules. */
  readonly faults?: readonly FaultRule[];
  /** Policy for requests that match no boundary (501/404/custom). */
  readonly fallback?: FallbackConfig;
  /** Auth configuration (JWT, session, simple bearer). */
  readonly auth?: AuthConfig;
  /** Security response headers. */
  readonly securityHeaders?: SecurityHeadersConfig;
  /** HATEOAS link generation. */
  readonly hateoas?: HateoasConfig;
  /** API versioning. */
  readonly versioning?: VersioningConfig;
  /** Outbound webhook declarations (HMAC-signed dispatch on event emission). */
  readonly webhooks?: readonly WebhookConfig[];
  /** Choreography reaction rules from all boundary files and the global config. */
  readonly reactions?: readonly ReactionRule[];
  /**
   * Reaction registry keyed by trigger event string.
   * Keys are either "<Boundary>:<EventType>" (qualified) or "<EventType>" (bare).
   * At runtime, consult both the qualified key and the bare key for a given event.
   * Built at compile time; absent when there are no reactions.
   */
  readonly reactionsByTrigger?: ReactionsByTrigger;
}

// JsonValue is used transitively by SagaStep consumers
export type { JsonValue };
