export type JsonScalar = string | number | boolean | null;
export interface JsonArray extends Array<JsonValue> {}
export interface JsonObject { [k: string]: JsonValue }
export type JsonValue = JsonScalar | JsonArray | JsonObject;

export type Intent = 'creation' | 'mutation' | 'query';
export type Origin = 'inbound' | 'secondary';

/** REQ-84: Actor identity extracted from Authorization header */
export interface Actor {
  readonly id: string;
  readonly scopes: readonly string[];
}

export interface Command {
  readonly commandId: string;          // UUIDv7
  readonly boundary: string;           // logical namespace (e.g. "Opportunity")
  readonly intent: Intent;
  readonly targetId: string | null;    // null for collection queries
  readonly payload: JsonObject;
  readonly queryParams: Record<string, string | string[]>;
  readonly httpMethod: string;
  readonly path: string;
  /**
   * Pre-resolved OpenAPI operationId for this command. Secondary (cascade) commands
   * carry an explicit operationId (their path is synthetic); inbound commands may leave
   * it undefined and let the pattern matcher resolve it from (path, method).
   */
  readonly operationId?: string;
  readonly sequenceVersion?: number;   // optimistic-concurrency from request
  readonly faultSignal?: string;       // §31 fault simulation
  readonly origin: Origin;
  readonly depth: number;              // 0 for inbound, +1 per secondary cascade
  /** REQ-84: optional actor identity from Authorization Bearer token */
  readonly actor?: Actor;
  /** Request headers (lowercased keys) — available for header matching and snapshots. */
  readonly headers?: Record<string, string>;
}

/** Snapshot of the inbound request that produced an event, captured for reducer chaining. */
export interface EventRequestSnapshot {
  readonly method: string;
  readonly path: string;
  readonly query?: Record<string, string | string[]>;
  readonly headers: Record<string, string>;
  readonly payload: JsonObject;
  /** Actor id at the time of the request (when authenticated). */
  readonly actorId?: string;
  /** Actor scopes at the time of the request. */
  readonly actorScopes?: readonly string[];
}

/** Snapshot of the response emitted alongside the event. */
export interface EventResponseSnapshot {
  readonly status: number;
  readonly body?: JsonValue;
  readonly headers?: Record<string, string>;
}

export interface DomainEvent {
  readonly eventId: string;            // UUIDv7 — real-time, except baseline anchored to epoch
  readonly boundary: string;
  readonly aggregateId: string;        // targetId of affected entity
  readonly type: string;               // event-catalog key, or 'System.GenericUpdateEvent', or 'BaselineEntityCreatedEvent'
  readonly payload: JsonObject;
  readonly timestamp: string;          // ISO-8601 UTC
  readonly sequenceVersion: number;    // monotonic per aggregate, starts at 1
  readonly causedBy: string | null;    // originating commandId; null for baseline
  /** Request snapshot — captured at event emission time for reducer chaining. */
  readonly request?: EventRequestSnapshot;
  /** Response snapshot — attached post-commit by the UoW. */
  readonly response?: EventResponseSnapshot;
}

export interface ExecutionResult {
  readonly status: number;             // HTTP status
  readonly body: JsonValue;
  readonly headers?: Record<string, string>;
  readonly events: readonly DomainEvent[];   // committed events from this UoW
}
