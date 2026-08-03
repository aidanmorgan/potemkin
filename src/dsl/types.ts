import type { Intent, JsonObject, JsonValue } from "../types.js";
import type { DeclaredState } from "./schemaTypes.js";
import type { PotemkinConfig } from "./configSchema.js";
import type { LifecycleDefinition } from "../authoring/lifecycle.js";
import type { PartialControlHeaders } from "../http/controlHeaders.js";
import type { PluginControlConfig } from "../lifecycle/types.js";
import type { ForwardedRequest } from "../http/specmaticTransport.js";

/**
 * Values accepted by the canonical authoring model.
 *
 * YAML compilation uses the default `never` expression parameter, which
 * reduces these aliases to the YAML string/JSON shapes. Direct authoring
 * supplies its typed expression set as `E`; both
 * authoring paths therefore share the same model instead of maintaining a
 * second TypeScript-only set of interfaces.
 */
export type PatchValue =
  | string
  | number
  | boolean
  | null
  | Record<string, unknown>
  | ReadonlyArray<unknown>;
type PhaseValue<E, Phase extends string> = [E] extends [never]
  ? never
  : E extends Record<Phase, infer Value>
    ? Value
    : E;
export type DslExpression<E = never, Phase extends string = string> = [E] extends [never]
  ? string
  : string | PhaseValue<E, Phase>;
export type DslSlot<E = never, Value = JsonValue, Phase extends string = string, Yaml = string> = [
  E,
] extends [never]
  ? Yaml
  : Value | PhaseValue<E, Phase>;

export interface EventCatalogEntry<E = never> {
  readonly type: string; // event type key
  readonly payloadTemplate: Record<string, DslSlot<E, JsonValue, "event-hydration">>; // map fieldName → CEL/expression
  /** Optional OpenAPI $ref path for runtime payload schema validation */
  readonly schemaRef?: string;
}

/** Named guard evaluated before match.condition; failure defaults to 422. */
export interface RequiresGuard<E = never, Phase extends string = "behavior"> {
  readonly name: string;
  readonly condition: DslExpression<E, Phase>; // CEL boolean
  readonly errorCode: string;
  readonly errorMessage: string;
  /** Optional contract-specific failure status; defaults to 422. */
  readonly errorStatus?: number;
}

/** Conditional event emission entry */
export interface EmitWhenEntry<E = never> {
  readonly when: DslExpression<E, "behavior">; // CEL boolean
  readonly emit: string; // event catalog key
}

