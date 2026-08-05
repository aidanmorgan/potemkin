import type { RuntimeBoundary, RuntimeDependencies } from './runtime.js';
import type { RuntimeDefinition, RuntimeModel } from './index.js';
import { RuntimeModelError } from '../model/errors.js';
import { runtimeLatencyProblem } from '../model/latency.js';
import {
  behaviorName,
  boundaryName,
  eventType,
  operationId,
  parseContractPath,
} from '../domain/references.js';

function freeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  return Object.freeze(value);
}

function readonlyMap<Key, Value>(source: Map<Key, Value>): ReadonlyMap<Key, Value> {
  const get = (key: Key) => source.get(key);
  const has = (key: Key) => source.has(key);
  const entries = () => source.entries();
  const keys = () => source.keys();
  const values = () => source.values();
  const forEach = (callback: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void) =>
    source.forEach((value, key) => callback(value, key, result));
  const result = {
    get,
    has,
    entries,
    keys,
    values,
    forEach,
    get size() {
      return source.size;
    },
    [Symbol.iterator]: entries,
  } as ReadonlyMap<Key, Value>;
  return Object.freeze(result);
}

function compilePolicies(
  policies: RuntimeDefinition['policies'],
  dependencies: RuntimeDependencies,
): RuntimeDefinition['policies'] {
  const auth = policies?.auth;
  if (auth === undefined || auth.authenticate !== undefined) return policies;
  const authentication = dependencies.authentication;
  if (authentication === undefined) return policies;
  return {
    ...policies,
    auth: {
      ...auth,
      authenticate: (request) => authentication.authenticate(request, auth),
    },
  };
}

/**
 * Compile the source-independent runtime definition.
 *
 * This function is deliberately small. Source parsing, defaults, and source
 * diagnostics happen before this boundary. The compiler only freezes the
 * definition, builds deterministic indexes, and rejects duplicate names or
 * contract paths.
 */
