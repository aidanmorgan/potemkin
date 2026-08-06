import type { JsonObject, JsonValue } from '../contracts/value.js';
import { compositionError } from './errors.js';
import type {
  BoundaryName,
  ComponentName,
  ContractPath,
  FieldPath,
  SchemaReference,
} from '../domain/references.js';
import type {
  ComponentDefinition,
  ComponentParameterDefinition,
  ComponentParameterType,
  ComponentReference,
  ComponentInclude,
  ComponentSource,
  ComposableBoundary,
  ExportDefinition,
  UseDefinition,
  YamlComponentReference,
  ReducerDefinition,
  BehaviorDefinition,
  EventDefinition,
  FaultDefinition,
  ReactionDefinition,
  ResponseDefinition,
  IdentityDefinition,
  InitializationDefinition,
  QueryDefinition,
  QueryMappingDefinition,
  DeprecationDefinition,
  LatencyDefinition,
  StateDefinition,
} from './types.js';
import { boundaryName, eventReference, eventType } from '../domain/references.js';

export type {
  ComponentDefinition,
  ComponentReference,
  ComponentInclude,
  ComponentParameterDefinition,
  ComponentParameterType,
  ComponentSource,
  ComposableBoundary,
  ExportDefinition,
  UseDefinition,
  YamlComponentReference,
};

export function yamlComponent(name: ComponentName): YamlComponentReference {
  if (name.trim() === '')
    throw compositionError('A YAML component reference requires a non-empty name');
  return Object.freeze({ kind: 'yaml-component', name });
}

export function isYamlComponentReference(value: unknown): value is YamlComponentReference {
  return (
    value !== null &&
    typeof value === 'object' &&
    'kind' in value &&
    value.kind === 'yaml-component'
  );
}

export function defineComponent(
  name: ComponentName,
  source: ComponentSource | ((parameters: Readonly<JsonObject>) => ComponentSource),
  options: Readonly<{ parameters?: Readonly<Record<string, ComponentParameterDefinition>> }> = {},
): ComponentDefinition {
  if (name.trim() === '') throw compositionError('A component requires a non-empty name');
  const instantiate = typeof source === 'function' ? source : () => source;
  return Object.freeze({
    name,
    instantiate,
    ...(options.parameters === undefined
      ? {}
      : { parameters: Object.freeze({ ...options.parameters }) }),
  });
}

export function include(
  component: ComponentReference,
  parameters: Readonly<JsonObject> = {},
): ComponentInclude {
  return { component, parameters };
}

export function use(
  component: ComponentReference,
  as: BoundaryName,
  contractPath: ContractPath,
  parameters: Readonly<JsonObject> = {},
  bind: Readonly<Record<string, string>> = {},
): UseDefinition {
  if (as.trim() === '')
    throw compositionError('A component use requires a non-empty boundary name');
  if (contractPath.trim() === '')
    throw compositionError(`Component use "${as}" requires a contract path`);
  return { component, as, contractPath, parameters, bind };
}

interface MutableSource {
  schema?: SchemaReference;
  fallbackOverride?: boolean;
  identity?: IdentityDefinition;
  query?: QueryDefinition;
  queryMapping?: QueryMappingDefinition;
  eventCatalog: EventDefinition[];
  behaviors: BehaviorDefinition[];
  reducers: ReducerDefinition[];
  initialization?: readonly InitializationDefinition[];
  response?: ResponseDefinition;
  mask?: readonly FieldPath[];
  latency?: LatencyDefinition;
  auditFields?: boolean;
  deprecated?: DeprecationDefinition;
  state?: StateDefinition;
  strictSchema?: boolean;
  faults?: readonly FaultDefinition[];
  reactions?: readonly ReactionDefinition[];
  export?: ExportDefinition;
}

function optionalSourceFields(
  source: MutableSource | ComponentSource | ComposableBoundary,
): Omit<MutableSource, 'eventCatalog' | 'behaviors' | 'reducers' | 'query'> {
  return {
    ...(source.schema === undefined ? {} : { schema: source.schema }),
    ...(source.fallbackOverride === undefined ? {} : { fallbackOverride: source.fallbackOverride }),
    ...(source.identity === undefined ? {} : { identity: source.identity }),
    ...(source.queryMapping === undefined ? {} : { queryMapping: source.queryMapping }),
    ...(source.initialization === undefined ? {} : { initialization: source.initialization }),
    ...(source.response === undefined ? {} : { response: source.response }),
    ...(source.mask === undefined ? {} : { mask: source.mask }),
    ...(source.latency === undefined ? {} : { latency: source.latency }),
    ...(source.auditFields === undefined ? {} : { auditFields: source.auditFields }),
    ...(source.deprecated === undefined ? {} : { deprecated: source.deprecated }),
    ...(source.state === undefined ? {} : { state: source.state }),
    ...(source.strictSchema === undefined ? {} : { strictSchema: source.strictSchema }),
    ...(source.faults === undefined ? {} : { faults: source.faults }),
    ...(source.reactions === undefined ? {} : { reactions: source.reactions }),
    ...(source.export === undefined ? {} : { export: source.export }),
  };
}

