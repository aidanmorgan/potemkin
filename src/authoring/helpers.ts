import { isJsonValue, type JsonValue } from '../contracts/value.js';
import { helperError } from './errors.js';
import type { HelperName } from '../domain/references.js';
import type {
  TypeScriptHelper,
  TypeScriptHelperDefinition,
  TypeScriptHelperPhase,
  TypeScriptHelperRegistration,
} from './types.js';

export type {
  TypeScriptHelper,
  TypeScriptHelperDefinition,
  TypeScriptHelperPhase,
  TypeScriptHelperRegistration,
};

export interface TypeScriptHelperOptions {
  readonly phases?: readonly TypeScriptHelperPhase[];
  readonly maxDurationMs?: number;
}

const DEFAULT_PHASES: readonly TypeScriptHelperPhase[] = [
  'behavior',
  'event-hydration',
  'identity',
  'query',
  'response',
  'post-commit',
  'fault',
  'webhook',
  'saga',
  'projection',
  'lifecycle',
];
const DEFAULT_MAX_DURATION_MS = 50;
const MAX_HELPER_DURATION_MS = 1_000;
const MAX_HELPER_ARGUMENTS = 32;
const MAX_HELPER_INPUT_BYTES = 64 * 1024;
const HELPER_PHASES: ReadonlySet<string> = new Set(DEFAULT_PHASES);

type RuntimeHelperImplementation = (...args: never[]) => unknown;

/**
 * Adapt the typed authoring call to the untyped runtime definition boundary.
 * The overload preserves tuple and result types for TypeScript callers; the
 * implementation validates the runtime JSON contract before applying args.
 */
function invokeHelper<Args extends readonly JsonValue[], Output extends JsonValue>(
  implementation: (...args: Args) => Output,
  args: Args,
  name: HelperName,
  phases: readonly TypeScriptHelperPhase[],
  maxDurationMs: number,
  phase?: string,
): Output;
function invokeHelper(
  implementation: RuntimeHelperImplementation,
  args: readonly JsonValue[],
  name: HelperName,
  phases: readonly TypeScriptHelperPhase[],
  maxDurationMs: number,
  phase?: string,
): JsonValue;
function invokeHelper(
  implementation: RuntimeHelperImplementation,
  args: readonly JsonValue[],
  name: HelperName,
  phases: readonly TypeScriptHelperPhase[],
  maxDurationMs: number,
  phase?: string,
): JsonValue {
  if (args.length > MAX_HELPER_ARGUMENTS) {
    throw helperError(`TypeScript helper "${name}" received too many arguments`);
  }
  const inputBytes = new TextEncoder().encode(JSON.stringify(args)).byteLength;
  if (inputBytes > MAX_HELPER_INPUT_BYTES) {
    throw helperError(`TypeScript helper "${name}" received arguments larger than 64KiB`);
  }
  if (phase !== undefined && (!isHelperPhase(phase) || !phases.includes(phase))) {
    throw helperError(`TypeScript helper "${name}" is not allowed in phase "${phase}"`);
  }
  const startedAt = performance.now();
  const value = Reflect.apply(implementation, undefined, args);
  if (performance.now() - startedAt > maxDurationMs) {
    throw helperError(
      `TypeScript helper "${name}" exceeded its ${maxDurationMs}ms execution budget`,
    );
  }
  if (!isJsonValue(value)) {
    throw helperError(`TypeScript helper "${name}" must return a JSON value`);
  }
  return value;
}

/** Structural registration surface used by the simulation builder. */

function validateHelperName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw helperError(`A TypeScript helper name must be a CEL identifier: "${name}"`);
  }
}

/**
 * Define one pure, typed helper. The returned function is usable directly by
 * TypeScript configuration code and can be registered on a simulation with
 * `.helper()` for YAML CEL use.
 */
export function defineHelper<Args extends readonly JsonValue[], Output extends JsonValue>(
  name: HelperName,
  implementation: (...args: Args) => Output,
  options: TypeScriptHelperOptions = {},
): TypeScriptHelper<Args, Output> {
  validateHelperName(name);
  if (typeof implementation !== 'function') {
    throw helperError(`TypeScript helper "${name}" must be a function`);
  }

  const phases = [...new Set(options.phases ?? DEFAULT_PHASES)];
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  if (
    phases.length === 0 ||
    !Number.isInteger(maxDurationMs) ||
    maxDurationMs < 1 ||
    maxDurationMs > MAX_HELPER_DURATION_MS
  ) {
    throw helperError(
      `TypeScript helper "${name}" requires at least one allowed phase and a duration between 1 and ${MAX_HELPER_DURATION_MS}ms`,
    );
  }

  const invoke = (args: readonly JsonValue[], phase?: string): JsonValue =>
    invokeHelper(implementation, args, name, phases, maxDurationMs, phase);
  const definition: TypeScriptHelperDefinition = Object.freeze({
    name,
    phases,
    maxDurationMs,
    invoke,
  });
  const helper = Object.assign(
    (...args: Args): Output => invokeHelper(implementation, args, name, phases, maxDurationMs),
    { definition },
  );
  return Object.freeze(helper);
}

function isHelperPhase(value: string): value is TypeScriptHelperPhase {
  return HELPER_PHASES.has(value);
}