export function compileRuntime(
  definition: RuntimeDefinition,
  dependencies: RuntimeDependencies,
): RuntimeModel {
  const boundaries = definition.boundaries.map((boundary) => freeze(boundary));
  const byBoundaryName = new Map<string, RuntimeBoundary>();
  const byContractPath = new Map<string, RuntimeBoundary>();

  const validateBoundaryReferences = (boundary: RuntimeBoundary): void => {
    boundaryName(boundary.boundary);
    parseContractPath(boundary.contractPath);
    for (const event of boundary.eventCatalog) eventType(event.type);
    for (const behavior of boundary.behaviors) {
      behaviorName(behavior.name);
      operationId(behavior.operationId);
      for (const dispatch of behavior.dispatchCommands ?? []) {
        boundaryName(dispatch.boundary);
        operationId(dispatch.operationId);
      }
    }
    for (const reducer of boundary.reducers) {
      if (!reducer.on.startsWith('System.') && reducer.on !== 'BaselineEntityCreatedEvent') {
        eventType(reducer.on);
      }
    }
  };

  for (const boundary of boundaries) {
    try {
      validateBoundaryReferences(boundary);
    } catch (error) {
      throw new RuntimeModelError(
        'RUNTIME_BUILDER_INVALID',
        `Invalid runtime reference in boundary "${boundary.boundary}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (byBoundaryName.has(boundary.boundary)) {
      throw new RuntimeModelError(
        'RUNTIME_BOUNDARY_CONFLICT',
        `Duplicate runtime boundary "${boundary.boundary}"`,
      );
    }
    if (byContractPath.has(boundary.contractPath)) {
      throw new RuntimeModelError(
        'RUNTIME_BOUNDARY_CONFLICT',
        `Duplicate runtime contract path "${boundary.contractPath}"`,
      );
    }
    byBoundaryName.set(boundary.boundary, boundary);
    byContractPath.set(boundary.contractPath, boundary);
  }

  const eventTypes = (boundary: RuntimeBoundary): Set<string> =>
    new Set(boundary.eventCatalog.map((event) => event.type));
  for (const boundary of boundaries) {
    const boundaryLatencyProblem = runtimeLatencyProblem(boundary.latency);
    if (boundaryLatencyProblem !== undefined)
      throw new RuntimeModelError(
        'RUNTIME_LATENCY_INVALID',
        `Runtime boundary "${boundary.boundary}" has invalid latency: ${boundaryLatencyProblem.message}`,
        {
          boundary: boundary.boundary,
          ...(boundaryLatencyProblem.field === undefined
            ? {}
            : { field: boundaryLatencyProblem.field }),
        },
      );
    const responseLatencyProblem = runtimeLatencyProblem(boundary.response?.latency);
    if (responseLatencyProblem !== undefined)
      throw new RuntimeModelError(
        'RUNTIME_LATENCY_INVALID',
        `Runtime boundary "${boundary.boundary}" has invalid response latency: ${responseLatencyProblem.message}`,
        {
          boundary: boundary.boundary,
          ...(responseLatencyProblem.field === undefined
            ? {}
            : { field: responseLatencyProblem.field }),
        },
      );
    const events = eventTypes(boundary);
    for (const behavior of boundary.behaviors) {
      for (const event of [
        behavior.emit,
        ...(behavior.emitWhen?.map((entry) => entry.event) ?? []),
      ].filter((value): value is string => value !== undefined)) {
        if (event !== 'System.GenericUpdateEvent' && !events.has(event))
          throw new RuntimeModelError(
            'RUNTIME_EVENT_REFERENCE_INVALID',
            `Runtime behavior "${boundary.boundary}.${behavior.name}" emits undeclared event "${event}"`,
          );
      }
      for (const dispatch of behavior.dispatchCommands ?? []) {
        const target = byBoundaryName.get(dispatch.boundary);
        if (target === undefined)
          throw new RuntimeModelError(
            'RUNTIME_DISPATCH_REFERENCE_INVALID',
            `Runtime behavior "${boundary.boundary}.${behavior.name}" dispatches to unknown boundary "${dispatch.boundary}"`,
          );
        if (!target.behaviors.some((candidate) => candidate.operationId === dispatch.operationId))
          throw new RuntimeModelError(
            'RUNTIME_DISPATCH_REFERENCE_INVALID',
            `Runtime behavior "${boundary.boundary}.${behavior.name}" dispatches unknown operation "${dispatch.operationId}" on "${dispatch.boundary}"`,
          );
      }
    }
    for (const reducer of boundary.reducers) {
      if (
        reducer.on !== 'BaselineEntityCreatedEvent' &&
        reducer.on !== 'System.GenericUpdateEvent' &&
        !events.has(reducer.on)
      )
        throw new RuntimeModelError(
          'RUNTIME_EVENT_REFERENCE_INVALID',
          `Runtime reducer on "${boundary.boundary}" references undeclared event "${reducer.on}"`,
        );
    }
    for (const reaction of boundary.reactions ?? []) {
      const target = byBoundaryName.get(reaction.boundary);
      if (target === undefined)
        throw new RuntimeModelError(
          'RUNTIME_REACTION_REFERENCE_INVALID',
          `Runtime reaction targets unknown boundary "${reaction.boundary}"`,
        );
      if (!eventTypes(target).has(reaction.emit))
        throw new RuntimeModelError(
          'RUNTIME_REACTION_REFERENCE_INVALID',
          `Runtime reaction emits undeclared event "${reaction.emit}" on "${reaction.boundary}"`,
        );
    }
  }
  for (const reaction of definition.policies?.reactions ?? []) {
    const target = byBoundaryName.get(reaction.boundary);
    if (target === undefined)
      throw new RuntimeModelError(
        'RUNTIME_REACTION_REFERENCE_INVALID',
        `Runtime reaction targets unknown boundary "${reaction.boundary}"`,
      );
    if (!eventTypes(target).has(reaction.emit))
      throw new RuntimeModelError(
        'RUNTIME_REACTION_REFERENCE_INVALID',
        `Runtime reaction emits undeclared event "${reaction.emit}" on "${reaction.boundary}"`,
      );
  }
  for (const saga of definition.policies?.sagas ?? []) {
    if (!byBoundaryName.has(saga.trigger.boundary)) {
      throw new RuntimeModelError(
        'RUNTIME_SAGA_REFERENCE_INVALID',
        `Runtime saga "${saga.name}" has an unknown trigger boundary "${saga.trigger.boundary}"`,
      );
    }
    for (const step of saga.steps) {
      const target = byBoundaryName.get(step.boundary);
      if (target === undefined)
        throw new RuntimeModelError(
          'RUNTIME_SAGA_REFERENCE_INVALID',
          `Runtime saga "${saga.name}" references unknown step boundary "${step.boundary}"`,
        );
      if (!target.behaviors.some((candidate) => candidate.operationId === step.operationId))
        throw new RuntimeModelError(
          'RUNTIME_SAGA_REFERENCE_INVALID',
          `Runtime saga "${saga.name}" references unknown step operation "${step.operationId}"`,
        );
      if (
        step.compensation !== undefined &&
        !target.behaviors.some(
          (candidate) => candidate.operationId === step.compensation!.operationId,
        )
      )
        throw new RuntimeModelError(
          'RUNTIME_SAGA_REFERENCE_INVALID',
          `Runtime saga "${saga.name}" references unknown compensation operation "${step.compensation.operationId}"`,
        );
    }
  }

  const helpers = definition.helpers ?? [];
  const helperNames = new Set<string>();
  for (const helper of helpers) {
    if (helperNames.has(helper.name)) {
      throw new RuntimeModelError(
        'RUNTIME_HELPER_CONFLICT',
        `Duplicate runtime helper "${helper.name}"`,
      );
    }
    helperNames.add(helper.name);
  }

  return freeze({
    boundaries,
    byBoundaryName: readonlyMap(byBoundaryName),
    byContractPath: readonlyMap(byContractPath),
    policies: compilePolicies(definition.policies, dependencies) ?? {},
    helpers,
    dependencies,
  });
}