function sourceValue(source: ComponentSource | ComposableBoundary): MutableSource {
  return {
    ...optionalSourceFields(source),
    ...(source.query === undefined ? {} : { query: source.query }),
    eventCatalog: [...(source.eventCatalog ?? [])],
    behaviors: [...(source.behaviors ?? [])],
    reducers: [...(source.reducers ?? [])],
  };
}

function componentSource(
  component: ComponentDefinition,
  parameters: Readonly<JsonObject>,
  stack: readonly string[],
): MutableSource {
  if (stack.includes(component.name)) {
    throw compositionError(
      `Cyclic TypeScript component composition: ${[...stack, component.name].join(' -> ')}`,
    );
  }

  const raw = component.instantiate(resolveParameters(component, parameters));
  const source = sourceValue(raw);
  const includes = raw.include ?? [];
  return mergeIncludes(source, includes, [...stack, component.name]);
}

function resolveParameters(
  component: ComponentDefinition,
  supplied: Readonly<JsonObject>,
): JsonObject {
  const declarations = component.parameters ?? {};
  if (component.parameters === undefined) return { ...supplied };
  const resolved: JsonObject = { ...supplied };
  for (const [name, declaration] of Object.entries(declarations)) {
    const value = supplied[name];
    if (value === undefined) {
      if (declaration.required === true && declaration.default === undefined)
        throw compositionError(`Component "${component.name}" requires parameter "${name}"`);
      if (declaration.default !== undefined) resolved[name] = declaration.default;
      continue;
    }
    if (typeof value !== declaration.type)
      throw compositionError(
        `Component "${component.name}" parameter "${name}" must be a ${declaration.type}`,
      );
  }
  for (const name of Object.keys(supplied)) {
    if (declarations[name] === undefined)
      throw compositionError(`Component "${component.name}" does not declare parameter "${name}"`);
  }
  return resolved;
}

function mergeIncludes(
  host: MutableSource,
  includes: readonly ComponentInclude[],
  stack: readonly string[],
): MutableSource {
  if (includes.length === 0) return host;

  const localEvents = new Set(host.eventCatalog.map((event) => event.type));
  const localBehaviors = new Set(host.behaviors.map((behavior) => behavior.name));
  const includedEvents = new Map<string, string>();
  const includedBehaviors = new Map<string, string>();
  const eventCatalog = [...host.eventCatalog];
  const behaviors = [...host.behaviors];
  const reducers = [...host.reducers];
  let identity = host.identity;
  let identitySource = host.identity === undefined ? undefined : 'host';
  let schema = host.schema;
  let schemaSource = host.schema === undefined ? undefined : 'host';
  const computed = [...(host.state?.computed ?? [])];
  const internal = [...(host.state?.internal ?? [])];
  const fields = new Map<string, string>();
  for (const field of computed) fields.set(field.name, 'host');
  for (const field of internal) fields.set(field.name, 'host');
  let stateChanged = false;

  for (const entry of includes) {
    if (isYamlComponentReference(entry.component)) continue;
    const fragment = componentSource(entry.component, entry.parameters ?? {}, stack);
    for (const event of fragment.eventCatalog) {
      if (localEvents.has(event.type)) continue;
      const previous = includedEvents.get(event.type);
      if (previous !== undefined) {
        throw compositionError(
          `TypeScript component include clash: event "${event.type}" comes from "${previous}" and "${entry.component.name}"`,
        );
      }
      includedEvents.set(event.type, entry.component.name);
      eventCatalog.push(event);
    }
    for (const behavior of fragment.behaviors) {
      if (localBehaviors.has(behavior.name)) continue;
      const previous = includedBehaviors.get(behavior.name);
      if (previous !== undefined) {
        throw compositionError(
          `TypeScript component include clash: behavior "${behavior.name}" comes from "${previous}" and "${entry.component.name}"`,
        );
      }
      includedBehaviors.set(behavior.name, entry.component.name);
      behaviors.push(behavior);
    }
    reducers.push(...fragment.reducers);

    if (fragment.identity !== undefined) {
      if (identity !== undefined)
        throw compositionError(
          `TypeScript component include clash: identity is already supplied by ${identitySource}`,
        );
      identity = fragment.identity;
      identitySource = entry.component.name;
    }
    if (fragment.schema !== undefined) {
      if (schema !== undefined)
        throw compositionError(
          `TypeScript component include clash: schema is already supplied by ${schemaSource}`,
        );
      schema = fragment.schema;
      schemaSource = entry.component.name;
    }
    stateChanged =
      mergeStateFields(fragment.state?.computed ?? [], computed, fields, entry.component.name) ||
      stateChanged;
    stateChanged =
      mergeStateFields(fragment.state?.internal ?? [], internal, fields, entry.component.name) ||
      stateChanged;
  }

  return {
    ...host,
    eventCatalog,
    behaviors,
    reducers,
    ...(identity === undefined ? {} : { identity }),
    ...(schema === undefined ? {} : { schema }),
    ...(stateChanged ? { state: { computed, internal } } : {}),
  };
}

