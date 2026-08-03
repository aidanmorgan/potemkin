import type { JsonValue } from "../../src/types.js";

/** A request in a deterministic runtime equivalence trace. */
export interface AuthoringParityRequest {
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: JsonValue;
}

/** The observable HTTP result for one parity request. */
export interface AuthoringParityResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: JsonValue | null;
}

/** Runtime observations that are meaningful when comparing two projections. */
export interface AuthoringParityObservation {
  readonly responses: readonly AuthoringParityResponse[];
  readonly events?: readonly JsonValue[];
  readonly state?: JsonValue;
  readonly derivedState?: JsonValue;
  readonly sideEffects?: JsonValue;
}

/**
 * A runner is deliberately injected rather than coupled to a transport or
 * contract tool. The same comparator can therefore be used with any runtime
 * projection that exposes these observations.
 */
export type AuthoringParityRunner = (
  requests: readonly AuthoringParityRequest[],
) => Promise<AuthoringParityObservation> | AuthoringParityObservation;

export interface RuntimeParityOptions {
  /** Remove documented volatile values before comparison. */
  readonly normalizer?: (value: unknown) => unknown;
}

export interface RuntimeParityComparison {
  readonly equal: boolean;
  readonly yaml: string;
  readonly typescript: string;
  readonly differences: readonly string[];
}

/**
 * Execute the same request trace against two runtime runners and
 * compare responses, event/state snapshots, and side-effect observations.
 *
 * The runners are expected to share deterministic providers (clock, UUID,
 * faker, webhook transport, and forwarding transport). The comparator does not
 * silently ignore differences: only values removed by the explicit normalizer
 * are treated as non-semantic.
 */
export async function compareRuntimeDefinitions(
  requests: readonly AuthoringParityRequest[],
  yamlRunner: AuthoringParityRunner,
  typescriptRunner: AuthoringParityRunner,
  options: RuntimeParityOptions = {},
): Promise<RuntimeParityComparison> {
  const [yamlObservation, typescriptObservation] = await Promise.all([
    yamlRunner(requests),
    typescriptRunner(requests),
  ]);
  const normalizer = options.normalizer ?? ((value: unknown) => value);
  const yaml = stableJson(normalizer(yamlObservation));
  const typescript = stableJson(normalizer(typescriptObservation));
  return {
    equal: yaml === typescript,
    yaml,
    typescript,
    differences:
      yaml === typescript
        ? []
        : differencePaths(JSON.parse(yaml) as unknown, JSON.parse(typescript) as unknown),
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const child = record[key];
    if (child === undefined || typeof child === "function") continue;
    sorted[key] = sortValue(child);
  }
  return sorted;
}

function differencePaths(left: unknown, right: unknown, path = "$"): string[] {
  if (Object.is(left, right)) return [];
  if (Array.isArray(left) && Array.isArray(right)) {
    const differences: string[] = [];
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
      differences.push(...differencePaths(left[index], right[index], `${path}[${index}]`));
    }
    return differences.length > 0 ? differences : [path];
  }
  if (left !== null && right !== null && typeof left === "object" && typeof right === "object") {
    const keys = new Set([
      ...Object.keys(left as Record<string, unknown>),
      ...Object.keys(right as Record<string, unknown>),
    ]);
    const differences: string[] = [];
    for (const key of [...keys].sort()) {
      differences.push(
        ...differencePaths(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
          `${path}.${key}`,
        ),
      );
    }
    return differences.length > 0 ? differences : [path];
  }
  return [path];
}
