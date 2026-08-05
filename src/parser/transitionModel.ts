import type { OpenApiDoc } from '../contract/loader.js';
import type { RuntimeModelCoverage } from '../model/runtime.js';
import type { BoundaryConfig, BehaviorRule, ReducerRule } from '../dsl/types.js';
import type { YamlLinkedProgram } from '../dsl/types.js';
import type { DeclaredState } from '../dsl/schemaTypes.js';
import type { YamlProgramInput } from './public.js';
import { compileYaml } from './yamlParser.js';
import type { SimulationDefinition } from '../authoring/types.js';
import { buildTypeScriptTransitionModel } from '../authoring/transitionModel.js';
import { use } from '../authoring/composition.js';
import { boundaryName, parseContractPath } from '../domain/references.js';
import { collectTypeScriptComponents, prepareMixedYaml } from './mixed.js';
import { mergeTransitionModels } from '../model/transitionModel.js';
import type {
  Transition,
  TransitionMachine,
  TransitionModel,
  TransitionWriteSet,
} from '../model/transitionModel.js';

/** Input accepted by the pure static model builder. */
export interface TransitionModelInput {
  readonly program: YamlLinkedProgram;
  readonly openapi: OpenApiDoc;
}

/** Link the configured YAML input and then run the same pure builder. */
export async function buildConfiguredTransitionModel(
  input: YamlProgramInput,
  openapi: OpenApiDoc,
  authoring?: SimulationDefinition,
): Promise<TransitionModel> {
  const prepared =
    authoring === undefined
      ? { input, uses: [] }
      : prepareMixedYaml(input, collectTypeScriptComponents(authoring));
  const linked = await compileYaml(
    prepared.input.modules,
    prepared.input.globalYaml,
    prepared.input.componentModules,
    prepared.input.useMappingModules,
  );
  const yamlModel = buildTransitionModel({ program: linked, openapi });
  if (authoring === undefined) return yamlModel;
  return mergeTransitionModels(
    yamlModel,
    buildTypeScriptTransitionModel(
      {
        ...authoring,
        uses: [
          ...(authoring.uses ?? []),
          ...prepared.uses.map((entry) =>
            use(
              entry.component,
              boundaryName(entry.as),
              parseContractPath(entry.contractPath),
              entry.with,
              entry.bind,
            ),
          ),
        ],
      },
      openapi,
    ),
  );
}

interface AggregateGroup {
  readonly key: string;
  readonly aggregate: string;
  readonly boundaries: readonly BoundaryConfig[];
}

interface EventDefinition {
  readonly type: string;
  readonly payloadTemplate: Readonly<Record<string, unknown>>;
}

interface TransitionCandidate {
  readonly operation: string;
  readonly event: EventDefinition;
  readonly reducer: ReducerRule;
  readonly behavior: BehaviorRule;
  readonly guardCel: string | null;
  readonly from: string | '*';
}

interface NextState {
  readonly to: string | 'UNKNOWN';
  readonly guardCel: string | null;
  readonly nextStateKnown: boolean;
}

/**
 * Purely lift the linked YAML definition into the versioned transition model.
 * It deliberately does not execute CEL or reducer functions.
 */
export function buildTransitionModel(input: TransitionModelInput): TransitionModel {
  const machines = aggregateBoundaries(input.program.boundaries).map((group) =>
    buildMachine(group, input.openapi, input.program),
  );
  return { schemaVersion: 1, machines };
}

function aggregateBoundaries(boundaries: readonly BoundaryConfig[]): readonly AggregateGroup[] {
  const groups = new Map<string, { aggregate: string; boundaries: BoundaryConfig[] }>();
  for (const boundary of boundaries) {
    const key = aggregateKey(boundary);
    const current = groups.get(key);
    if (current === undefined) {
      groups.set(key, { aggregate: aggregateName(boundary), boundaries: [boundary] });
    } else {
      current.boundaries.push(boundary);
    }
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, group]) => ({ key, aggregate: group.aggregate, boundaries: group.boundaries }));
}

