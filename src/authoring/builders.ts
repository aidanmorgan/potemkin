/** Runtime-independent TypeScript authoring builders. */

import type { JsonObject, JsonValue } from '../contracts/value.js';
import { definitionError, removedAliasError, TypeScriptAuthoringError } from './errors.js';
import { authoringLatencyProblem } from './latency.js';
import type {
  AuthoringPredicate,
  AuthoringValue,
  BehaviorBuilder,
  BehaviorDefinition,
  BoundaryBuilder,
  BoundaryDefinition,
  EventBuilder,
  EventDefinition,
  EventContext,
  Expression,
  ExpressionPhase,
  FaultDefinition,
  GlobalDefinition,
  ProjectionDefinition,
  QueryDefinition,
  QueryExpression,
  ReactionDefinition,
  ResponseDefinition,
  SagaDefinition,
  SimulationBuilder,
  SimulationDefinition,
  TypedEventContext,
  TypedEventDefinition,
  TypedMatchContext,
  TypedReducerContext,
  WebhookDefinition,
  TypeScriptHelperRegistration,
} from './types.js';
import type {
  BoundaryName,
  BehaviorName,
  ContractPath,
  EventType,
  SchemaReference,
} from '../domain/references.js';

export type {
  AuthoringPredicate,
  AuthoringValue,
  BehaviorBuilder,
  BehaviorDefinition,
  BoundaryBuilder,
  BoundaryDefinition,
  EventBuilder,
  EventDefinition,
  EventContext,
  Expression,
  ExpressionPhase,
  FaultDefinition,
  GlobalDefinition,
  ProjectionDefinition,
  QueryDefinition,
  QueryExpression,
  ReactionDefinition,
  ResponseDefinition,
  SagaDefinition,
  SimulationBuilder,
  SimulationDefinition,
  TypedEventContext,
  TypedEventDefinition,
  TypedMatchContext,
  TypedReducerContext,
  WebhookDefinition,
};

function freeze<T>(value: T): T;
function freeze(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) freeze(Reflect.get(value, key));
  return Object.freeze(value);
}

function copyValue<T>(value: T): T;
function copyValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(copyValue);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copyValue(child)]));
}

function defineReadonlyProperty<ObjectValue extends object, Key extends PropertyKey, PropertyValue>(
  value: ObjectValue,
  key: Key,
  propertyValue: PropertyValue,
): ObjectValue & Readonly<Record<Key, PropertyValue>>;
function defineReadonlyProperty(value: object, key: PropertyKey, propertyValue: unknown): object {
  Object.defineProperty(value, key, {
    configurable: false,
    enumerable: true,
    value: propertyValue,
    writable: false,
  });
  return value;
}

function removedAliases<T extends object>(value: T, aliases: Readonly<Record<string, string>>): T {
  for (const [alias, replacement] of Object.entries(aliases)) {
    Object.defineProperty(value, alias, {
      configurable: false,
      enumerable: false,
      value: () => {
        throw removedAliasError(alias, replacement);
      },
    });
  }
  return value;
}

export function expression<Value, Phase extends ExpressionPhase>(
  phase: Phase,
  callback: () => Value,
): Expression<unknown, Value, Phase>;
export function expression<Context, Value, Phase extends ExpressionPhase>(
  phase: Phase,
  callback: (context: Readonly<Context>) => Value,
): Expression<Context, Value, Phase>;
export function expression<Context, Value, Phase extends ExpressionPhase>(
  phase: Phase,
  callback: (context: Readonly<Context>) => Value,
): Expression<Context, Value, Phase> {
  return defineReadonlyProperty((context: Readonly<Context>) => callback(context), 'phase', phase);
}

export function query(predicate: QueryExpression): QueryExpression {
  return predicate;
}

export function all<Context>(
  ...predicates: readonly AuthoringPredicate<Context>[]
): AuthoringPredicate<Context> {
  return (context) => predicates.every((predicate) => predicate(context));
}

export function any<Context>(
  ...predicates: readonly AuthoringPredicate<Context>[]
): AuthoringPredicate<Context> {
  return (context) => predicates.some((predicate) => predicate(context));
}

export function not<Context>(predicate: AuthoringPredicate<Context>): AuthoringPredicate<Context> {
  return (context) => !predicate(context);
}

