import type { DataGenerator } from './data.js';
import type { Command, DomainEvent } from './domain.js';
import type { JsonObject, JsonValue } from './value.js';

export type LifecyclePhase =
  | 'boot'
  | 'validation'
  | 'initialization'
  | 'request'
  | 'projection'
  | 'commit'
  | 'post-commit'
  | 'reset'
  | 'shutdown'
  | 'watch'
  | 'reload';

export interface LifecycleContext {
  readonly phase: LifecyclePhase;
  readonly boundary?: string;
  readonly command?: Readonly<Command>;
  readonly event?: Readonly<DomainEvent>;
  readonly state?: Readonly<JsonObject> | null;
  readonly response?: Readonly<{
    readonly status: number;
    readonly body: JsonValue | null;
    readonly headers?: Readonly<Record<string, string>>;
  }>;
  readonly reason?: string;
  readonly reload?: Readonly<{ readonly files: readonly string[] }>;
  readonly helpers: Readonly<LifecycleHelpers>;
}

export interface LifecycleHelpers {
  readonly uuid: () => string;
  readonly now: () => string;
  readonly data?: DataGenerator;
  readonly deepClone: <T>(value: T) => T;
  readonly deepMerge: (left: JsonObject, right: JsonObject) => JsonObject;
}

export type LifecycleHook =
  | {
      readonly name: string;
      readonly phase: LifecyclePhase;
      readonly run: (context: Readonly<LifecycleContext>) => unknown | Promise<unknown>;
    }
  | ((context: Readonly<LifecycleContext>) => unknown | Promise<unknown>);

export interface LifecycleDefinition {
  readonly hooks: readonly LifecycleHook[];
}

export type LifecycleFailurePolicy = 'abort' | 'continue';

export interface LifecycleDependencies {
  readonly uuid: () => string;
  readonly now: () => string;
}

export interface PluginControlConfig {
  readonly url: string;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly minBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly factor?: number;
}

export interface ReadyNotification {
  readonly engine: string;
  readonly version: string;
  readonly startedAt: string;
  readonly contractPaths: readonly string[];
  readonly routesChecksum: string;
  readonly fixturesChecksum: string;
}

export interface ShutdownNotification {
  readonly engine: string;
  readonly version: string;
  readonly reason: 'SIGTERM' | 'SIGINT' | 'manual';
  readonly stoppedAt: string;
}

export type NotifyResult =
  | { readonly ok: true; readonly attempts: number; readonly durationMs: number }
  | {
      readonly ok: false;
      readonly attempts: number;
      readonly durationMs: number;
      readonly error: string;
    };

export interface PluginControlClient {
  notifyReady(payload: ReadyNotification): Promise<NotifyResult>;
  notifyShutdown(payload: ShutdownNotification): Promise<NotifyResult>;
}