function aggregateKey(boundary: BoundaryConfig): string {
  if (boundary.schema !== undefined && boundary.schema.trim() !== '') return boundary.schema;
  const segments = boundary.contractPath.split('/').filter(Boolean);
  const firstResource = segments.find((segment) => !/^v\d+$/i.test(segment));
  return firstResource === undefined ? boundary.boundary : firstResource.toLowerCase();
}

function aggregateName(boundary: BoundaryConfig): string {
  const source = aggregateKey(boundary).replace(/[-_]+/g, ' ');
  return source
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => {
      const singular = part.length > 3 && part.endsWith('s') ? part.slice(0, -1) : part;
      return singular[0]!.toUpperCase() + singular.slice(1);
    })
    .join('');
}

function buildMachine(
  group: AggregateGroup,
  openapi: OpenApiDoc,
  program: YamlLinkedProgram,
): TransitionMachine {
  const schema = resolveAggregateSchema(group, openapi);
  const allEvents = uniqueEvents(group.boundaries);
  const allReducers = group.boundaries.flatMap((boundary) => boundary.reducers);
  const allBehaviors = group.boundaries.flatMap((boundary) => boundary.behaviors);
  const controlField = selectControlField(schema, allReducers, allBehaviors);
  const enumStates = enumValues(schemaField(schema, controlField));
  const candidates = transitionCandidates(allBehaviors, allReducers, allEvents, controlField);
  const transitions = candidates.flatMap((candidate) => resolveNextStates(candidate, controlField));
  const knownStates = transitions
    .filter((transition) => transition.nextStateKnown && transition.to !== 'UNKNOWN')
    .map((transition) => transition.to);
  const states = uniqueStrings(enumStates.length > 0 ? enumStates : knownStates);
  const normalizedStates = states.length === 0 ? ['UNKNOWN'] : states;
  const policy = inputCoverage(group, program);
  const initialStates = uniqueStrings([
    ...(policy?.initialStates ?? []),
    ...group.boundaries.flatMap((boundary) =>
      (boundary.initialization ?? [])
        .map((seed) => seed[controlField])
        .filter((value): value is string => typeof value === 'string'),
    ),
  ]);

  return {
    aggregate: group.aggregate,
    controlField,
    states: normalizedStates,
    transitions: uniqueTransitions(transitions),
    writeSets: buildWriteSets(group.boundaries, allEvents, allBehaviors, controlField, schema),
    ...(policy === undefined && initialStates.length === 0
      ? {}
      : {
          analysis: {
            ...(policy?.strict === undefined ? {} : { strict: policy.strict }),
            ...(initialStates.length === 0 ? {} : { initialStates }),
            ...(policy?.terminalStates === undefined
              ? {}
              : { terminalStates: policy.terminalStates }),
            ...(policy?.operations === undefined ? {} : { operations: policy.operations }),
            ...(policy?.suppressStates === undefined
              ? {}
              : { suppressStates: policy.suppressStates }),
          },
        }),
  };
}

function inputCoverage(
  group: AggregateGroup,
  program: YamlLinkedProgram,
): RuntimeModelCoverage | undefined {
  const policy = program.coverage?.[group.aggregate] ?? program.coverage?.[group.key];
  if (policy === undefined) return undefined;
  return {
    ...(policy.strict === undefined ? {} : { strict: policy.strict }),
    ...(policy.initial_states === undefined ? {} : { initialStates: policy.initial_states }),
    ...(policy.terminal_states === undefined ? {} : { terminalStates: policy.terminal_states }),
    ...(policy.operations === undefined ? {} : { operations: policy.operations }),
    ...(policy.suppress_states === undefined ? {} : { suppressStates: policy.suppress_states }),
  };
}

function uniqueEvents(boundaries: readonly BoundaryConfig[]): readonly EventDefinition[] {
  const events = new Map<string, EventDefinition>();
  for (const boundary of boundaries) {
    for (const event of boundary.eventCatalog) {
      if (!events.has(event.type)) {
        events.set(event.type, {
          type: event.type,
          payloadTemplate: event.payloadTemplate,
        });
      }
    }
  }
  return [...events.values()];
}

