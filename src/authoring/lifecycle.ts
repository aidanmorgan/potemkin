import type { Logger } from "../observability/logger.js";
import type { Command, DomainEvent, JsonObject, JsonValue } from "../types.js";
import type { RuntimeDataGenerator } from "../model/data.js";

export type LifecyclePhase =
  | "boot"
  | "validation"
  | "initialization"
  | "request"
  | "projection"
  | "commit"
  | "post-commit"
  | "reset"
  | "shutdown"
  | "watch"
  | "reload";

export interface LifecycleContext {
  readonly phase: LifecyclePhase;
  readonly boundary?: string;
  readonly command?: Readonly<Command>;
  readonly event?: Readonly<DomainEvent>;
  readonly state?: Readonly<JsonObject> | null;
  /** Response visible to post-commit hooks after contract validation. */
  readonly response?: Readonly<{
    readonly status: number;
    readonly body: JsonValue | null;
    readonly headers?: Readonly<Record<string, string>>;
  }>;
  /** Manual or signal reason supplied to reset/shutdown hooks. */
  readonly reason?: string;
  /** Candidate files supplied to watch/reload hooks. */
  readonly reload?: Readonly<{
    readonly files: readonly string[];
  }>;
  readonly helpers: Readonly<LifecycleHelpers>;
}

export interface LifecycleHelpers {
  readonly uuid: () => string;
  readonly now: () => string;
  readonly data?: RuntimeDataGenerator;
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

export type LifecycleFailurePolicy = "abort" | "continue";

export interface LifecycleRunOptions {
  /** Runtime clock used for hook duration diagnostics. */
  readonly nowMs: () => number;
  /** `abort` is used for transactional phases; `continue` is used for committed side effects. */
  readonly failure?: LifecycleFailurePolicy;
  /** Receives a hook failure before it is rethrown or suppressed. */
  readonly onError?: (error: unknown, hookName: string, phase: LifecyclePhase) => void;
  /**
   * Receives a structured completion record for every hook. This is intentionally
   * separate from `onError`: committed phases may continue after a failure, while
   * observability still needs one record per hook invocation.
   */
  readonly onDiagnostic?: (diagnostic: LifecycleDiagnostic) => void;
  /** Optional structured logger for runtime phase telemetry. */
  readonly logger?: Logger;
}

export interface LifecycleDiagnostic {
  readonly phase: LifecyclePhase;
  readonly hookName: string;
  readonly outcome: "completed" | "failed";
  readonly durationMs: number;
  readonly error?: string;
}

/** Services supplied by the owning runtime to lifecycle helpers. */
export interface LifecycleDependencies {
  readonly uuid: () => string;
  readonly now: () => string;
}

export function defineLifecycle(definition: LifecycleDefinition): LifecycleDefinition {
  return Object.freeze({ ...definition, hooks: Object.freeze([...definition.hooks]) });
}

export function lifecycleHook(
  phase: LifecyclePhase,
  run: (context: Readonly<LifecycleContext>) => unknown | Promise<unknown>,
  name = `${phase}-hook`,
): LifecycleHook {
  return Object.freeze({ name, phase, run });
}

export function hooksForPhase(
  definition: LifecycleDefinition | undefined,
  phase: LifecyclePhase,
): readonly LifecycleHook[] {
  return (definition?.hooks ?? []).filter((hook) =>
    typeof hook === "function" ? true : hook.phase === phase,
  );
}

/**
 * Build the helper set exposed to lifecycle hooks.
 *
 * The callbacks are deliberately supplied by the caller for `now`, allowing
 * request/reset hooks to observe the engine's virtual clock rather than the
 * host clock.
 */
export function createLifecycleHelpers(dependencies: LifecycleDependencies): LifecycleHelpers {
  return {
    uuid: dependencies.uuid,
    now: dependencies.now,
    deepClone: <T>(value: T): T => structuredClone(value),
    deepMerge: (a: JsonObject, b: JsonObject): JsonObject => ({ ...a, ...b }),
  };
}

function freezeSnapshot<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== "object") return value;

  const cloned = structuredClone(value);
  const seen = new WeakSet<object>();
  const freeze = (entry: unknown): void => {
    if (entry === null || typeof entry !== "object" || seen.has(entry)) return;
    seen.add(entry);
    for (const child of Object.values(entry as Record<string, unknown>)) freeze(child);
    Object.freeze(entry);
  };
  freeze(cloned);
  return cloned as T;
}

function hookName(hook: LifecycleHook, phase: LifecyclePhase): string {
  return typeof hook === "function" ? hook.name || `${phase}-hook` : hook.name;
}

/**
 * Run hooks sequentially in declaration order.
 *
 * Every hook receives an independent deep-frozen snapshot of JSON context so
 * one hook cannot mutate what a later hook observes or alter engine state via
 * a context object. Transactional phases rethrow the first failure. Committed
 * side-effect phases can opt into `continue`, preserving the request/reset/
 * shutdown operation while still reporting every failed hook.
 */
export async function runLifecyclePhase(
  definition: LifecycleDefinition | undefined,
  phase: LifecyclePhase,
  context: Omit<LifecycleContext, "phase">,
  options: LifecycleRunOptions,
): Promise<void> {
  const failure = options.failure ?? "abort";
  for (const hook of hooksForPhase(definition, phase)) {
    const name = hookName(hook, phase);
    const startedAt = options.nowMs();
    const hookContext = {
      ...context,
      ...(context.command !== undefined ? { command: freezeSnapshot(context.command) } : {}),
      ...(context.event !== undefined ? { event: freezeSnapshot(context.event) } : {}),
      ...(context.state !== undefined ? { state: freezeSnapshot(context.state) } : {}),
      ...(context.response !== undefined ? { response: freezeSnapshot(context.response) } : {}),
      ...(context.reload !== undefined ? { reload: freezeSnapshot(context.reload) } : {}),
      phase,
    } as unknown as LifecycleContext;

    try {
      await (typeof hook === "function" ? hook : hook.run)(hookContext);
      const diagnostic: LifecycleDiagnostic = {
        phase,
        hookName: name,
        outcome: "completed",
        durationMs: options.nowMs() - startedAt,
      };
      options.onDiagnostic?.(diagnostic);
      options.logger?.debug({ ...diagnostic }, "lifecycle hook completed");
    } catch (error) {
      options.onError?.(error, name, phase);
      const diagnostic: LifecycleDiagnostic = {
        phase,
        hookName: name,
        outcome: "failed",
        durationMs: options.nowMs() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
      options.onDiagnostic?.(diagnostic);
      options.logger?.warn({ ...diagnostic }, "lifecycle hook failed");
      if (failure === "abort") throw error;
    }
  }
}