export interface BehaviorRule<E = never> {
  readonly name: string;
  readonly match: {
    /** Canonical matcher: the OpenAPI operationId this behavior handles. */
    readonly operationId: string;
    readonly condition: DslExpression<E, "behavior">;
    readonly requires?: readonly RequiresGuard<E, "behavior">[];
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
  readonly emitWhen?: readonly EmitWhenEntry<E>[];
  readonly dispatchCommands?: readonly SecondaryCommandSpec<E>[];
  /** CEL expression evaluated post-projection; false → abort UoW */
  readonly postcondition?: DslExpression<E, "behavior">;
  /** HATEOAS link name this behavior advertises (e.g. "convert"). */
  readonly linkName?: string;
  /** CEL boolean — link is only listed when this is true. Independent of match.condition. */
  readonly linkCondition?: DslExpression<E, "behavior">;
  /** Explicit HTTP response status for this behavior. */
  readonly responseStatus?: number;
}

export interface SecondaryCommandSpec<E = never> {
  readonly boundary: string;
  readonly intent: Intent;
  /** OpenAPI operationId of the target boundary's behavior this cascade invokes. */
  readonly operationId: string;
  readonly targetId: DslExpression<E, "behavior">; // expression resolving to a string
  readonly payload?: Record<string, DslSlot<E, JsonValue, "behavior">>; // expressions
  /** Optional gate — false means skip this secondary command */
  readonly condition?: DslExpression<E, "behavior">;
}

export interface ReducerRule<E = never> {
  readonly on: string; // event catalog key
  /** Patch list: { op, path, value }[]. Values are CEL expressions. */
  readonly patches?: readonly ReducerPatchOp<E, "reducer">[];
  /**
   * Whole-payload replace: set state := the event payload object wholesale,
   * before any `patches:` apply. Cuts per-field boilerplate when an event carries
   * the full next state (common for create events on large schemas).
   */
  readonly replaceState?: boolean;
}

export interface ReducerPatchOp<E = never, Phase extends string = "reducer"> {
  readonly op:
    | "add"
    | "remove"
    | "replace"
    | "append"
    | "prepend"
    | "increment"
    | "merge"
    | "upsert"
    | "move"
    | "copy";
  readonly path: string;
  /** YAML patches carry plain JSON values; direct authoring additionally gains
   * the phase-specific callback/value slot. Keeping the YAML branch explicit
   * makes reducer and derived-projection patch arrays structurally compatible. */
  readonly value?: [E] extends [never] ? PatchValue : DslSlot<E, JsonValue, Phase, PatchValue>;
  readonly by?: number;
  readonly key?: string;
  readonly deep?: boolean;
  /** Source JSON Pointer for move/copy ops. */
  readonly from?: string;
}

/** Identity key extraction policy: where to find the entity key on an incoming request. */
export interface IdentityKeyConfig {
  /** Source of the key value. */
  readonly from?: "path" | "query" | "header" | "payload";
  /** Parameter / header name (lowercased for headers) — used by path/query/header sources. */
  readonly name?: string;
  /** Dot-path within the JSON body — used by payload source. Defaults to `name` if omitted. */
  readonly pointer?: string;
}

export interface IdentityConfig<E = never> {
  readonly creation?: { readonly generate?: DslExpression<E, "identity"> }; // e.g. '$uuidv7()'
  /** DSL-driven key extraction (path/query/header/payload). */
  readonly key?: IdentityKeyConfig;
}

/** A HATEOAS link entry: a relation name and its (templated) href. */
export interface HateoasLinkEntry<E = never> {
  readonly rel: string;
  readonly href: DslExpression<E, "response">;
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

/** Declarative query policy compiled into the source-neutral runtime model. */
export interface QuerySortConfig {
  readonly field: string;
  readonly direction?: "asc" | "desc";
}

export interface QueryConfig<E = never> {
  /** Query-parameter names mapped to CEL predicates over the candidate state. */
  readonly fields?: Record<string, DslExpression<E, "query">>;
  /** CEL predicate applied to every candidate state row. */
  readonly filter?: DslExpression<E, "query">;
  /** Default ordering applied before a request-level `sort` override. */
  readonly sort?: readonly QuerySortConfig[];
  /** Literal page size or CEL expression resolving to a number. */
  readonly pageSize?: DslSlot<E, number, "query", string | number>;
  readonly maxPageSize?: number;
  /** CEL expression resolving to an opaque cursor string. */
  readonly cursor?: DslExpression<E, "query">;
  /** Related state fields to expand in every returned row. */
  readonly expand?: readonly string[];
  readonly pagination?: "raw" | "envelope";
  readonly includeDeleted?: boolean;
  /** Literal JSON value or CEL expression used when a targeted query has no row. */
  readonly fallback?: DslSlot<E, JsonValue, "query", JsonValue>;
}

/**
 * One request in an explicit example-export drive plan.
 *
 * Export plans are authoring metadata consumed by the example exporter; they
 * do not change runtime request matching or state-transition behavior.
 */
export interface ExportStep {
  readonly operationId: string;
  readonly body?: JsonObject;
  readonly headers?: Readonly<Record<string, string>>;
}

/** A named target state and the live requests needed to reach it. */
export interface ExportStatePlan {
  readonly name: string;
  readonly steps: readonly ExportStep[];
  /** Optional name from the global saga catalogue used by this drive. */
  readonly saga?: string;
}

/** Explicit example-export drives for branchy or cross-boundary behavior. */
export interface ExportConfig {
  readonly states: readonly ExportStatePlan[];
}

export interface BoundaryConfig<E = never> {
  readonly boundary: string; // logical namespace
  readonly contractPath: string; // OpenAPI route
  /**
   * Name of the `components.schemas.<name>` entry that defines this boundary's
   * state shape. Decouples the state schema from the boundary name so multiple
   * boundaries (collection, by-id, sub-actions) can share one schema. Defaults
   * to the boundary name when omitted.
   */
  readonly schema?: string;
  readonly fallbackOverride?: boolean;
  readonly identity?: IdentityConfig<E>;
  readonly query?: QueryConfig<E>;
  readonly queryMapping?: Record<string, DslExpression<E, "query">>;
  readonly behaviors: readonly BehaviorRule<E>[];
  readonly reducers: readonly ReducerRule<E>[];
  readonly eventCatalog: readonly EventCatalogEntry<E>[];
  readonly initialization?: readonly JsonObject[];
  /** Per-boundary deprecation envelope. */
  readonly deprecated?: DeprecationConfig;
  /** Per-boundary HATEOAS link entries injected into the response `_links`. */
  readonly hateoas?: readonly HateoasLinkEntry<E>[];
  /** Per-boundary response field mask: these fields are removed from responses. */
  readonly mask?: readonly string[];
  /** Per-boundary uniform-random response latency. */
  readonly latency?: LatencyConfig;
  /** When true, projection auto-sets updatedAt/updatedBy on every non-baseline event. */
  readonly auditFields?: boolean;
  /** Boundary-scoped fault rules — evaluated before global faults for commands on this boundary. */
  readonly faults?: readonly FaultRule<E>[];
  /**
   * Declared state schema: computed (formula-derived, recomputed after patches)
   * and internal (typed) fields.
   */
  readonly state?: DeclaredState;
  /** When false, downgrades the computed-field INCOMPLETE_DEPS check to a WARN. */
  readonly strictSchema?: boolean;
  /** Choreography reaction rules declared in this boundary file. */
  readonly reactions?: readonly ReactionRule<E>[];
  /** Name of a registered pure TypeScript helper used for response shaping. */
  readonly response?: string;
  /** Fragment mixins to merge into this boundary at link time (C4). */
  readonly include?: readonly IncludeEntry[];
  /** Optional explicit live drives used by the Specmatic example exporter. */
  readonly export?: ExportConfig;
}

// ── Cross-file composition (C1: grammar + types) ─────────────────────────────

/**
 * Allowed types for a component parameter declaration.
 * Distinct from the DSL field-type system — these are link-time substitution types.
 */
export type ParameterType = "string" | "number" | "boolean";

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
 * Stashed on YamlLinkedProgram.use for the C3 linker; not resolved in C1.
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
 * or included via `include:` (C4). Stored in YamlLinkedProgram.components.
 */
export interface ComponentDefinition<E = never> {
  readonly kind: "component";
  /** Logical component name (must be unique across the catalog). */
  readonly name: string;
  /** Named parameter declarations for link-time substitution. */
  readonly parameters?: Record<string, ParameterDecl>;
  /** Reusable event catalog entries. */
  readonly eventCatalog?: readonly EventCatalogEntry<E>[];
  /** Reusable reducer rules. */
  readonly reducers?: readonly ReducerRule<E>[];
  /** Reusable behavior rules. */
  readonly behaviors?: readonly BehaviorRule<E>[];
  /** Optional identity config (merged into concrete boundary at link time). */
  readonly identity?: IdentityConfig<E>;
  /** Optional declared state schema (merged at link time). */
  readonly state?: DeclaredState;
  /** Optional state-schema name (merged into the boundary's `schema` at link time). */
  readonly schema?: string;
  /** Optional HTTP and response policy fields carried into each `use:` boundary. */
  readonly fallbackOverride?: boolean;
  readonly query?: QueryConfig;
  readonly queryMapping?: Record<string, string>;
  readonly deprecated?: DeprecationConfig;
  readonly hateoas?: readonly HateoasLinkEntry<E>[];
  readonly mask?: readonly string[];
  readonly latency?: LatencyConfig;
  readonly auditFields?: boolean;
  readonly strictSchema?: boolean;
  readonly faults?: readonly FaultRule<E>[];
  /** Choreography reactions declared inside this component. */
  readonly reactions?: readonly ReactionRule<E>[];
  /** Fragment mixins to merge into this component at link time. */
  readonly include?: readonly IncludeEntry[];
}

// ── Reactions (R1: DSL grammar + boot validation) ────────────────────────────

/**
 * A single choreography reaction rule: subscribes to a committed-to-shadow
 * event and emits a new event in the reacting boundary within the same UoW.
 */
export interface ReactionRule<E = never> {
  /** Optional label for trace logs. */
  readonly name?: string;
  /** Trigger subscription: "Boundary:EventType" or bare "EventType". */
  readonly on: string;
  /** CEL gate — reaction fires only when true (default: true). */
  readonly when?: DslExpression<E, "post-commit">;
  /** Reacting boundary name. Required when declared in the global file. */
  readonly boundary?: string;
  /** Event type to emit, resolved against the reacting boundary's event_catalog. */
  readonly emit: string;
  /** mutation (default) or creation. */
  readonly intent?: "mutation" | "creation";
  /** CEL resolving to the aggregate id the emitted event applies to. */
  readonly target?: DslExpression<E, "post-commit">;
  /** CEL map merged over the emitted event's payload_template. */
  readonly payload?: Record<string, DslSlot<E, JsonValue, "post-commit">>;
}

// ── Tier-2 DSL additions ──────────────────────────────────────────────────────

/** Compensation handler for a saga step — runs in reverse order on failure */
export interface SagaCompensation<E = never> {
  readonly intent: Intent;
  /** OpenAPI operationId of the target boundary behavior this compensation invokes. */
  readonly operationId: string;
  /** CEL expression resolving to target aggregate ID */
  readonly targetId?: DslExpression<E, "saga">;
  readonly payload?: Record<string, DslSlot<E, JsonValue, "saga">>; // expressions
}

/** A single step in a saga */
export interface SagaStep<E = never> {
  readonly name: string;
  readonly boundary: string;
  readonly intent: Intent;
  /** OpenAPI operationId of the target boundary behavior this step invokes. */
  readonly operationId: string;
  /** CEL expression resolving to target aggregate ID */
  readonly targetId?: DslExpression<E, "saga">;
  readonly payload?: Record<string, DslSlot<E, JsonValue, "saga">>; // expressions
  readonly compensation?: SagaCompensation<E>;
}

/** Trigger condition for a saga */
export interface SagaTrigger<E = never> {
  readonly boundary: string;
  readonly intent: Intent;
  readonly condition: DslExpression<E, "saga">; // CEL boolean
}

/** Saga definition */
export interface SagaConfig<E = never> {
  readonly name: string;
  readonly trigger: SagaTrigger<E>;
  readonly steps: readonly SagaStep<E>[];
}

/** Top-level idempotency configuration */
export interface IdempotencyConfig {
  readonly enabled: boolean;
  readonly ttlSeconds: number;
  readonly hashIncludesBody: boolean;
}

/** Key expression (CEL) for derived projection — which entity gets updated */
type DerivedProjectionPatch<E> = [E] extends [never]
  ? ReducerPatchOp<E, "reducer">
  : ReducerPatchOp<E, "projection">;

export interface DerivedProjectionReduceEntry<E = never> {
  readonly on: string; // qualified or unqualified event type
  /** YAML values use the existing phase-neutral patch shape. Direct authoring
   * binds callback values to the projection phase. */
  readonly patches?: readonly DerivedProjectionPatch<E>[];
}

/** Derived projection declaration */
export interface DerivedProjectionConfig<E = never> {
  readonly name: string;
  /** CEL expression that returns the derived entity key from the event context */
  readonly key: DslExpression<E, "projection">;
  /** Subscribed events in "<Boundary>:<EventType>" or just "<EventType>" format */
  readonly subscribe: readonly string[];
  readonly reduce: readonly DerivedProjectionReduceEntry<E>[];
}

// ── Tier-3 DSL additions ──────────────────────────────────────────────────────

/** A canned fault rule response shape — what the engine returns when the rule fires. */
export interface FaultResponse {
  readonly status: number;
  readonly body?: JsonValue;
  readonly headers?: Record<string, string>;
}

/** Declarative chaos / fault rule (loaded from YAML `faults:` block). */
export interface FaultRule<E = never> {
  readonly name: string;
  readonly match: {
    /** Optional boundary filter. */
    readonly boundary?: string;
    /** Optional intent filter. */
    readonly intent?: Intent;
    /** Optional OpenAPI operation filter. */
    readonly operationId?: string;
    /** Optional HTTP method filter. */
    readonly method?: string;
    /** Required-header matching: name → expected value (or "present" / "*" sentinel). */
    readonly headers?: Record<string, string>;
    /** CEL expression — main guard (defaults to "true"). */
    readonly condition: DslExpression<E, "fault">;
    /** Named requires guards. */
    readonly requires?: readonly RequiresGuard<E, "fault">[];
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
  readonly algorithm?: "HS256";
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
  readonly mode?: "simple" | "jwt" | "session";
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
export interface WebhookConfig<E = never> {
  readonly name: string;
  readonly trigger: {
    readonly boundary?: string;
    readonly intent?: Intent;
    /** CEL guard evaluated against the emitted event (defaults to "true"). */
    readonly condition: DslExpression<E, "webhook">;
  };
  /** Destination URL (CEL string expression or literal). */
  readonly url: DslExpression<E, "webhook">;
  /** Shared secret used to compute the HMAC-SHA256 signature. */
  readonly secret?: string;
  /** Payload template (CEL string values), serialised to JSON for the POST body. */
  readonly payload?: Record<string, DslSlot<E, JsonValue, "webhook">>;
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
 * attached to the YamlLinkedProgram so parser cross-reference validation and the
 * runtime UoW (R3) can share a single pre-built index.
 */
export type ReactionsByTrigger<E = never> = ReadonlyMap<string, readonly ReactionRule<E>[]>;

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

/** Static transition-model analysis policy. */
export interface CoverageConfig {
  readonly strict?: boolean;
  readonly initial_states?: readonly string[];
  readonly terminal_states?: readonly string[];
  readonly operations?: readonly string[];
  readonly suppress_states?: readonly string[];
}

export interface YamlLinkedProgram {
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
  /** Lifecycle hooks retained as a typed, ordered definition. */
  readonly lifecycle?: LifecycleDefinition;
  /** Optional typed transport/control declarations carried with a TS model. */
  readonly controlHeaders?: PartialControlHeaders;
  readonly forwarding?: ForwardedRequest;
  readonly plugin?: PluginControlConfig;
  /** Validated in-memory equivalent of potemkin.yml, when supplied by TS. */
  readonly potemkinConfig?: PotemkinConfig;
  readonly sagas?: readonly SagaConfig[];
  readonly idempotency?: IdempotencyConfig;
  readonly derivedProjections?: readonly DerivedProjectionConfig[];
  /** Header-driven fault / chaos rules. */
  readonly faults?: readonly FaultRule[];
  /** Policy for requests that match no boundary (501/404/custom). */
  readonly fallback?: FallbackConfig;
  /** Optional per-aggregate structural-analysis policy. */
  readonly coverage?: Readonly<Record<string, CoverageConfig>>;
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