function resolveAlias(
  alias: string,
  componentName: ComponentName,
  concreteName: BoundaryName,
  bind: Readonly<Record<string, string>>,
  useName: string,
): BoundaryName {
  if (alias === componentName) return concreteName;
  const bound = bind[alias];
  if (bound !== undefined) return boundaryName(bound);
  throw compositionError(
    `TypeScript component use "${useName}" leaves boundary alias "${alias}" unbound`,
  );
}

function mergeStateFields<T extends { readonly name: string }>(
  incoming: readonly T[],
  target: T[],
  origins: Map<string, string>,
  sourceName: string,
): boolean {
  let changed = false;
  for (const field of incoming) {
    const previous = origins.get(field.name);
    if (previous !== undefined)
      throw compositionError(
        `TypeScript component include clash: state field "${field.name}" is already supplied by ${previous}`,
      );
    origins.set(field.name, sourceName);
    target.push(field);
    changed = true;
  }
  return changed;
}

function rewriteSource(source: MutableSource, useDefinition: UseDefinition): MutableSource {
  const componentName = useDefinition.component.name;
  const reactions = source.reactions?.map((reaction) => {
    const boundary =
      reaction.boundary === undefined
        ? undefined
        : resolveAlias(
            reaction.boundary,
            componentName,
            useDefinition.as,
            useDefinition.bind ?? {},
            useDefinition.as,
          );
    const on = rewriteEventSelector(reaction.on, componentName, useDefinition);
    return { ...reaction, ...(boundary === undefined ? {} : { boundary }), on };
  });
  const behaviors = source.behaviors.map((behavior) => ({
    ...behavior,
    ...(behavior.dispatchCommands === undefined
      ? {}
      : {
          dispatchCommands: behavior.dispatchCommands.map((command) => ({
            ...command,
            boundary: resolveAlias(
              command.boundary,
              componentName,
              useDefinition.as,
              useDefinition.bind ?? {},
              useDefinition.as,
            ),
          })),
        }),
  }));
  return {
    ...source,
    behaviors,
    ...(reactions === undefined ? {} : { reactions }),
  };
}

function rewriteEventSelector(
  selector: ReactionDefinition['on'],
  componentName: ComponentName,
  useDefinition: UseDefinition,
): ReactionDefinition['on'] {
  const separator = selector.indexOf(':');
  if (separator < 0) return selector;
  return eventReference(
    resolveAlias(
      selector.slice(0, separator),
      componentName,
      useDefinition.as,
      useDefinition.bind ?? {},
      useDefinition.as,
    ),
    eventType(selector.slice(separator + 1)),
  );
}

function toBoundary(
  source: MutableSource,
  boundary: BoundaryName,
  contractPath: ContractPath,
): ComposableBoundary {
  return {
    boundary,
    contractPath,
    eventCatalog: source.eventCatalog,
    behaviors: source.behaviors,
    reducers: source.reducers,
    ...optionalSourceFields(source),
    ...(source.query === undefined ? {} : { query: source.query }),
  };
}

function materializeBoundary(boundary: ComposableBoundary): ComposableBoundary {
  const source = mergeIncludes(sourceValue(boundary), boundary.include ?? [], []);
  return toBoundary(source, boundary.boundary, boundary.contractPath);
}

function materializeUse(value: UseDefinition): ComposableBoundary {
  if (isYamlComponentReference(value.component)) {
    throw compositionError(
      `YAML component "${value.component.name}" must be resolved by mixed compilation`,
    );
  }
  const source = rewriteSource(componentSource(value.component, value.parameters ?? {}, []), value);
  return toBoundary(source, value.as, value.contractPath);
}

/** Convert direct component composition into ordinary canonical runtime boundaries. */
export function composeBoundaries(
  boundaries: readonly ComposableBoundary[],
  uses: readonly UseDefinition[] = [],
): readonly ComposableBoundary[] {
  const result = [...boundaries.map(materializeBoundary), ...uses.map(materializeUse)];
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const boundary of result) {
    if (names.has(boundary.boundary))
      throw compositionError(`Duplicate runtime boundary "${boundary.boundary}"`);
    if (paths.has(boundary.contractPath))
      throw compositionError(`Duplicate runtime contract path "${boundary.contractPath}"`);
    names.add(boundary.boundary);
    paths.add(boundary.contractPath);
  }
  return result;
}

export type ComponentParameter = JsonValue;
