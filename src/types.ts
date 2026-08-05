import type { RequestControls } from './contracts/controlHeaders.js';
import type { DataGenerator } from './contracts/data.js';
import type { JsonObject, JsonValue } from './contracts/value.js';
import type { Command, DomainEvent } from './contracts/domain.js';
import type { Actor } from './contracts/identity.js';

/** Common callback context primitives shared by authoring and execution. */
export interface SimulationHelpers {
  readonly now: () => string;
  readonly uuid: () => string;
  readonly random: () => number;
  readonly data: DataGenerator;
  readonly clone: <T>(value: T) => T;
}

export interface SimulationRequest {
  readonly command: Readonly<Command>;
  readonly headers: Readonly<Record<string, string>>;
  readonly actor?: Readonly<Actor>;
  readonly identity?: Readonly<{
    readonly original?: Readonly<Actor>;
    readonly effective?: Readonly<Actor>;
  }>;
  readonly sideEffects?: Readonly<{
    readonly skipSagas?: boolean;
    readonly skipWebhooks?: boolean;
    readonly skipReactions?: boolean;
    readonly skipProjections?: boolean;
    readonly skipDispatch?: boolean;
  }>;
  readonly batchItem?: Readonly<{ index: number; size: number }>;
  readonly controls?: Readonly<RequestControls>;
}

export interface SimulationMatchContext {
  readonly command: Readonly<Command>;
  readonly request: Readonly<SimulationRequest>;
  readonly state: Readonly<JsonObject> | null;
  readonly payload: Readonly<JsonObject>;
  readonly helpers: Readonly<SimulationHelpers>;
}

export interface SimulationEventContext extends SimulationMatchContext {
  readonly event?: Readonly<DomainEvent>;
  readonly payload: Readonly<JsonObject>;
}

export interface SimulationIdentityContext extends SimulationMatchContext {
  readonly boundary: string;
}

export interface SimulationReducerContext {
  readonly boundary: string;
  readonly state: Readonly<JsonObject>;
  readonly event: Readonly<DomainEvent>;
  readonly payload: Readonly<JsonObject>;
  readonly helpers: Readonly<SimulationHelpers>;
}

export interface SimulationQueryContext {
  readonly command: Readonly<Command>;
  readonly request: Readonly<SimulationRequest>;
  readonly state: Readonly<JsonObject>;
  readonly query: Readonly<Record<string, string | readonly string[]>>;
  readonly param?: string | readonly string[];
  readonly helpers: Readonly<SimulationHelpers>;
}

export interface SimulationResponseContext extends SimulationEventContext {
  readonly operationId?: string;
  readonly response: Readonly<{
    readonly status: number;
    readonly body: JsonValue | null;
    readonly headers: Readonly<Record<string, string>>;
  }>;
}

export interface SimulationPostCommitContext extends SimulationEventContext {
  readonly response?: Readonly<{
    readonly status: number;
    readonly body: JsonValue | null;
    readonly headers: Readonly<Record<string, string>>;
  }>;
  readonly committedEvents: readonly DomainEvent[];
}

export interface SimulationFaultContext extends SimulationMatchContext {
  readonly headers: Readonly<Record<string, string>>;
}

export interface SimulationWebhookContext extends SimulationPostCommitContext {
  readonly headers: Readonly<Record<string, string>>;
}

export interface SimulationSagaContext extends SimulationPostCommitContext {
  readonly steps: Readonly<Record<string, Readonly<{ status: number; body: JsonValue | null }>>>;
  readonly prevStep?: Readonly<{ status: number; body: JsonValue | null }>;
}

export interface SimulationProjectionContext extends SimulationPostCommitContext {
  readonly projection: string;
}

export interface SimulationSecurityHeaders {
  readonly enabled?: boolean;
  readonly hsts?: boolean;
  readonly includeSubDomains?: boolean;
  readonly nosniff?: boolean;
  readonly frameDeny?: boolean;
  readonly referrerPolicy?: string;
  readonly customHeaders?: Readonly<Record<string, string>>;
}

export interface SimulationHateoas {
  readonly enabled?: boolean;
  readonly baseUrl?: string;
  readonly selfLinks?: boolean;
}

export interface SimulationVersion {
  readonly version: string;
  readonly prefix: string;
  readonly default?: boolean;
}

export interface SimulationVersioning {
  readonly enabled?: boolean;
  readonly versions?: readonly SimulationVersion[];
}

export interface SimulationLifecycle {
  readonly boot?: () => void | Promise<void>;
  readonly validation?: () => void | Promise<void>;
  readonly initialization?: () => void | Promise<void>;
  readonly request?: (input: Readonly<SimulationMatchContext>) => void | Promise<void>;
  readonly projection?: (input: Readonly<SimulationPostCommitContext>) => void | Promise<void>;
  readonly commit?: (input: Readonly<SimulationPostCommitContext>) => void | Promise<void>;
  readonly postCommit?: (input: Readonly<SimulationPostCommitContext>) => void | Promise<void>;
  readonly reset?: () => void | Promise<void>;
  readonly shutdown?: () => void | Promise<void>;
}

export interface SimulationModelCoverage {
  readonly strict?: boolean;
  readonly initialStates?: readonly string[];
  readonly terminalStates?: readonly string[];
  readonly operations?: readonly string[];
  readonly suppressStates?: readonly string[];
}
