import type { OpenApiDoc } from '../contract/loader.js';
import { asRecord } from '../contracts/value.js';
import type { RuntimeModelCoverage } from '../model/runtime.js';
import type {
  TransitionMachine,
  TransitionModel,
  TransitionWriteSet,
} from '../model/transitionModel.js';
import type { SimulationDefinition } from './types.js';
import { composeBoundaries } from './composition.js';

/**
 * Build the same versioned model shape for direct TypeScript authoring.
 *
 * Reducer callbacks are intentionally opaque: executing user code during
 * discovery would make static extraction unsafe. Such transitions are kept
 * with `UNKNOWN` next state and an empty write-set rather than being silently
 * discarded. The runtime still executes the callback normally.
 */
export function buildTypeScriptTransitionModel(
  definition: SimulationDefinition,
  openapi: OpenApiDoc,
): TransitionModel {
  const groups = new Map<string, SimulationDefinition['boundaries']>();
  const boundaries = [...definition.boundaries, ...composeBoundaries([], definition.uses ?? [])];
  for (const boundary of boundaries) {
    const key = aggregateKey(boundary.schema, boundary.contractPath);
    groups.set(key, [...(groups.get(key) ?? []), boundary]);
  }

  const machines = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, groupedBoundaries]) => buildMachine(definition, key, groupedBoundaries, openapi));
  return { schemaVersion: 1, machines };
}