function transitionCandidates(
  behaviors: readonly BehaviorRule[],
  reducers: readonly ReducerRule[],
  events: readonly EventDefinition[],
  controlField: string,
): readonly TransitionCandidate[] {
  const eventsByName = new Map(events.map((event) => [event.type, event]));
  const reducersByEvent = new Map(reducers.map((reducer) => [reducer.on, reducer]));
  const candidates: TransitionCandidate[] = [];

  for (const behavior of behaviors) {
    const emitted = [
      ...(behavior.emit === undefined
        ? []
        : [{ event: behavior.emit, guard: null as string | null }]),
      ...(behavior.emitWhen?.map((entry) => ({ event: entry.emit, guard: text(entry.when) })) ??
        []),
    ];
    for (const entry of emitted) {
      const event = eventsByName.get(entry.event);
      const reducer = reducersByEvent.get(entry.event);
      if (
        event === undefined ||
        reducer === undefined ||
        !reducerTouchesField(reducer, controlField)
      )
        continue;
      candidates.push({
        operation: behavior.match.operationId,
        event,
        reducer,
        behavior,
        guardCel: combineGuards(requiresGuard(behavior), entry.guard),
        from: fromGuard(behavior, controlField),
      });
    }
  }
  return candidates;
}

function requiresGuard(behavior: BehaviorRule): string | null {
  const guards = (behavior.match.requires ?? []).map((guard) => text(guard.condition));
  return guards.length === 0 ? null : guards.map((guard) => `(${guard})`).join(' && ');
}

function reducerTouchesField(reducer: ReducerRule, controlField: string): boolean {
  if (reducer.replaceState === true) return true;
  return (
    reducer.patches?.some((patch) => patch.path.split('/').filter(Boolean)[0] === controlField) ??
    false
  );
}

function resolveNextStates(
  candidate: TransitionCandidate,
  controlField: string,
): readonly Transition[] {
  const expression = controlExpression(candidate.reducer, candidate.event, controlField);
  return expandNextState(expression).map((next) => ({
    from: candidate.from,
    to: next.to,
    op: candidate.operation,
    guardCel: combineGuards(candidate.guardCel, next.guardCel),
    nextStateKnown: next.nextStateKnown,
  }));
}

function controlExpression(
  reducer: ReducerRule,
  event: EventDefinition,
  controlField: string,
): string | undefined {
  if (reducer.replaceState === true)
    return resolveEventReference(text(event.payloadTemplate[controlField]), event);
  const patch = reducer.patches?.find(
    (candidate) => candidate.path.split('/').filter(Boolean)[0] === controlField,
  );
  return patch === undefined ? undefined : resolveEventReference(text(patch.value), event);
}

function resolveEventReference(expression: string, event: EventDefinition): string {
  const unwrapped = unwrapTemplate(expression).trim();
  const match = unwrapped.match(/^event\.payload\.([A-Za-z0-9_.-]+)$/);
  if (match === null) return expression;
  const value = event.payloadTemplate[match[1]!];
  return value === undefined ? expression : text(value);
}

function expandNextState(expression: string | undefined): readonly NextState[] {
  if (expression === undefined) return [];
  const unwrapped = unwrapTemplate(expression).trim();
  const ternary = splitTernary(unwrapped);
  if (ternary !== undefined) {
    const [condition, whenTrue, whenFalse] = ternary;
    return [
      ...expandNextState(whenTrue).map((next) => ({
        ...next,
        guardCel: combineGuards(condition, next.guardCel),
      })),
      ...expandNextState(whenFalse).map((next) => ({
        ...next,
        guardCel: combineGuards(`!(${condition})`, next.guardCel),
      })),
    ];
  }
  const literal = literalString(unwrapped);
  return literal === undefined
    ? [{ to: 'UNKNOWN', guardCel: null, nextStateKnown: false }]
    : [{ to: literal, guardCel: null, nextStateKnown: true }];
}

function fromGuard(behavior: BehaviorRule, controlField: string): string | '*' {
  for (const guard of behavior.match.requires ?? []) {
    const match = text(guard.condition).match(
      new RegExp(`^\\s*state\\.${escapeRegExp(controlField)}\\s*==\\s*(['"])([^'"]+)\\1\\s*$`),
    );
    if (match !== null) return match[2]!;
  }
  return '*';
}

