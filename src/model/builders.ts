import type { JsonObject, JsonValue } from '../contracts/value.js';
import { compileRuntime } from './compiler.js';
import type { RuntimeDefinition } from './index.js';
import { RuntimeModelError } from './errors.js';
import type {
  RuntimeBehavior,
  RuntimeBoundary,
  RuntimeDependencies,
  RuntimeEvent,
  RuntimeFault,
  RuntimePolicies,
  RuntimeProgram,
  RuntimeReaction,
  RuntimeReducer,
  RuntimeResponsePolicy,
} from '../model/runtime.js';

function freeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  return Object.freeze(value);
}

export interface RuntimeEventBuilder {
  payload(values: Readonly<Record<string, RuntimeEvent['payload'][string]>>): RuntimeEventBuilder;
  schemaRef(reference: string): RuntimeEventBuilder;
  build(): RuntimeEvent;
}

export function runtimeEvent(type: string): RuntimeEventBuilder {
  const build = (event: RuntimeEvent): RuntimeEventBuilder => ({
    payload: (values) => build({ ...event, payload: { ...event.payload, ...values } }),
    schemaRef: (reference) => build({ ...event, schemaRef: reference }),
    build: () => freeze({ ...event, payload: { ...event.payload } }),
  });
  return build({ type, payload: {} });
}

export interface RuntimeBehaviorBuilder {
  operation(operationId: string): RuntimeBehaviorBuilder;
  when(condition: RuntimeBehavior['condition']): RuntimeBehaviorBuilder;
  method(method: string): RuntimeBehaviorBuilder;
  headers(headers: Readonly<Record<string, string>>): RuntimeBehaviorBuilder;
  requires(...guards: NonNullable<RuntimeBehavior['requires']>): RuntimeBehaviorBuilder;
  scopes(...scopes: readonly string[]): RuntimeBehaviorBuilder;
  emit(event: string): RuntimeBehaviorBuilder;
  emitWhen(...emissions: NonNullable<RuntimeBehavior['emitWhen']>): RuntimeBehaviorBuilder;
  dispatch(...commands: NonNullable<RuntimeBehavior['dispatchCommands']>): RuntimeBehaviorBuilder;
  postcondition(condition: RuntimeBehavior['postcondition']): RuntimeBehaviorBuilder;
  link(name: string, condition?: RuntimeBehavior['linkCondition']): RuntimeBehaviorBuilder;
  status(status: number): RuntimeBehaviorBuilder;
  build(): RuntimeBehavior;
}

export function runtimeBehavior(name: string): RuntimeBehaviorBuilder {
  const build = (behavior: RuntimeBehavior): RuntimeBehaviorBuilder => ({
    operation: (operationId) => build({ ...behavior, operationId }),
    when: (condition) => build({ ...behavior, condition }),
    method: (method) => build({ ...behavior, method: method.toUpperCase() }),
    headers: (headers) => build({ ...behavior, headers: { ...headers } }),
    requires: (...guards) =>
      build({ ...behavior, requires: [...(behavior.requires ?? []), ...guards] }),
    scopes: (...scopes) =>
      build({ ...behavior, requiredScopes: [...(behavior.requiredScopes ?? []), ...scopes] }),
    emit: (event) => build({ ...behavior, emit: event, emitWhen: undefined }),
    emitWhen: (...emissions) => build({ ...behavior, emit: undefined, emitWhen: [...emissions] }),
    dispatch: (...commands) =>
      build({ ...behavior, dispatchCommands: [...(behavior.dispatchCommands ?? []), ...commands] }),
    postcondition: (condition) => build({ ...behavior, postcondition: condition }),
    link: (name, condition) =>
      build({
        ...behavior,
        linkName: name,
        ...(condition === undefined ? {} : { linkCondition: condition }),
      }),
    status: (status) => build({ ...behavior, responseStatus: status }),
    build: () => {
      if (behavior.operationId === '')
        throw new RuntimeModelError(
          'RUNTIME_BUILDER_INVALID',
          `Runtime behavior "${name}" requires an operation id`,
        );
      if (
        behavior.emit === undefined &&
        behavior.emitWhen === undefined &&
        behavior.dispatchCommands === undefined
      ) {
        throw new RuntimeModelError(
          'RUNTIME_BUILDER_INVALID',
          `Runtime behavior "${name}" requires an emission or dispatch`,
        );
      }
      return freeze({ ...behavior });
    },
  });
  return build({ name, operationId: '' });
}

export interface RuntimeReducerBuilder {
  apply(fn: NonNullable<RuntimeReducer['apply']>): RuntimeReducerBuilder;
  replaceState(enabled?: boolean): RuntimeReducerBuilder;
  build(): RuntimeReducer;
}

