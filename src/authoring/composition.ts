import type { JsonObject, JsonValue } from "../types.js";
import { compositionError } from "./errors.js";
import type {
  RuntimeBehavior,
  RuntimeBoundary,
  RuntimeDeprecation,
  RuntimeEvent,
  RuntimeFault,
  RuntimeIdentity,
  RuntimeLatency,
  RuntimeReaction,
  RuntimeReducer,
  RuntimeResponsePolicy,
  RuntimeStateSchema,
  RuntimeExportConfig,
} from "../model/runtime.js";
import type {
  BoundaryName,
  ComponentName,
  ContractPath,
  FieldPath,
  OperationId,
  SchemaReference,
  SagaName,
} from "./references.js";
import type {
  BehaviorDefinition,
  EventDefinition,
  FaultDefinition,
  ReducerDefinition,
  ReactionDefinition,
  ResponseDefinition,
  IdentityDefinition,
  InitializationDefinition,
  QueryDefinition,
  QueryMappingDefinition,
  DeprecationDefinition,
  LatencyDefinition,
  StateDefinition,
} from "./runtimeModel.js";

/**
 * A direct TypeScript component is a factory over values, not a template
 * containing placeholders. YAML keeps its parameter substitution grammar in
 * the parser; TypeScript callers pass ordinary typed values to this factory.
 */
export interface ComponentDefinition {
  readonly name: ComponentName;
  readonly instantiate: (parameters: Readonly<JsonObject>) => ComponentSource;
}

export interface ComponentInclude {
  readonly component: ComponentDefinition;
  readonly parameters?: Readonly<JsonObject>;
}

export interface ExportDefinition {
  readonly states: readonly {
    readonly name: string;
    readonly steps: readonly {
      readonly operationId: OperationId;
      readonly body?: JsonObject;
      readonly headers?: Readonly<Record<string, string>>;
    }[];
    readonly saga?: SagaName;
  }[];
}

/** The boundary fields which a reusable component may contribute. */
export interface ComponentSource {
  readonly schema?: SchemaReference;
  readonly fallbackOverride?: boolean;
  readonly eventCatalog?: readonly EventDefinition[];
  readonly behaviors?: readonly BehaviorDefinition[];
  readonly reducers?: readonly ReducerDefinition[];
  readonly identity?: IdentityDefinition;
  readonly query?: QueryDefinition;
  readonly queryMapping?: QueryMappingDefinition;
  readonly initialization?: readonly InitializationDefinition[];
  readonly state?: StateDefinition;
  readonly deprecated?: DeprecationDefinition;
  readonly latency?: LatencyDefinition;
  readonly response?: ResponseDefinition;
  readonly mask?: readonly FieldPath[];
  readonly faults?: readonly FaultDefinition[];
  readonly reactions?: readonly ReactionDefinition[];
  readonly include?: readonly ComponentInclude[];
  readonly auditFields?: boolean;
  readonly strictSchema?: boolean;
  readonly export?: ExportDefinition;
}

/** A live boundary may include reusable fragments before compilation. */
export type ComposableBoundary = Omit<RuntimeBoundary, "include"> & {
  readonly include?: readonly ComponentInclude[];
};

export interface UseDefinition {
  readonly component: ComponentDefinition;
  readonly as: BoundaryName;
  readonly contractPath: ContractPath;
  readonly parameters?: Readonly<JsonObject>;
  readonly bind?: Readonly<Record<string, string>>;
}

export function defineComponent(
  name: ComponentName,
  source: ComponentSource | ((parameters: Readonly<JsonObject>) => ComponentSource),
): ComponentDefinition {
  if (name.trim() === "") throw compositionError("A component requires a non-empty name");
  const instantiate = typeof source === "function" ? source : () => source;
  return Object.freeze({ name, instantiate });
}

export function include(
  component: ComponentDefinition,
  parameters: Readonly<JsonObject> = {},
): ComponentInclude {
  return { component, parameters };
}

export function use(
  component: ComponentDefinition,
  as: BoundaryName,
  contractPath: ContractPath,
  parameters: Readonly<JsonObject> = {},
  bind: Readonly<Record<string, string>> = {},
): UseDefinition {
  if (as.trim() === "")
    throw compositionError("A component use requires a non-empty boundary name");
  if (contractPath.trim() === "")
    throw compositionError(`Component use "${as}" requires a contract path`);
  return { component, as, contractPath, parameters, bind };
}

