import type { Actor } from './identity.js';
import type { JsonObject, JsonValue } from './value.js';
import type {
  AggregateId,
  BoundaryName,
  CommandId,
  EventId,
  EventType,
  HttpMethod,
  OperationId,
  SequenceVersion,
} from '../domain/references.js';

/** Runtime-owned finite values use const objects so callers get both a type and a value. */
export const Intent = {
  Creation: 'creation',
  Mutation: 'mutation',
  Query: 'query',
} as const;

/** Intent of a command entering or cascading through the runtime. */
export type Intent = (typeof Intent)[keyof typeof Intent];

export const Origin = {
  Inbound: 'inbound',
  Secondary: 'secondary',
} as const;

export type Origin = (typeof Origin)[keyof typeof Origin];

export interface Command {
  readonly commandId: CommandId;
  readonly boundary: BoundaryName;
  readonly intent: Intent;
  readonly targetId: AggregateId | null;
  readonly payload: JsonObject;
  readonly queryParams: Record<string, string | string[]>;
  readonly httpMethod: HttpMethod;
  readonly path: string;
  readonly operationId?: OperationId;
  readonly sequenceVersion?: SequenceVersion;
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
  readonly eventId: EventId;
  readonly boundary: BoundaryName;
  readonly aggregateId: AggregateId;
  readonly type: EventType;
  readonly payload: JsonObject;
  readonly timestamp: string;
  readonly sequenceVersion: SequenceVersion;
  readonly causedBy: CommandId | EventId | null;
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