export function runtimeReducer(on: string): RuntimeReducerBuilder {
  const build = (reducer: RuntimeReducer): RuntimeReducerBuilder => ({
    apply: (fn) => build({ ...reducer, apply: fn }),
    replaceState: (enabled = true) => build({ ...reducer, replaceState: enabled }),
    build: () => freeze({ ...reducer }),
  });
  return build({ on });
}

export interface RuntimeBoundaryBuilder {
  event(event: RuntimeEvent): RuntimeBoundaryBuilder;
  behavior(behavior: RuntimeBehavior): RuntimeBoundaryBuilder;
  reducer(reducer: RuntimeReducer): RuntimeBoundaryBuilder;
  seed(
    ...records: readonly NonNullable<RuntimeBoundary['initialization']>[number][]
  ): RuntimeBoundaryBuilder;
  identity(identity: RuntimeBoundary['identity']): RuntimeBoundaryBuilder;
  query(query: RuntimeBoundary['query']): RuntimeBoundaryBuilder;
  response(response: RuntimeResponsePolicy): RuntimeBoundaryBuilder;
  fallbackOverride(enabled?: boolean): RuntimeBoundaryBuilder;
  mask(...paths: readonly string[]): RuntimeBoundaryBuilder;
  deprecated(value: NonNullable<RuntimeBoundary['deprecated']>): RuntimeBoundaryBuilder;
  latency(value: NonNullable<RuntimeBoundary['latency']>): RuntimeBoundaryBuilder;
  auditFields(enabled?: boolean): RuntimeBoundaryBuilder;
  strictSchema(enabled?: boolean): RuntimeBoundaryBuilder;
  queryMapping(value: NonNullable<RuntimeBoundary['queryMapping']>): RuntimeBoundaryBuilder;
  faults(...faults: readonly RuntimeFault[]): RuntimeBoundaryBuilder;
  reactions(...reactions: readonly RuntimeReaction[]): RuntimeBoundaryBuilder;
  state(state: RuntimeBoundary['state']): RuntimeBoundaryBuilder;
  build(): RuntimeBoundary;
}

export function runtimeBoundary(boundary: string, contractPath: string): RuntimeBoundaryBuilder {
  const build = (value: RuntimeBoundary): RuntimeBoundaryBuilder => ({
    event: (event) => build({ ...value, eventCatalog: [...value.eventCatalog, event] }),
    behavior: (behavior) => build({ ...value, behaviors: [...value.behaviors, behavior] }),
    reducer: (reducer) => build({ ...value, reducers: [...value.reducers, reducer] }),
    seed: (...records) =>
      build({ ...value, initialization: [...(value.initialization ?? []), ...records] }),
    identity: (identity) => build({ ...value, identity }),
    query: (query) => build({ ...value, query }),
    response: (response) => build({ ...value, response }),
    fallbackOverride: (enabled = true) => build({ ...value, fallbackOverride: enabled }),
    mask: (...paths) => build({ ...value, mask: [...(value.mask ?? []), ...paths] }),
    deprecated: (deprecated) => build({ ...value, deprecated }),
    latency: (latency) => build({ ...value, latency }),
    auditFields: (enabled = true) => build({ ...value, auditFields: enabled }),
    strictSchema: (enabled = true) => build({ ...value, strictSchema: enabled }),
    queryMapping: (queryMapping) =>
      build({ ...value, queryMapping: { ...value.queryMapping, ...queryMapping } }),
    faults: (...faults) => build({ ...value, faults: [...(value.faults ?? []), ...faults] }),
    reactions: (...reactions) =>
      build({ ...value, reactions: [...(value.reactions ?? []), ...reactions] }),
    state: (state) => build({ ...value, state }),
    build: () =>
      freeze({
        ...value,
        eventCatalog: [...value.eventCatalog],
        behaviors: [...value.behaviors],
        reducers: [...value.reducers],
      }),
  });
  return build({ boundary, contractPath, eventCatalog: [], behaviors: [], reducers: [] });
}

export interface RuntimeProgramBuilder {
  boundary(boundary: RuntimeBoundary): RuntimeProgramBuilder;
  policies(policies: RuntimePolicies): RuntimeProgramBuilder;
  build(): RuntimeDefinition;
  compile(dependencies: RuntimeDependencies): RuntimeProgram;
}

export function runtimeProgram(initial: readonly RuntimeBoundary[] = []): RuntimeProgramBuilder {
  const build = (definition: RuntimeDefinition): RuntimeProgramBuilder => ({
    boundary: (boundary) =>
      build({ ...definition, boundaries: [...definition.boundaries, boundary] }),
    policies: (policies) =>
      build({ ...definition, policies: { ...definition.policies, ...policies } }),
    build: () => freeze({ ...definition, boundaries: [...definition.boundaries] }),
    compile: (dependencies) => compileRuntime(definition, dependencies),
  });
  return build({ boundaries: [...initial] });
}

export type RuntimeDefinitionValue = RuntimeDefinition;
export type RuntimeJson = JsonValue | JsonObject;
