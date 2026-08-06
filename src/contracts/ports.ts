import type { Actor } from './identity.js';
import type { Command, DomainEvent, ExecutionResult } from './domain.js';
import type { JsonObject, JsonValue } from './value.js';
import type { CommandId, HttpMethod } from '../domain/references.js';

/** Persistence and time ports used by the source-neutral runtime application. */
export interface RuntimeEventStore {
  readonly append: (events: readonly DomainEvent[]) => void;
  readonly events: (boundary?: string, aggregateId?: string) => readonly DomainEvent[];
  readonly currentSequenceVersion: (aggregateId: string) => number;
  readonly clear: () => void;
}

export interface RuntimeStateStore {
  readonly get: (aggregateId: string) => JsonObject | undefined;
  readonly set: (aggregateId: string, state: JsonObject) => void;
  readonly delete: (aggregateId: string) => void;
  readonly entries: () => readonly (readonly [string, JsonObject])[];
  readonly clear: () => void;
}

export interface RuntimeIdempotencyStore {
  readonly get: (key: string, nowMs?: number) => ExecutionResult | undefined;
  readonly set: (key: string, result: ExecutionResult, ttlSeconds: number) => void;
  readonly clear: () => void;
}

export interface RuntimeClock {
  readonly nowMs: () => number;
  readonly offsetMs: () => number;
  readonly advance: (milliseconds: number) => number;
  readonly reset: () => void;
}

export interface RuntimeSession {
  readonly id: string;
  readonly actor: Readonly<Actor>;
  readonly csrfToken?: string;
  readonly expiresAt?: number;
}

export interface RuntimeSessionStore {
  readonly create?: (actor: Readonly<Actor>, ttlSeconds: number) => RuntimeSession;
  readonly get?: (id: string, nowMs?: number) => RuntimeSession | undefined;
  readonly destroy?: (id: string) => void;
  readonly clear?: () => void;
}

export interface RuntimeWebhookTransport {
  readonly deliver: (
    input: Readonly<{
      url: string;
      body: string;
      headers: Readonly<Record<string, string>>;
      attempts: number;
    }>,
  ) => Promise<void>;
}

/** Minimal source-neutral request carried to an external forwarding adapter. */
export interface RuntimeForwardingRequest {
  readonly command: Readonly<Command>;
  readonly headers: Readonly<Record<string, string>>;
  readonly actor?: Readonly<Actor>;
  readonly identity?: Readonly<{
    readonly original?: Readonly<Actor>;
    readonly effective?: Readonly<Actor>;
  }>;
}

export interface RuntimeForwardingPort {
  readonly forward: (input: Readonly<RuntimeForwardingRequest>) => Promise<ExecutionResult>;
}

export interface RuntimeCorrelationContext {
  readonly traceId?: string;
  readonly commandId?: CommandId;
}

export interface RuntimeRequestResponseObservation {
  readonly request: Readonly<RuntimeForwardingRequest>;
  readonly result: Readonly<ExecutionResult>;
  readonly correlation: Readonly<RuntimeCorrelationContext>;
}

export type RuntimeRequestResponseObserver = (
  observation: Readonly<RuntimeRequestResponseObservation>,
) => void | Promise<void>;

export type RuntimeCaptureDirection = 'request' | 'response';

export interface RuntimeRequestResponseCapturePolicy {
  readonly maxBytes: number;
  readonly redact?: (
    direction: RuntimeCaptureDirection,
    body: JsonValue | null,
  ) => JsonValue | null;
}

export interface RuntimeCapturedBody {
  readonly captured: boolean;
  readonly value?: JsonValue | null;
  readonly bytes: number;
  readonly truncated: boolean;
}

export interface RuntimeTransportRequest {
  readonly method: HttpMethod;
  readonly path: string;
  readonly query: Readonly<Record<string, string | readonly string[]>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: RuntimeCapturedBody;
}

export interface RuntimeTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: RuntimeCapturedBody;
  readonly connectionClosed?: boolean;
}

export interface RuntimeTransportObservation {
  readonly request: Readonly<RuntimeTransportRequest>;
  readonly response: Readonly<RuntimeTransportResponse>;
  readonly correlation: Readonly<RuntimeCorrelationContext>;
}

export type RuntimeTransportObserver = (
  observation: Readonly<RuntimeTransportObservation>,
) => void | Promise<void>;

export interface RuntimeObservability {
  readonly log?: (
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ) => void;
  readonly trace?: <T>(name: string, run: () => Promise<T>) => Promise<T>;
  readonly metric?: (
    name: string,
    value?: number,
    fields?: Readonly<Record<string, string>>,
  ) => void;
  readonly observeRequestResponse?: RuntimeRequestResponseObserver;
  readonly observeTransportRequestResponse?: RuntimeTransportObserver;
  readonly requestResponseCapture?: RuntimeRequestResponseCapturePolicy;
}