export function pipe<Input, Output>(input: Input, step: (value: Input) => Output): Output;
export function pipe<Input, A, Output>(
  input: Input,
  first: (value: Input) => A,
  second: (value: A) => Output,
): Output;
export function pipe<Input, Output>(
  input: Input,
  ...steps: readonly ((value: unknown) => unknown)[]
): Output;
export function pipe(input: unknown, ...steps: readonly ((value: unknown) => unknown)[]): unknown {
  return steps.reduce<unknown>((value, step) => step(value), input);
}

export function compose<Input, Output>(step: (value: Input) => Output): (value: Input) => Output;
export function compose<Input, A, Output>(
  outer: (value: A) => Output,
  inner: (value: Input) => A,
): (value: Input) => Output;
export function compose<Input, Output>(
  ...steps: readonly ((value: unknown) => unknown)[]
): (value: Input) => Output;
export function compose(
  ...steps: readonly ((value: unknown) => unknown)[]
): (value: unknown) => unknown {
  return (input) => steps.reduceRight<unknown>((value, step) => step(value), input);
}

export function mapReadonly<Input, Output>(
  values: readonly Input[],
  map: (value: Input) => Output,
): readonly Output[] {
  return Object.freeze(values.map(map));
}

export function concatReadonly<T>(...values: readonly (readonly T[])[]): readonly T[] {
  return Object.freeze(values.flatMap((value) => [...value]));
}

type EventPayloadValue<Value> = Value extends (...input: never[]) => infer Result ? Result : Value;
type InferredEventPayload<Definitions extends object> = {
  readonly [Key in keyof Definitions]: EventPayloadValue<Definitions[Key]>;
};
type EventPayloadExpressions<
  EventPayload extends object,
  CommandPayload extends object,
  State extends object,
> = Readonly<{
  [Key in keyof EventPayload]: AuthoringValue<
    TypedEventContext<CommandPayload, State>,
    EventPayload[Key]
  >;
}>;

type EventBuilderDefinition<
  EventPayload extends object,
  CommandPayload extends object,
  State extends object,
  EventName extends string,
> = TypedEventDefinition<EventPayload, CommandPayload, State, EventName>;

function mergeEventPayload<
  Current extends object,
  Added extends object,
  CommandPayload extends object,
  State extends object,
>(
  current: EventPayloadExpressions<Current, CommandPayload, State>,
  added: EventPayloadExpressions<Added, CommandPayload, State>,
): EventPayloadExpressions<Omit<Current, keyof Added> & Added, CommandPayload, State>;
function mergeEventPayload(current: object, added: object): object {
  return { ...current, ...added };
}

function eventBuilder<
  EventPayload extends object,
  CommandPayload extends object,
  State extends object,
  EventName extends string,
>(
  value: EventBuilderDefinition<EventPayload, CommandPayload, State, EventName>,
): EventBuilder<EventPayload, CommandPayload, State, EventName> {
  return {
    payload: <AddedPayload extends object>(
      next: EventPayloadExpressions<AddedPayload, CommandPayload, State>,
    ) =>
      eventBuilder({
        ...value,
        payload: mergeEventPayload(value.payload, next),
      }),
    schemaRef: (reference) => eventBuilder({ ...value, schemaRef: reference }),
    build: () => freeze(copyValue(value)),
  };
}

export function event<const Name extends string, const Definitions extends object>(
  type: EventType<Name>,
  payload: Definitions & Readonly<Record<string, AuthoringValue<EventContext, JsonValue>>>,
  schemaRef?: SchemaReference,
): TypedEventDefinition<InferredEventPayload<Definitions>, JsonObject, JsonObject, Name>;
export function event<
  EventPayload extends object,
  CommandPayload extends object = JsonObject,
  State extends object = JsonObject,
  const Name extends string = string,
>(
  type: EventType<Name>,
  payload: EventPayloadExpressions<EventPayload, CommandPayload, State>,
  schemaRef?: SchemaReference,
): TypedEventDefinition<EventPayload, CommandPayload, State, Name>;
export function event<
  EventPayload extends object = Record<never, never>,
  CommandPayload extends object = JsonObject,
  State extends object = JsonObject,
  const Name extends string = string,