function buildMachine(
  definition: SimulationDefinition,
  key: string,
  boundaries: SimulationDefinition['boundaries'],
  openapi: OpenApiDoc,
): TransitionMachine {
  const schema = resolveSchema(key, boundaries[0]?.schema, openapi);
  const controlField = selectControlField(schema);
  const states = enumValues(schema, controlField);
  const reducers = boundaries.flatMap((boundary) => boundary.reducers);
  const events = new Set(
    boundaries.flatMap((boundary) => boundary.eventCatalog.map((event) => event.type)),
  );
  const transitions = boundaries.flatMap((boundary) =>
    boundary.behaviors.flatMap((behavior) => {
      const emitted = [
        ...(behavior.emit === undefined ? [] : [behavior.emit]),
        ...(behavior.emitWhen?.map((entry) => entry.event) ?? []),
      ];
      return emitted
        .filter((event) => events.has(event) && reducers.some((reducer) => reducer.on === event))
        .map(() => ({
          from: '*' as const,
          to: 'UNKNOWN' as const,
          op: behavior.operationId,
          guardCel: null,
          nextStateKnown: false as const,
        }));
    }),
  );
  const writeSets = new Map<string, TransitionWriteSet>();
  for (const boundary of boundaries) {
    for (const behavior of boundary.behaviors) {
      const emitted = [
        ...(behavior.emit === undefined ? [] : [behavior.emit]),
        ...(behavior.emitWhen?.map((entry) => entry.event) ?? []),
      ];
      for (const event of emitted) {
        const reducer = reducers.find((candidate) => candidate.on === event);
        if (reducer === undefined) continue;
        const next: TransitionWriteSet = {
          fields: [],
          // TypeScript reducers always return the complete resultant state;
          // the native authoring contract has no patch-mode escape hatch.
          replaceState: true,
          derivedClosure: [],
          volatile: [],
        };
        const previous = writeSets.get(behavior.operationId);
        writeSets.set(
          behavior.operationId,
          previous === undefined ? next : mergeWriteSet(previous, next),
        );
      }
    }
  }

  const analysis = buildAnalysis(definition, key, boundaries, controlField);
  return {
    aggregate: aggregateName(key),
    controlField,
    states: states.length === 0 ? ['UNKNOWN'] : states,
    transitions: uniqueTransitions(transitions),
    writeSets: Object.fromEntries(
      [...writeSets.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
    ...(Object.keys(analysis).length === 0 ? {} : { analysis }),
  };
}

function buildAnalysis(
  definition: SimulationDefinition,
  key: string,
  boundaries: SimulationDefinition['boundaries'],
  controlField: string,
): RuntimeModelCoverage {
  const policy =
    definition.policies?.coverage?.[aggregateName(key)] ?? definition.policies?.coverage?.[key];
  const initialStates = boundaries.flatMap((boundary) =>
    (boundary.initialization ?? [])
      .map((seed) => {
        const value = asRecord(seed);
        const nestedState = asRecord(value?.state);
        return nestedState?.[controlField] ?? value?.[controlField];
      })
      .filter((value): value is string => typeof value === 'string'),
  );
  const configuredInitialStates = policy?.initialStates ?? [];
  return {
    ...(policy?.strict === undefined ? {} : { strict: policy.strict }),
    ...(configuredInitialStates.length === 0 && initialStates.length === 0
      ? {}
      : { initialStates: [...new Set([...configuredInitialStates, ...initialStates])].sort() }),
    ...(policy?.terminalStates === undefined ? {} : { terminalStates: policy.terminalStates }),
    ...(policy?.operations === undefined ? {} : { operations: policy.operations }),
    ...(policy?.suppressStates === undefined ? {} : { suppressStates: policy.suppressStates }),
  };
}

function aggregateKey(schema: string | undefined, contractPath: string): string {
  if (schema !== undefined && schema.trim() !== '') return schema;
  const segment = contractPath
    .split('/')
    .filter(Boolean)
    .find((value) => !/^v\d+$/i.test(value));
  return segment?.toLowerCase() ?? 'runtime';
}

function aggregateName(key: string): string {
  return key
    .replace(/[-_]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => {
      const singular = part.length > 3 && part.endsWith('s') ? part.slice(0, -1) : part;
      return singular.charAt(0).toUpperCase() + singular.slice(1);
    })
    .join('');
}

function resolveSchema(
  key: string,
  explicit: string | undefined,
  openapi: OpenApiDoc,
): Record<string, unknown> | undefined {
  const raw = asRecord(openapi.raw);
  const schemas = asRecord(asRecord(raw?.components)?.schemas);
  if (schemas === undefined) return undefined;
  const candidates = [explicit, key, aggregateName(key), aggregateName(key).toLowerCase()].filter(
    (value): value is string => value !== undefined,
  );
  const name = candidates.find((candidate) => schemas[candidate] !== undefined);
  return name === undefined ? undefined : asRecord(schemas[name]);
}

function selectControlField(schema: Record<string, unknown> | undefined): string {
  const fields = asRecord(schema?.properties) ?? {};
  const enums = Object.entries(fields).filter(
    ([, value]) => enumValues(asRecord(value), '').length > 0,
  );
  if (enums.length === 0) return 'state';
  return enums.sort(([left], [right]) => left.localeCompare(right))[0]![0];
}

function enumValues(schema: Record<string, unknown> | undefined, field: string): readonly string[] {
  const value = field === '' ? schema : asRecord(schema?.properties)?.[field];
  const enumValues = asRecord(value)?.enum;
  return Array.isArray(enumValues)
    ? enumValues.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function mergeWriteSet(left: TransitionWriteSet, right: TransitionWriteSet): TransitionWriteSet {
  return {
    fields: [...new Set([...left.fields, ...right.fields])].sort(),
    replaceState: left.replaceState || right.replaceState,
    derivedClosure: [...new Set([...left.derivedClosure, ...right.derivedClosure])].sort(),
    volatile: [...new Set([...left.volatile, ...right.volatile])].sort(),
  };
}

function uniqueTransitions<T extends { readonly op: string; readonly to: string }>(
  values: readonly T[],
): readonly T[] {
  const result = new Map<string, T>();
  for (const value of values) result.set(JSON.stringify(value), value);
  return [...result.values()].sort((left, right) => left.op.localeCompare(right.op));
}
