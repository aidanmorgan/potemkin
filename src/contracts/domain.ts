import type { Actor } from './identity.js';
import type { JsonObject, JsonValue } from './value.js';

/** Intent of a command entering or cascading through the runtime. */
export type Intent = 'creation' | 'mutation' | 'query';

export type Origin = 'inbound' | 'secondary';

export interface Command {
  readonly commandId: string;
  readonly boundary: string;
  readonly intent: Intent;
  readonly targetId: string | null;
  readonly payload: JsonObject;
  readonly queryParams: Record<string, string | string[]>;
  readonly httpMethod: string;
  readonly path: string;
  readonly operationId?: string;
  readonly sequenceVersion?: number;
  readonly origin: Origin;
  readonly depth: number;
  readonly actor?: Actor;
  readonly headers?: Record<string, string>;
}

export interface EventRequestSnapshot {
  readonly method: string;
  readonly path: string;
  readonly query?: Record<string, string | string[]>;
  readonly headers: Record<string, string>;
  readonly payload: JsonObject;
  readonly actorId?: string;
  readonly actorScopes?: readonly string[];
  readonly originalActorId?: string;
  readonly originalActorScopes?: readonly string[];
}

export interface EventResponseSnapshot {
  readonly status: number;
  readonly body?: JsonValue;
  readonly headers?: Record<string, string>;
}

export interface DomainEvent {
  readonly eventId: string;
  readonly boundary: string;
  readonly aggregateId: string;
  readonly type: string;
  readonly payload: JsonObject;
  readonly timestamp: string;
  readonly sequenceVersion: number;
  readonly causedBy: string | null;
  readonly intent?: Intent;
  readonly request?: EventRequestSnapshot;
  readonly response?: EventResponseSnapshot;
}

export interface ExecutionResult {
  readonly status: number;
  readonly body: JsonValue;
  readonly headers?: Record<string, string>;
  readonly events: readonly DomainEvent[];
}