>(type: EventType<Name>): EventBuilder<EventPayload, CommandPayload, State, Name>;
export function event(
  type: EventType,
  payload: Readonly<Record<string, AuthoringValue<EventContext, JsonValue>>> = {},
  schemaRef?: SchemaReference,
): EventDefinition | EventBuilder {
  const value: EventDefinition = {
    type,
    payload,
    ...(schemaRef === undefined ? {} : { schemaRef }),
  };
  return arguments.length === 1
    ? eventBuilder({
        type,
        payload: {},
      })
    : freeze(copyValue(value));
}

type BehaviorBuilderState = Omit<BehaviorDefinition, 'operationId'> &
  Partial<Pick<BehaviorDefinition, 'operationId'>>;

function buildBehavior(
  value: BehaviorBuilderState,
  behaviorName: BehaviorName,
): BehaviorDefinition {
  const { operationId, ...definition } = value;
  if (operationId === undefined || operationId === '')
    throw definitionError(`Behavior "${behaviorName}" requires an operationId`);
  if (
    definition.emit === undefined &&
    definition.emitWhen === undefined &&
    definition.dispatchCommands === undefined
  )
    throw definitionError(`Behavior "${behaviorName}" requires an event or dispatch`);
  return freeze(copyValue({ ...definition, operationId }));
}

export function behavior<Payload extends object = JsonObject, State extends object = JsonObject>(
  name: BehaviorName,
): BehaviorBuilder<Payload, State>;
export function behavior(value: BehaviorDefinition): BehaviorDefinition;
export function behavior(
  valueOrName: BehaviorName | BehaviorDefinition,
): BehaviorBuilder | BehaviorDefinition {
  if (typeof valueOrName !== 'string') return freeze(copyValue(valueOrName));
  const build = (value: BehaviorBuilderState): BehaviorBuilder =>
    removedAliases(
      {
        operation: (operationId) => build({ ...value, operationId }),
        condition: (condition) => build({ ...value, condition }),
        method: (method) => build({ ...value, method }),
        headers: (headers) => build({ ...value, headers: { ...headers } }),
        requires: (...guards) =>
          build({ ...value, requires: [...(value.requires ?? []), ...guards] }),
        scopes: (...scopes) =>
          build({ ...value, requiredScopes: [...(value.requiredScopes ?? []), ...scopes] }),
        emit: (event) => build({ ...value, emit: event, emitWhen: undefined }),
        emitWhen: (...emissions) => build({ ...value, emit: undefined, emitWhen: [...emissions] }),
        dispatch: (...commands) =>
          build({ ...value, dispatchCommands: [...(value.dispatchCommands ?? []), ...commands] }),
        postcondition: (condition) => build({ ...value, postcondition: condition }),
        link: (name, condition) =>
          build({
            ...value,
            linkName: name,
            ...(condition === undefined ? {} : { linkCondition: condition }),
          }),
        status: (status) => build({ ...value, responseStatus: status }),
        build: () => buildBehavior(value, valueOrName),
      },
      { when: 'condition' },
    );
  return build({ name: valueOrName });
}

export const defineSimulation = (value: SimulationDefinition): SimulationDefinition =>
  freeze(copyValue(value));
export const defineEvent = <Name extends string>(
  value: EventDefinition<Name>,
): EventDefinition<Name> => freeze(copyValue(value));
export const defineBehavior = (value: BehaviorDefinition): BehaviorDefinition =>
  freeze(copyValue(value));
export const defineFault = (value: FaultDefinition): FaultDefinition => freeze(copyValue(value));
export const defineReaction = (value: ReactionDefinition): ReactionDefinition =>
  freeze(copyValue(value));
export const defineWebhook = (value: WebhookDefinition): WebhookDefinition =>
  freeze(copyValue(value));
export const defineSaga = (value: SagaDefinition): SagaDefinition => freeze(copyValue(value));
export const defineProjection = (value: ProjectionDefinition): ProjectionDefinition =>
  freeze(copyValue(value));
export const defineGlobal = (value: GlobalDefinition): GlobalDefinition => freeze(copyValue(value));
export const defineResponse = (value: ResponseDefinition): ResponseDefinition =>
  freeze(copyValue(value));
export const defineQuery = (value: QueryDefinition): QueryDefinition => freeze(copyValue(value));