interface MutableSource {
  schema?: string;
  fallbackOverride?: boolean;
  identity?: RuntimeIdentity;
  query?: RuntimeBoundary["query"];
  queryMapping?: NonNullable<RuntimeBoundary["queryMapping"]>;
  eventCatalog: RuntimeEvent[];
  behaviors: RuntimeBehavior[];
  reducers: RuntimeReducer[];
  initialization?: RuntimeBoundary["initialization"];
  response?: RuntimeResponsePolicy;
  mask?: readonly string[];
  latency?: RuntimeLatency;
  auditFields?: boolean;
  deprecated?: RuntimeDeprecation;
  state?: RuntimeStateSchema;
  strictSchema?: boolean;
  faults?: readonly RuntimeFault[];
  reactions?: readonly RuntimeReaction[];
  export?: RuntimeExportConfig;
}

function sourceValue(source: ComponentSource | ComposableBoundary): MutableSource {
  return {
    ...(source.schema === undefined ? {} : { schema: source.schema }),
    ...(source.fallbackOverride === undefined ? {} : { fallbackOverride: source.fallbackOverride }),
    ...(source.identity === undefined ? {} : { identity: source.identity }),
    ...(source.query === undefined ? {} : { query: source.query }),
    ...(source.queryMapping === undefined ? {} : { queryMapping: source.queryMapping }),
    eventCatalog: [...(source.eventCatalog ?? [])],
    behaviors: [...(source.behaviors ?? [])],
    reducers: [...(source.reducers ?? [])],
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

function componentSource(
  component: ComponentDefinition,
  parameters: Readonly<JsonObject>,
  stack: readonly string[],
): MutableSource {
  if (stack.includes(component.name)) {
    throw compositionError(
      `Cyclic TypeScript component composition: ${[...stack, component.name].join(" -> ")}`,
    );
  }

  const raw = component.instantiate(parameters);
  const source = sourceValue(raw);
  const includes = raw.include ?? [];
  return mergeIncludes(source, includes, [...stack, component.name]);
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
  let identitySource = host.identity === undefined ? undefined : "host";
  let schema = host.schema;
  let schemaSource = host.schema === undefined ? undefined : "host";
  const computed = [...(host.state?.computed ?? [])];
  const internal = [...(host.state?.internal ?? [])];
  const fields = new Map<string, string>();
  for (const field of computed) fields.set(field.name, "host");
  for (const field of internal) fields.set(field.name, "host");
  let stateChanged = false;

  for (const entry of includes) {
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
    for (const field of fragment.state?.computed ?? []) {
      const previous = fields.get(field.name);
      if (previous !== undefined)
        throw compositionError(
          `TypeScript component include clash: state field "${field.name}" is already supplied by ${previous}`,
        );
      fields.set(field.name, entry.component.name);
      computed.push(field);
      stateChanged = true;
    }
    for (const field of fragment.state?.internal ?? []) {
      const previous = fields.get(field.name);
      if (previous !== undefined)
        throw compositionError(
          `TypeScript component include clash: state field "${field.name}" is already supplied by ${previous}`,
        );
      fields.set(field.name, entry.component.name);
      internal.push(field);
      stateChanged = true;
    }
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
  componentName: string,
  concreteName: string,
  bind: Readonly<Record<string, string>>,
  useName: string,
): string {
  if (alias === componentName) return concreteName;
  const bound = bind[alias];
  if (bound !== undefined) return bound;
  throw compositionError(
    `TypeScript component use "${useName}" leaves boundary alias "${alias}" unbound`,
  );
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
    const separator = reaction.on.indexOf(":");
    const on =
      separator < 0
        ? reaction.on
        : `${resolveAlias(reaction.on.slice(0, separator), componentName, useDefinition.as, useDefinition.bind ?? {}, useDefinition.as)}${reaction.on.slice(separator)}`;
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
  return { ...source, behaviors, ...(reactions === undefined ? {} : { reactions }) };
}

function toBoundary(
  source: MutableSource,
  boundary: string,
  contractPath: string,
): RuntimeBoundary {
  return {
    boundary,
    contractPath,
    eventCatalog: source.eventCatalog,
    behaviors: source.behaviors,
    reducers: source.reducers,
    ...(source.schema === undefined ? {} : { schema: source.schema }),
    ...(source.fallbackOverride === undefined ? {} : { fallbackOverride: source.fallbackOverride }),
    ...(source.identity === undefined ? {} : { identity: source.identity }),
    ...(source.query === undefined ? {} : { query: source.query }),
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

function materializeBoundary(boundary: ComposableBoundary): RuntimeBoundary {
  const source = mergeIncludes(sourceValue(boundary), boundary.include ?? [], []);
  return toBoundary(source, boundary.boundary, boundary.contractPath);
}

function materializeUse(value: UseDefinition): RuntimeBoundary {
  const source = rewriteSource(componentSource(value.component, value.parameters ?? {}, []), value);
  return toBoundary(source, value.as, value.contractPath);
}

/** Convert direct component composition into ordinary canonical runtime boundaries. */
export function composeBoundaries(
  boundaries: readonly ComposableBoundary[],
  uses: readonly UseDefinition[] = [],
): readonly RuntimeBoundary[] {
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