function buildWriteSets(
  boundaries: readonly BoundaryConfig[],
  events: readonly EventDefinition[],
  behaviors: readonly BehaviorRule[],
  controlField: string,
  schema: Record<string, unknown> | undefined,
): Readonly<Record<string, TransitionWriteSet>> {
  const eventsByName = new Map(events.map((event) => [event.type, event]));
  const reducers = new Map<string, ReducerRule>();
  for (const boundary of boundaries) {
    for (const reducer of boundary.reducers)
      reducers.set(`${reducer.on}:${reducer.replaceState}`, reducer);
  }
  const result = new Map<string, TransitionWriteSet>();
  for (const behavior of behaviors) {
    const emitted = [
      ...(behavior.emit === undefined ? [] : [behavior.emit]),
      ...(behavior.emitWhen?.map((entry) => entry.emit) ?? []),
    ];
    for (const eventName of emitted) {
      const event = eventsByName.get(eventName);
      if (event === undefined) continue;
      const reducer = [...reducers.values()].find((candidate) => candidate.on === eventName);
      if (reducer === undefined) continue;
      const current = result.get(behavior.match.operationId);
      const next = writeSetFor(reducer, event, controlField, boundaries, schema);
      result.set(
        behavior.match.operationId,
        current === undefined ? next : mergeWriteSets(current, next),
      );
    }
  }
  return Object.fromEntries(
    [...result.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function writeSetFor(
  reducer: ReducerRule,
  event: EventDefinition,
  controlField: string,
  boundaries: readonly BoundaryConfig[],
  schema: Record<string, unknown> | undefined,
): TransitionWriteSet {
  const fields =
    reducer.replaceState === true
      ? Object.keys(event.payloadTemplate)
      : (reducer.patches ?? []).map((patch) => patch.path.split('/').filter(Boolean).join('.'));
  const uniqueFields = uniqueStrings(fields);
  const computed = boundaries.flatMap((boundary) => boundary.state?.computed ?? []);
  const derivedClosure = closure(uniqueFields, computed);
  const volatile = uniqueStrings([
    ...uniqueFields.filter((field) => schemaField(schema, field)?.readOnly === true),
    ...Object.entries(event.payloadTemplate)
      .filter(([, value]) => isNonDeterministic(text(value)))
      .map(([field]) => field),
  ]);
  return {
    fields: uniqueFields,
    replaceState: reducer.replaceState === true,
    derivedClosure,
    volatile,
  };
}

function mergeWriteSets(left: TransitionWriteSet, right: TransitionWriteSet): TransitionWriteSet {
  return {
    fields: uniqueStrings([...left.fields, ...right.fields]),
    replaceState: left.replaceState || right.replaceState,
    derivedClosure: uniqueStrings([...left.derivedClosure, ...right.derivedClosure]),
    volatile: uniqueStrings([...left.volatile, ...right.volatile]),
  };
}

function closure(
  fields: readonly string[],
  computed: readonly NonNullable<DeclaredState['computed']>[number][],
): readonly string[] {
  const result = new Set<string>();
  const pending = [...fields];
  while (pending.length > 0) {
    const field = pending.shift()!;
    for (const item of computed) {
      if (item.dependsOn.includes(field) && !result.has(item.name)) {
        result.add(item.name);
        pending.push(item.name);
      }
    }
  }
  return [...result].sort();
}

function selectControlField(
  schema: Record<string, unknown> | undefined,
  reducers: readonly ReducerRule[],
  behaviors: readonly BehaviorRule[],
): string {
  const enumFields = Object.entries(properties(schema)).filter(
    ([, value]) => enumValues(value).length > 0,
  );
  if (enumFields.length === 0) {
    const patched = uniqueStrings(
      reducers.flatMap((reducer) =>
        (reducer.patches ?? []).map((patch) => patch.path.split('/').filter(Boolean)[0] ?? ''),
      ),
    );
    return patched.find(Boolean) ?? 'state';
  }
  const patched = new Set(
    reducers.flatMap((reducer) =>
      (reducer.patches ?? []).map((patch) => patch.path.split('/').filter(Boolean)[0]),
    ),
  );
  const referenced = new Set(
    behaviors.flatMap((behavior) =>
      (behavior.match.requires ?? []).flatMap((guard) =>
        [...text(guard.condition).matchAll(/state\.([A-Za-z0-9_]+)/g)].map((match) => match[1]!),
      ),
    ),
  );
  return enumFields
    .sort(([left], [right]) => left.localeCompare(right))
    .sort(([left], [right]) => Number(patched.has(right)) - Number(patched.has(left)))
    .sort(([left], [right]) => Number(referenced.has(right)) - Number(referenced.has(left)))[0]![0];
}

function resolveAggregateSchema(
  group: AggregateGroup,
  openapi: OpenApiDoc,
): Record<string, unknown> | undefined {
  const schemas = record(record(record(openapi.raw)?.components)?.schemas);
  if (schemas === undefined) return undefined;
  const names = [group.key, group.aggregate, group.aggregate.toLowerCase()];
  const name = names.find((candidate) => schemas[candidate] !== undefined);
  return name === undefined ? undefined : resolveSchema(schemas[name], schemas);
}

function resolveSchema(
  value: unknown,
  schemas: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const source = record(value);
  if (source === undefined) return undefined;
  const ref = source['$ref'];
  if (typeof ref === 'string' && ref.startsWith('#/components/schemas/')) {
    const target = schemas[ref.slice('#/components/schemas/'.length)];
    return target === value ? source : resolveSchema(target, schemas);
  }
  if (Array.isArray(source['allOf'])) {
    return source['allOf'].reduce<Record<string, unknown>>(
      (merged, part) => ({ ...merged, ...resolveSchema(part, schemas) }),
      { ...source, allOf: undefined },
    );
  }
  return source;
}

function properties(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  return record(schema?.['properties']) ?? {};
}

function schemaField(
  schema: Record<string, unknown> | undefined,
  path: string,
): Record<string, unknown> | undefined {
  const parts = path.split('.').filter(Boolean);
  let current = schema;
  for (const part of parts) {
    current = record(current?.['properties'])?.[part] as Record<string, unknown> | undefined;
  }
  return current;
}

function enumValues(value: unknown): readonly string[] {
  const enumValues = record(value)?.['enum'];
  return Array.isArray(enumValues)
    ? enumValues.filter((candidate): candidate is string => typeof candidate === 'string')
    : [];
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  const serialized = JSON.stringify(value);
  return serialized === undefined ? '' : serialized;
}

function unwrapTemplate(value: string): string {
  const match = value.match(/^\$\{([\s\S]*)\}$/);
  return match === null ? value : match[1]!;
}

function literalString(value: string): string | undefined {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === "'" || quote === '"') && trimmed.at(-1) === quote) {
    return trimmed.slice(1, -1);
  }
  return undefined;
}

function splitTernary(value: string): readonly [string, string, string] | undefined {
  let depth = 0;
  let question = -1;
  let quote: string | undefined;
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (quote !== undefined) {
      if (char === quote && value[index - 1] !== '\\') quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth !== 0) continue;
    if (char === '?' && question < 0) question = index;
    if (char === ':' && question >= 0) {
      return [
        value.slice(0, question).trim(),
        value.slice(question + 1, index).trim(),
        value.slice(index + 1).trim(),
      ];
    }
  }
  return undefined;
}

function combineGuards(left: string | null, right: string | null): string | null {
  if (left === null || left.trim() === '') return right;
  if (right === null || right.trim() === '') return left;
  return `(${left}) && (${right})`;
}

function uniqueTransitions(values: readonly Transition[]): readonly Transition[] {
  const result = new Map<string, Transition>();
  for (const value of values) {
    const key = JSON.stringify(value);
    if (!result.has(key)) result.set(key, value);
  }
  return [...result.values()].sort((left, right) =>
    `${left.op}:${left.from}:${left.to}:${left.guardCel ?? ''}`.localeCompare(
      `${right.op}:${right.from}:${right.to}:${right.guardCel ?? ''}`,
    ),
  );
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value !== ''))].sort();
}

function isNonDeterministic(expression: string): boolean {
  return /\$(?:now|unix|uuidv7|fake(?:Seed|FromFormat)?)\s*\(|\brandom\s*\(/.test(expression);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