export function boundary(name: BoundaryName, contractPath: ContractPath): BoundaryBuilder {
  const build = (value: BoundaryDefinition): BoundaryBuilder =>
    removedAliases(
      {
        schema: (schema) => build({ ...value, schema }),
        fallbackOverride: (enabled = true) => build({ ...value, fallbackOverride: enabled }),
        identity: (identity) => build({ ...value, identity }),
        query: (query) => build({ ...value, query }),
        queryMapping: (queryMapping) =>
          build({ ...value, queryMapping: { ...value.queryMapping, ...queryMapping } }),
        eventCatalog: (...events) =>
          build({ ...value, eventCatalog: [...value.eventCatalog, ...events] }),
        behavior: (...behaviors) =>
          build({ ...value, behaviors: [...value.behaviors, ...behaviors] }),
        reducer: (...reducers) => build({ ...value, reducers: [...value.reducers, ...reducers] }),
        initialization: (...records) =>
          build({ ...value, initialization: [...(value.initialization ?? []), ...records] }),
        response: (response) => {
          const problem = authoringLatencyProblem(response.latency);
          if (problem !== undefined)
            throw new TypeScriptAuthoringError(
              'TS_CONFIGURATION_INVALID',
              `Boundary "${value.boundary}" has invalid response latency: ${problem.message}`,
            );
          return build({ ...value, response });
        },
        mask: (...fields) => build({ ...value, mask: [...(value.mask ?? []), ...fields] }),
        deprecated: (deprecated) => build({ ...value, deprecated }),
        latency: (latency) => {
          const problem = authoringLatencyProblem(latency);
          if (problem !== undefined)
            throw new TypeScriptAuthoringError(
              'TS_CONFIGURATION_INVALID',
              `Boundary "${value.boundary}" has invalid latency: ${problem.message}`,
            );
          return build({ ...value, latency });
        },
        auditFields: (enabled = true) => build({ ...value, auditFields: enabled }),
        strictSchema: (enabled = true) => build({ ...value, strictSchema: enabled }),
        state: (state) => build({ ...value, state }),
        faults: (...faults) => build({ ...value, faults: [...(value.faults ?? []), ...faults] }),
        reactions: (...reactions) =>
          build({ ...value, reactions: [...(value.reactions ?? []), ...reactions] }),
        include: (...includes) =>
          build({ ...value, include: [...(value.include ?? []), ...includes] }),
        build: () => freeze(copyValue(value)),
      },
      { event: 'eventCatalog', seed: 'initialization' },
    );
  return build({ boundary: name, contractPath, eventCatalog: [], behaviors: [], reducers: [] });
}

function isBuildable<T>(value: T | { build(): T }): value is { build(): T } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'build' in value &&
    typeof value.build === 'function'
  );
}

function built<T>(value: T | { build(): T }): T {
  return isBuildable(value) ? value.build() : value;
}

export function simulation(initial: readonly BoundaryDefinition[] = []): SimulationBuilder {
  const make = (definition: SimulationDefinition): SimulationBuilder =>
    removedAliases(
      {
        boundary: (value) =>
          make({ ...definition, boundaries: [...definition.boundaries, built(value)] }),
        boundaries: (...values) =>
          make({ ...definition, boundaries: [...definition.boundaries, ...values.map(built)] }),
        component: (component) =>
          make({ ...definition, components: [...(definition.components ?? []), component] }),
        components: (...components) =>
          make({ ...definition, components: [...(definition.components ?? []), ...components] }),
        use: (...values) => make({ ...definition, uses: [...(definition.uses ?? []), ...values] }),
        global: (policies) =>
          make({ ...definition, policies: { ...definition.policies, ...policies } }),
        resource: (resource) =>
          make({ ...definition, resources: [...(definition.resources ?? []), resource] }),
        resources: (...resources) =>
          make({ ...definition, resources: [...(definition.resources ?? []), ...resources] }),
        helper: (helper: TypeScriptHelperRegistration) =>
          make({ ...definition, helpers: [...(definition.helpers ?? []), helper.definition] }),
        build: () => freeze(copyValue(definition)),
      },
      { policies: 'global', helpers: 'helper' },
    );
  return make({ boundaries: [...initial] });
}
