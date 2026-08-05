import type { YamlLinkedProgram } from '../../src/dsl/types.js';
import type { OpenApiDoc } from '../../src/contract/loader.js';
import type { SimulationDefinition } from '../../src/authoring/types.js';

export interface ParityComparison {
  readonly equal: boolean;
  readonly yaml: string;
  readonly direct: string;
  readonly differences: readonly string[];
}

export interface DefinitionComparisonOptions {
  readonly openapi?: OpenApiDoc;
}

/**
 * Remove runtime indexes and function-bearing registries before comparing two
 * compiled models. This makes the comparison semantic: declaration order and
 * values remain visible, while object key insertion order and host functions
 * do not become false differences.
 */
export function normalizeYamlProgram(dsl: YamlLinkedProgram): string {
  const value = {
    // Module discovery order is an implementation detail of YAML loading;
    // TypeScript declarations are commonly written in a different order.
    // Compare the canonical model by stable identity, while preserving the
    // order of semantically ordered lists such as reducers and saga steps.
    boundaries: [...dsl.boundaries].sort(
      (left, right) =>
        left.boundary.localeCompare(right.boundary) ||
        left.contractPath.localeCompare(right.contractPath),
    ),
    ...(dsl.components !== undefined ? { components: dsl.components } : {}),
    ...(dsl.use !== undefined ? { use: dsl.use } : {}),
    ...(dsl.sagas !== undefined ? { sagas: dsl.sagas } : {}),
    ...(dsl.idempotency !== undefined ? { idempotency: dsl.idempotency } : {}),
    ...(dsl.derivedProjections !== undefined ? { derivedProjections: dsl.derivedProjections } : {}),
    ...(dsl.faults !== undefined ? { faults: dsl.faults } : {}),
    ...(dsl.fallback !== undefined ? { fallback: dsl.fallback } : {}),
    ...(dsl.auth !== undefined ? { auth: dsl.auth } : {}),
    ...(dsl.securityHeaders !== undefined ? { securityHeaders: dsl.securityHeaders } : {}),
    ...(dsl.hateoas !== undefined ? { hateoas: dsl.hateoas } : {}),
    ...(dsl.versioning !== undefined ? { versioning: dsl.versioning } : {}),
    ...(dsl.webhooks !== undefined ? { webhooks: dsl.webhooks } : {}),
    ...(dsl.reactions !== undefined ? { reactions: dsl.reactions } : {}),
    ...(dsl.potemkinConfig !== undefined ? { potemkinConfig: dsl.potemkinConfig } : {}),
    ...(dsl.lifecycle !== undefined ? { lifecycle: dsl.lifecycle } : {}),
    ...(dsl.controlHeaders !== undefined ? { controlHeaders: dsl.controlHeaders } : {}),
    ...(dsl.forwarding !== undefined ? { forwarding: dsl.forwarding } : {}),
    ...(dsl.plugin !== undefined ? { plugin: dsl.plugin } : {}),
  };
  return stableJson(value);
}

function runtimeSummary(definition: SimulationDefinition): unknown {
  return {
    boundaries: [...definition.boundaries]
      .sort((left, right) => left.boundary.localeCompare(right.boundary))
      .map((boundary) => ({
        boundary: boundary.boundary,
        contractPath: boundary.contractPath,
        schema: boundary.schema,
        fallbackOverride: boundary.fallbackOverride,
        mask: boundary.mask,
        eventTypes: boundary.eventCatalog.map((event) => event.type),
        behaviorOperations: boundary.behaviors.map((behavior) => ({
          operationId: behavior.operationId,
          emit: behavior.emit,
        })),
        reducerEvents: boundary.reducers.map((reducer) => reducer.on),
      })),
    policies:
      definition.policies === undefined
        ? {}
        : {
            idempotency: definition.policies.idempotency,
            faultNames: definition.policies.faults?.map((fault) => fault.name),
            projectionNames: definition.policies.derivedProjections?.map(
              (projection) => projection.name,
            ),
            webhookNames: definition.policies.webhooks?.map((webhook) => webhook.name),
          },
  };
}

function yamlSummary(dsl: YamlLinkedProgram): unknown {
  return {
    boundaries: [...dsl.boundaries]
      .sort((left, right) => left.boundary.localeCompare(right.boundary))
      .map((boundary) => ({
        boundary: boundary.boundary,
        contractPath: boundary.contractPath,
        schema: boundary.schema,
        fallbackOverride: boundary.fallbackOverride,
        mask: boundary.mask,
        eventTypes: boundary.eventCatalog.map((event) => event.type),
        behaviorOperations: boundary.behaviors.map((behavior) => ({
          operationId: behavior.match.operationId,
          emit: behavior.emit,
        })),
        reducerEvents: boundary.reducers.map((reducer) => reducer.on),
      })),
    policies: {
      idempotency: dsl.idempotency,
      faultNames: dsl.faults?.map((fault) => fault.name),
      projectionNames: dsl.derivedProjections?.map((projection) => projection.name),
      webhookNames: dsl.webhooks?.map((webhook) => webhook.name),
    },
  };
}

/** Compare a YAML-compiled model with a directly authored model. */
export function compareDefinitions(
  yamlDsl: YamlLinkedProgram,
  definition: SimulationDefinition,
  options: DefinitionComparisonOptions = {},
): ParityComparison {
  void options;
  const yaml = stableJson(yamlSummary(yamlDsl));
  const direct = stableJson(runtimeSummary(definition));
  if (yaml === direct) return { equal: true, yaml, direct, differences: [] };
  const yamlValue = JSON.parse(yaml) as unknown;
  const directValue = JSON.parse(direct) as unknown;
  return {
    equal: false,
    yaml,
    direct,
    differences: differencePaths(yamlValue, directValue),
  };
}

function differencePaths(left: unknown, right: unknown, path = '$'): string[] {
  if (Object.is(left, right)) return [];
  if (Array.isArray(left) && Array.isArray(right)) {
    const differences: string[] = [];
    const length = Math.max(left.length, right.length);
    for (let i = 0; i < length; i++)
      differences.push(...differencePaths(left[i], right[i], `${path}[${i}]`));
    return differences;
  }
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    const keys = new Set([...Object.keys(left as object), ...Object.keys(right as object)]);
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
    return differences;
  }
  return [path];
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const child = record[key];
    if (child === undefined || typeof child === 'function') continue;
    sorted[key] = sortValue(child);
  }
  return sorted;
}
