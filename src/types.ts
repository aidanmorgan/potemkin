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
  readonly sequenceVersion?: number;   // optimistic-concurrency from request
  readonly faultSignal?: string;       // §31 fault simulation
  readonly origin: Origin;
  readonly depth: number;              // 0 for inbound, +1 per secondary cascade
  /** REQ-84: optional actor identity from Authorization Bearer token */
  readonly actor?: Actor;
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
}

export interface ExecutionResult {
  readonly status: number;             // HTTP status
  readonly body: JsonValue;
  readonly headers?: Record<string, string>;
  readonly events: readonly DomainEvent[];   // committed events from this UoW
}
