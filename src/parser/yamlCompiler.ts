import type {
  YamlLinkedProgram,
  BoundaryConfig,
  BehaviorRule,
  EventCatalogEntry,
  FaultRule,
  ReactionRule,
  ReducerPatchOp,
  SagaConfig,
  WebhookConfig,
} from '../dsl/types.js';
import type { DeclaredState } from '../dsl/schemaTypes.js';
import { resolveActor, JwtValidationError } from '../identity/actorResolver.js';
import { createCelEvaluator, type CelEvaluator } from '../cel/evaluator.js';
import { CelPhase } from '../cel/phases.js';
import type { Command, DomainEvent } from '../contracts/domain.js';
import {
  isJsonObject,
  isJsonValue,
  type JsonObject,
  type JsonValue,
  type Patch,
} from '../contracts/value.js';
import { ErrorClass as ErrorClassKind, type ErrorClass } from '../contracts/controlHeaders.js';
import type {
  EventContext,
  FaultContext,
  IdentityContext,
  MatchContext,
  PostCommitContext,
  ProjectionContext,
  ResponseContext,
  RuntimeBehavior,
  RuntimeBoundary,
  RuntimeDependencies,
  RuntimeHelperDefinition,
  RuntimeDerivedProjection,
  RuntimeEmission,
  RuntimeEvent,
  RuntimeFault,
  RuntimeGuard,
  RuntimePolicies,
  RuntimePredicate,
  QueryContext,
  RuntimeReaction,
  RuntimeReducer,
  RuntimeReducerContext,
  RuntimeSaga,
  RuntimeSagaCompensation,
  RuntimeSagaStep,
  RuntimeValue,
  RuntimeWebhook,
  RuntimeRequest,
  RuntimeHelpers,
  SagaContext,
  WebhookContext,
} from '../model/runtime.js';
import { compileRuntime } from '../model/compiler.js';
import type { RuntimeDefinition, RuntimeModel } from '../model/index.js';
import { runLifecyclePhase } from '../authoring/lifecycle.js';
import type { LifecycleDefinition } from '../contracts/lifecycle.js';
import type { Logger } from '../observability/logger.js';
import { BootError } from '../errors.js';
import { compareQueryValues, readPath } from '../domain/query.js';

/**
 * Dependencies required while compiling YAML into the canonical runtime model.
 * CEL and YAML-shaped definitions stop here; the engine receives callbacks and
 * values in the source-independent model.
 */
export interface ParserRuntimeOptions {
  readonly dependencies: RuntimeDependencies;
  readonly cel?: CelEvaluator;
  readonly logger?: Logger;
  /** TypeScript helpers made available to YAML CEL before compilation. */
  readonly helpers?: readonly RuntimeHelperDefinition[];
}

const GLOBAL_BOUNDARY = '__global__';

interface ExpressionContext {
  readonly command?: Readonly<Command>;
  readonly request?: Readonly<RuntimeRequest>;
  readonly state: Readonly<JsonObject> | null;
  readonly payload: Readonly<JsonObject>;
  readonly param?: string | readonly string[];
  readonly helpers: Readonly<RuntimeHelpers>;
  readonly event?: DomainEvent;
  readonly operationId?: string;
  readonly response?: {
    readonly status: number;
    readonly body: JsonValue | null;
    readonly headers?: Readonly<Record<string, string>>;
  };
  readonly steps?: Readonly<Record<string, Readonly<{ status: number; body: JsonValue | null }>>>;
  readonly prevStep?: Readonly<{ status: number; body: JsonValue | null }>;
  readonly committedEvents?: readonly DomainEvent[];
}

/** Common shape shared by all source-independent runtime callback contexts. */
interface ExpressionInput {
  readonly command?: Readonly<Command>;
  readonly request?: Readonly<RuntimeRequest>;
  readonly state: Readonly<JsonObject> | null;
  readonly payload?: Readonly<JsonObject>;
  readonly param?: string | readonly string[];
  readonly helpers: Readonly<RuntimeHelpers>;
  readonly event?: DomainEvent;
  readonly operationId?: string;
  readonly response?: {
    readonly status: number;
    readonly body: JsonValue | null;
    readonly headers?: Readonly<Record<string, string>>;
  };
  readonly steps?: Readonly<Record<string, Readonly<{ status: number; body: JsonValue | null }>>>;
  readonly prevStep?: Readonly<{ status: number; body: JsonValue | null }>;
  readonly committedEvents?: readonly DomainEvent[];
}

function expressionContext<Input extends ExpressionInput>(
  context: Readonly<Input>,
): ExpressionContext {
  return {
    ...(context.command === undefined ? {} : { command: context.command }),
    ...(context.request === undefined ? {} : { request: context.request }),
    state: context.state,
    payload: context.payload ?? context.command?.payload ?? {},
    helpers: context.helpers,
    ...(context.param === undefined ? {} : { param: context.param }),
    ...(context.event === undefined ? {} : { event: context.event }),
    ...(context.operationId === undefined ? {} : { operationId: context.operationId }),
    ...(context.response === undefined
      ? {}
      : {
          response: {
            status: context.response.status,
            body: context.response.body,
            ...(context.response.headers === undefined
              ? {}
              : { headers: context.response.headers }),
          },
        }),
    ...(context.steps === undefined ? {} : { steps: context.steps }),
    ...(context.prevStep === undefined ? {} : { prevStep: context.prevStep }),
    ...(context.committedEvents === undefined ? {} : { committedEvents: context.committedEvents }),
  };
}

type ValueDecoder<Output> = (value: unknown) => Output;

function decodeJsonValue(value: unknown): JsonValue {
  if (!isJsonValue(value)) {
    throw new TypeError('YAML CEL expression did not produce a JSON value');
  }
  return value;
}

function decodeOptionalJsonValue(value: unknown): JsonValue | undefined {
  return value === undefined ? undefined : decodeJsonValue(value);
}

function decodeString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('YAML CEL expression did not produce a string');
  }
  return value;
}

function decodeStringOrNull(value: unknown): string | null {
  if (value !== null && typeof value !== 'string') {
    throw new TypeError('YAML CEL expression did not produce a string or null');
  }
  return value;
}

function decodeStringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function decodeNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('YAML CEL expression did not produce a finite number');
  }
  return value;
}

/** Identity generation historically stringifies CEL scalar results. */
function stringifyIdentity(value: unknown): string {
  return String(value);
}

function requiredField<T>(value: T | undefined, field: string): T {
  if (value === undefined) {
    throw new BootError('BOOT_ERR_DSL_SCHEMA_VIOLATION', `YAML patch is missing ${field}`, {
      field,
    });
  }
  return value;
}

function isErrorClass(value: string): value is ErrorClass {
  return (
    value === ErrorClassKind.Timeout ||
    value === ErrorClassKind.Throttle ||
    value === ErrorClassKind.Outage ||
    value === ErrorClassKind.BadGateway ||
    value === ErrorClassKind.Conflict ||
    value === ErrorClassKind.Auth ||
    value === ErrorClassKind.Forbidden
  );
}

function jsonArguments(args: readonly unknown[]): readonly JsonValue[] {
  const values: JsonValue[] = [];
  for (const [index, argument] of args.entries()) {
    if (!isJsonValue(argument)) {
      throw new TypeError(`YAML CEL helper argument ${index} is not a JSON value`);
    }
    values.push(argument);
  }
  return values;
}

type MutableFaultSelectors = {
  -readonly [Key in keyof NonNullable<RuntimeFault['selectors']>]?: NonNullable<
    RuntimeFault['selectors']
  >[Key];
};

function evaluate(
  value: unknown,
  phase: CelPhase,
  _boundary: string,
  context: ExpressionContext,
  cel: CelEvaluator,
): unknown {
  if (typeof value !== 'string') return value;
  const controls = context.request?.controls;
  const requestCel =
    controls === undefined || (controls.clockOffsetMs === undefined && controls.seed === undefined)
      ? cel
      : cel.withRequestContext({
          ...(controls.clockOffsetMs === undefined
            ? {}
            : { clockOffsetMs: controls.clockOffsetMs }),
          ...(controls.seed === undefined ? {} : { seed: controls.seed }),
        });
  const ctx: Record<string, unknown> = {
    command: context.command,
    request: context.request,
    state: context.state,
    payload: context.payload,
    ...(context.command !== undefined
      ? {
          query: context.command.queryParams,
          params: context.command.queryParams,
          param: context.param ?? context.command.queryParams,
        }
      : {}),
    ...(context.event !== undefined ? { event: context.event } : {}),
    ...(context.steps !== undefined ? { steps: context.steps } : {}),
    ...(context.prevStep !== undefined ? { prevStep: context.prevStep } : {}),
    ...(context.committedEvents !== undefined ? { committedEvents: context.committedEvents } : {}),
    ...('response' in context && context.response !== undefined
      ? { response: context.response }
      : {}),
  };
  if (value.includes('${')) {
    return requestCel.evaluateDslValue(value, ctx, phase);
  }
  return requestCel.evaluate(value, ctx, phase);
}

function value<Input extends ExpressionInput, Output>(
  raw: unknown,
  phase: CelPhase,
  boundary: string,
  cel: CelEvaluator,
  decode: ValueDecoder<Output>,
  fallbackLiteral = false,
): RuntimeValue<Input, Output> {
  if (typeof raw !== 'string') return decode(raw);
  return (context: Readonly<Input>): Output => {
    try {
      return decode(evaluate(raw, phase, boundary, expressionContext(context), cel));
    } catch (error) {
      if (fallbackLiteral && !raw.includes('${')) return decode(raw);
      throw error;
    }
  };
}

function callbackValue<Input extends ExpressionInput, Output>(
  raw: unknown,
  phase: CelPhase,
  boundary: string,
  cel: CelEvaluator,
  decode: ValueDecoder<Output>,
  fallbackLiteral = false,
): (context: Readonly<Input>) => Output {
  return (context: Readonly<Input>) => {
    if (typeof raw !== 'string') return decode(raw);
    try {
      return decode(evaluate(raw, phase, boundary, expressionContext(context), cel));
    } catch (error) {
      if (fallbackLiteral && !raw.includes('${')) return decode(raw);
      throw error;
    }
  };
}

function predicate<Input extends ExpressionInput>(
  raw: unknown,
  phase: CelPhase,
  boundary: string,
  cel: CelEvaluator,
): RuntimePredicate<Input> {
  return (context: Readonly<Input>) =>
    Boolean(evaluate(raw, phase, boundary, expressionContext(context), cel));
}

function compileEvent(entry: EventCatalogEntry, boundary: string, cel: CelEvaluator): RuntimeEvent {
  return {
    type: entry.type,
    schemaRef: entry.schemaRef,
    payload: Object.fromEntries(
      Object.entries(entry.payloadTemplate).map(([key, raw]) => [
        key,
        value<EventContext, JsonValue>(
          raw,
          CelPhase.EventHydration,
          boundary,
          cel,
          decodeJsonValue,
          true,
        ),
      ]),
    ),
  };
}

function compileGuard(
  raw: {
    readonly name: string;
    readonly condition: string;
    readonly errorCode: string;
    readonly errorMessage: string;
    readonly errorStatus?: number;
  },
  boundary: string,
  cel: CelEvaluator,
): RuntimeGuard {
  return {
    name: raw.name,
    check: predicate<MatchContext | FaultContext>(raw.condition, CelPhase.Behavior, boundary, cel),
    errorCode: raw.errorCode,
    errorMessage: raw.errorMessage,
    ...(raw.errorStatus === undefined ? {} : { errorStatus: raw.errorStatus }),
  };
}

function compileBehavior(raw: BehaviorRule, boundary: string, cel: CelEvaluator): RuntimeBehavior {
  return {
    name: raw.name,
    operationId: raw.match.operationId,
    condition: predicate(raw.match.condition, CelPhase.Behavior, boundary, cel),
    ...(raw.match.requires
      ? { requires: raw.match.requires.map((guard) => compileGuard(guard, boundary, cel)) }
      : {}),
    ...(raw.match.requiredScopes ? { requiredScopes: raw.match.requiredScopes } : {}),
    ...(raw.match.method ? { method: raw.match.method } : {}),
    ...(raw.match.headers ? { headers: raw.match.headers } : {}),
    ...(raw.emit ? { emit: raw.emit } : {}),
    ...(raw.emitWhen
      ? {
          emitWhen: raw.emitWhen.map(
            (entry): RuntimeEmission => ({
              when: predicate(entry.when, CelPhase.Behavior, boundary, cel),
              event: entry.emit,
            }),
          ),
        }
      : {}),
    ...(raw.postcondition
      ? {
          postcondition: predicate<PostCommitContext>(
            raw.postcondition,
            CelPhase.Behavior,
            boundary,
            cel,
          ),
        }
      : {}),
    ...(raw.linkName ? { linkName: raw.linkName } : {}),
    ...(raw.linkCondition
      ? { linkCondition: predicate(raw.linkCondition, CelPhase.Behavior, boundary, cel) }
      : {}),
    ...(raw.responseStatus === undefined ? {} : { responseStatus: raw.responseStatus }),
    ...(raw.dispatchCommands
      ? {
          dispatchCommands: raw.dispatchCommands.map((command) => ({
            boundary: command.boundary,
            intent: command.intent,
            operationId: command.operationId,
            targetId: value<MatchContext, string | null>(
              command.targetId,
              CelPhase.Behavior,
              boundary,
              cel,
              decodeStringOrNull,
            ),
            ...(command.payload
              ? {
                  payload: Object.fromEntries(
                    Object.entries(command.payload).map(([key, rawValue]) => [
                      key,
                      value<MatchContext, JsonValue>(
                        rawValue,
                        CelPhase.Behavior,
                        boundary,
                        cel,
                        decodeJsonValue,
                        true,
                      ),
                    ]),
                  ),
                }
              : {}),
            ...(command.condition
              ? {
                  condition: predicate(command.condition, CelPhase.Behavior, boundary, cel),
                }
              : {}),
          })),
        }
      : {}),
  };
}

function patchValue(
  raw: unknown,
  context: RuntimeReducerContext,
  boundary: string,
  cel: CelEvaluator,
): JsonValue {
  const evaluated = evaluate(raw, CelPhase.Reducer, boundary, context, cel);
  if (evaluated === undefined || typeof evaluated === 'function') return null;
  return decodeJsonValue(evaluated);
}

function compilePatch(
  raw: ReducerPatchOp,
  boundary: string,
  cel: CelEvaluator,
  context: RuntimeReducerContext,
): Patch {
  switch (raw.op) {
    case 'remove':
      return { op: 'remove', path: raw.path };
    case 'move':
      return { op: 'move', path: raw.path, from: requiredField(raw.from, 'from') };
    case 'copy':
      return { op: 'copy', path: raw.path, from: requiredField(raw.from, 'from') };
    case 'increment':
      return { op: 'increment', path: raw.path, by: raw.by ?? 0 };
    case 'upsert':
      return {
        op: 'upsert',
        path: raw.path,
        key: requiredField(raw.key, 'key'),
        value: requireJsonObject(patchValue(raw.value, context, boundary, cel), 'upsert value'),
      };
    case 'merge':
      return {
        op: 'merge',
        path: raw.path,
        value: requireJsonObject(patchValue(raw.value, context, boundary, cel), 'merge value'),
        ...(raw.deep !== undefined ? { deep: raw.deep } : {}),
      };
    case 'add':
      return {
        op: 'add',
        path: raw.path,
        value: patchValue(raw.value, context, boundary, cel),
      };
    case 'replace':
      return {
        op: 'replace',
        path: raw.path,
        value: patchValue(raw.value, context, boundary, cel),
      };
    case 'append':
      return {
        op: 'append',
        path: raw.path,
        value: patchValue(raw.value, context, boundary, cel),
      };
    case 'prepend':
      return {
        op: 'prepend',
        path: raw.path,
        value: patchValue(raw.value, context, boundary, cel),
      };
  }
}

function requireJsonObject(value: JsonValue, field: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new TypeError(`YAML ${field} must evaluate to a JSON object`);
  }
  return value;
}

function compileReducer(
  raw: NonNullable<BoundaryConfig['reducers']>[number],
  boundary: string,
  cel: CelEvaluator,
): RuntimeReducer {
  const patches = raw.patches;
  return {
    on: raw.on,
    replaceState: raw.replaceState,
    apply:
      patches === undefined
        ? undefined
        : (context) => patches.map((patch) => compilePatch(patch, boundary, cel, context)),
  };
}

function compileState(
  state: DeclaredState | undefined,
  boundary: string,
  cel: CelEvaluator,
): RuntimeBoundary['state'] {
  if (state === undefined) return undefined;
  return {
    computed: state.computed?.map((field) => ({
      name: field.name,
      dependsOn: field.dependsOn,
      formula: value<RuntimeReducerContext, JsonValue>(
        field.formula,
        CelPhase.Projection,
        boundary,
        cel,
        decodeJsonValue,
        true,
      ),
    })),
    internal: state.internal?.map((field) => ({ name: field.name, type: field.type.kind })),
  };
}

function compileReaction(raw: ReactionRule, boundary: string, cel: CelEvaluator): RuntimeReaction {
  return {
    name: raw.name,
    on: raw.on,
    boundary: raw.boundary ?? boundary,
    emit: raw.emit,
    intent: raw.intent,
    ...(raw.when
      ? {
          when: predicate<PostCommitContext>(raw.when, CelPhase.PostCommit, boundary, cel),
        }
      : {}),
    ...(raw.target
      ? {
          target: value<PostCommitContext, string | null>(
            raw.target,
            CelPhase.PostCommit,
            boundary,
            cel,
            decodeStringOrNull,
          ),
        }
      : {}),
    ...(raw.payload
      ? {
          payload: Object.fromEntries(
            Object.entries(raw.payload).map(([key, rawValue]) => [
              key,
              value<PostCommitContext, JsonValue>(
                rawValue,
                CelPhase.PostCommit,
                boundary,
                cel,
                decodeJsonValue,
                true,
              ),
            ]),
          ),
        }
      : {}),
  };
}

function compileFault(raw: FaultRule, boundary: string, cel: CelEvaluator): RuntimeFault {
  const selector = (name: string): string | undefined =>
    Object.entries(raw.match.headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
  const selectors: MutableFaultSelectors = {};
  const signal = selector('x-potemkin-signal');
  const forceResponse = selector('x-potemkin-force-response');
  const scenario = selector('x-potemkin-scenario');
  const featureFlag = selector('x-potemkin-feature-flag');
  const errorClass = selector('x-potemkin-error-class');
  if (signal !== undefined) selectors.signal = signal;
  if (forceResponse !== undefined) selectors.forceResponse = forceResponse;
  if (scenario !== undefined) selectors.scenario = scenario;
  if (featureFlag !== undefined) selectors.featureFlag = featureFlag;
  if (errorClass !== undefined && isErrorClass(errorClass)) selectors.errorClass = errorClass;
  return {
    name: raw.name,
    probability: raw.match.probability,
    requiredScopes: raw.match.requiredScopes,
    ...(Object.keys(selectors).length === 0 ? {} : { selectors }),
    ...(raw.match.headers === undefined ? {} : { headers: raw.match.headers }),
    ...(raw.match.requires
      ? { requires: raw.match.requires.map((guard) => compileGuard(guard, boundary, cel)) }
      : {}),
    delayMs: raw.delay_ms,
    matches: (context) => {
      if (
        raw.match.boundary !== undefined &&
        raw.match.boundary !== '*' &&
        raw.match.boundary !== context.command.boundary
      )
        return false;
      if (raw.match.intent !== undefined && raw.match.intent !== context.command.intent)
        return false;
      if (
        raw.match.operationId !== undefined &&
        raw.match.operationId !== context.command.operationId
      )
        return false;
      if (
        raw.match.method !== undefined &&
        raw.match.method.toUpperCase() !== context.command.httpMethod.toUpperCase()
      )
        return false;
      const headers = raw.match.headers ?? {};
      if (
        !Object.entries(headers).every(([name, expected]) => {
          const actual = Object.entries(context.headers).find(
            ([key]) => key.toLowerCase() === name.toLowerCase(),
          )?.[1];
          return (
            actual !== undefined &&
            (expected === '*' || expected === 'present' || actual === expected)
          );
        })
      )
        return false;
      return predicate<FaultContext>(raw.match.condition, CelPhase.Fault, boundary, cel)(context);
    },
    response: raw.response,
  };
}

/**
 * Compile one YAML/DSL-shaped fault rule into the same runtime fault used by
 * a direct TypeScript definition. The HTTP admin surface uses this parser
 * entry point for dynamic rules; CEL and DSL field names therefore remain at
 * the parser boundary instead of entering the core engine.
 */
export interface FaultParserOptions {
  readonly boundary?: string;
  readonly cel: CelEvaluator;
}

export function compileYamlFaultRule(raw: FaultRule, options: FaultParserOptions): RuntimeFault {
  return compileFault(raw, options.boundary ?? GLOBAL_BOUNDARY, options.cel);
}

function compileWebhook(raw: WebhookConfig, boundary: string, cel: CelEvaluator): RuntimeWebhook {
  return {
    name: raw.name,
    trigger: (context) => {
      if (raw.trigger.boundary !== undefined && raw.trigger.boundary !== context.command.boundary)
        return false;
      if (raw.trigger.intent !== undefined && raw.trigger.intent !== context.command.intent)
        return false;
      return predicate<WebhookContext>(
        raw.trigger.condition,
        CelPhase.Webhook,
        boundary,
        cel,
      )(context);
    },
    url: value<WebhookContext, string>(
      raw.url,
      CelPhase.Webhook,
      boundary,
      cel,
      decodeString,
      true,
    ),
    ...(raw.secret ? { secret: raw.secret } : {}),
    ...(raw.payload
      ? {
          payload: Object.fromEntries(
            Object.entries(raw.payload).map(([key, rawValue]) => [
              key,
              value<WebhookContext, JsonValue>(
                rawValue,
                CelPhase.Webhook,
                boundary,
                cel,
                decodeJsonValue,
                true,
              ),
            ]),
          ),
        }
      : {}),
    ...(raw.retry ? { retry: raw.retry } : {}),
  };
}

function compileLifecycle(
  definition: LifecycleDefinition | undefined,
  helpers: RuntimeDependencies['helpers'],
  clock: RuntimeDependencies['clock'],
): RuntimePolicies['lifecycle'] {
  if (definition === undefined) return undefined;
  const run = async (
    phase: Parameters<typeof runLifecyclePhase>[1],
    context?: MatchContext | PostCommitContext,
  ): Promise<void> => {
    await runLifecyclePhase(
      definition,
      phase,
      {
        ...(context?.command !== undefined
          ? { boundary: context.command.boundary, command: context.command }
          : {}),
        ...(context !== undefined && 'event' in context && context.event !== undefined
          ? { event: context.event }
          : {}),
        ...(context?.state !== undefined ? { state: context.state } : {}),
        ...(context !== undefined && 'response' in context && context.response !== undefined
          ? { response: context.response }
          : {}),
        helpers: {
          uuid: helpers.uuid,
          now: helpers.now,
          data: helpers.data,
          deepClone: helpers.clone,
          deepMerge: (left, right) => ({ ...left, ...right }),
        },
      },
      {
        failure: phase === 'post-commit' ? 'continue' : 'abort',
        nowMs: clock.nowMs,
      },
    );
  };
  return {
    boot: () => run('boot'),
    validation: () => run('validation'),
    initialization: () => run('initialization'),
    request: (context) => run('request', context),
    projection: (context) => run('projection', context),
    commit: (context) => run('commit', context),
    postCommit: (context) => run('post-commit', context),
    reset: () => run('reset'),
    shutdown: () => run('shutdown'),
  };
}

function compileSaga(raw: SagaConfig, boundary: string, cel: CelEvaluator): RuntimeSaga {
  const step = (item: SagaConfig['steps'][number]): RuntimeSagaStep => ({
    name: item.name,
    boundary: item.boundary,
    intent: item.intent,
    operationId: item.operationId,
    ...(item.targetId
      ? {
          targetId: value<SagaContext, string | null>(
            item.targetId,
            CelPhase.Saga,
            boundary,
            cel,
            decodeStringOrNull,
          ),
        }
      : {}),
    ...(item.payload
      ? {
          payload: Object.fromEntries(
            Object.entries(item.payload).map(([key, rawValue]) => [
              key,
              value<SagaContext, JsonValue>(
                rawValue,
                CelPhase.Saga,
                boundary,
                cel,
                decodeJsonValue,
                true,
              ),
            ]),
          ),
        }
      : {}),
    ...(item.compensation
      ? {
          compensation: {
            intent: item.compensation.intent,
            operationId: item.compensation.operationId,
            ...(item.compensation.targetId
              ? {
                  targetId: value<SagaContext, string | null>(
                    item.compensation.targetId,
                    CelPhase.Saga,
                    boundary,
                    cel,
                    decodeStringOrNull,
                  ),
                }
              : {}),
            ...(item.compensation.payload
              ? {
                  payload: Object.fromEntries(
                    Object.entries(item.compensation.payload).map(([key, rawValue]) => [
                      key,
                      value<SagaContext, JsonValue>(
                        rawValue,
                        CelPhase.Saga,
                        boundary,
                        cel,
                        decodeJsonValue,
                        true,
                      ),
                    ]),
                  ),
                }
              : {}),
          } satisfies RuntimeSagaCompensation,
        }
      : {}),
  });
  return {
    name: raw.name,
    trigger: {
      boundary: raw.trigger.boundary,
      intent: raw.trigger.intent,
      condition: predicate<SagaContext>(raw.trigger.condition, CelPhase.Saga, boundary, cel),
    },
    steps: raw.steps.map(step),
  };
}

function responseHelper(
  name: string,
  helpers: readonly RuntimeHelperDefinition[],
  boundary: string,
): NonNullable<RuntimeBoundary['response']>['transform'] {
  const helper = helpers.find((candidate) => candidate.name === name);
  if (helper === undefined) {
    throw new BootError(
      'BOOT_ERR_DSL_REFERENCE',
      `Boundary "${boundary}" references unknown response helper "${name}"`,
      { boundary, helper: name },
    );
  }
  return (context) => {
    const command = context.command;
    const input: JsonObject = {
      operationId: context.operationId ?? null,
      command: {
        commandId: command.commandId,
        boundary: command.boundary,
        intent: command.intent,
        targetId: command.targetId,
        payload: command.payload,
        queryParams: command.queryParams,
        httpMethod: command.httpMethod,
        path: command.path,
        origin: command.origin,
        depth: command.depth,
        ...(command.operationId === undefined ? {} : { operationId: command.operationId }),
      },
      state: context.state,
      payload: context.payload,
      response: context.response,
    };
    const result = helper.invoke([input], CelPhase.Response);
    if (!isJsonObject(result)) return undefined;
    const output = result;
    const headers = output['headers'];
    return {
      ...(typeof output['status'] === 'number' ? { status: output['status'] } : {}),
      ...(output['body'] === undefined ? {} : { body: output['body'] }),
      ...(isStringMap(headers) ? { headers } : {}),
    };
  };
}

function isStringMap(value: JsonValue | undefined): value is Record<string, string> {
  return isJsonObject(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function compileQuery(
  raw: NonNullable<BoundaryConfig['query']>,
  boundary: string,
  cel: CelEvaluator,
): NonNullable<RuntimeBoundary['query']> {
  return {
    ...(raw.fields === undefined
      ? {}
      : {
          fields: Object.fromEntries(
            Object.entries(raw.fields).map(([name, expression]) => [
              name,
              predicate<QueryContext>(expression, CelPhase.Query, boundary, cel),
            ]),
          ),
        }),
    ...(raw.filter === undefined
      ? {}
      : { filter: predicate<QueryContext>(raw.filter, CelPhase.Query, boundary, cel) }),
    ...(raw.sort === undefined
      ? {}
      : {
          sort: (left: Readonly<JsonObject>, right: Readonly<JsonObject>) => {
            for (const key of raw.sort ?? []) {
              const direction = key.direction === 'desc' ? -1 : 1;
              const compared =
                direction *
                compareQueryValues(readPath(left, key.field), readPath(right, key.field));
              if (compared !== 0) return compared;
            }
            return 0;
          },
        }),
    ...(raw.pageSize === undefined
      ? {}
      : {
          pageSize: value<QueryContext, number>(
            raw.pageSize,
            CelPhase.Query,
            boundary,
            cel,
            decodeNumber,
          ),
        }),
    ...(raw.maxPageSize === undefined ? {} : { maxPageSize: raw.maxPageSize }),
    ...(raw.cursor === undefined
      ? {}
      : {
          cursor: value<QueryContext, string | undefined>(
            raw.cursor,
            CelPhase.Query,
            boundary,
            cel,
            decodeStringOrUndefined,
          ),
        }),
    ...(raw.expand === undefined ? {} : { expand: raw.expand }),
    ...(raw.pagination === undefined ? {} : { pagination: raw.pagination }),
    ...(raw.includeDeleted === undefined ? {} : { includeDeleted: raw.includeDeleted }),
    ...(raw.fallback === undefined
      ? {}
      : {
          fallback: callbackValue<QueryContext, JsonValue | undefined>(
            raw.fallback,
            CelPhase.Query,
            boundary,
            cel,
            decodeOptionalJsonValue,
          ),
        }),
  };
}

function compileBoundary(
  raw: BoundaryConfig,
  cel: CelEvaluator,
  helpers: readonly RuntimeHelperDefinition[] = [],
): RuntimeBoundary {
  const boundary = raw.boundary;
  return {
    boundary,
    contractPath: raw.contractPath,
    schema: raw.schema,
    fallbackOverride: raw.fallbackOverride,
    identity:
      raw.identity === undefined
        ? undefined
        : {
            ...(raw.identity.key === undefined
              ? {}
              : { key: { ...raw.identity.key, from: raw.identity.key.from ?? 'path' } }),
            ...(raw.identity.creation?.generate
              ? {
                  generate: callbackValue<IdentityContext, string>(
                    raw.identity.creation.generate,
                    CelPhase.Identity,
                    boundary,
                    cel,
                    stringifyIdentity,
                  ),
                }
              : {}),
          },
    queryMapping:
      raw.queryMapping === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(raw.queryMapping).map(([key, expression]) => [
              key,
              predicate<QueryContext>(expression, CelPhase.Query, boundary, cel),
            ]),
          ),
    query: raw.query === undefined ? undefined : compileQuery(raw.query, boundary, cel),
    eventCatalog: raw.eventCatalog.map((entry) => compileEvent(entry, boundary, cel)),
    behaviors: raw.behaviors.map((behavior) => compileBehavior(behavior, boundary, cel)),
    reducers: raw.reducers.map((reducer) => compileReducer(reducer, boundary, cel)),
    initialization: raw.initialization,
    deprecated: raw.deprecated,
    mask: raw.mask,
    latency:
      raw.latency === undefined
        ? undefined
        : { minMs: raw.latency.min_ms, maxMs: raw.latency.max_ms, fixedMs: raw.latency.fixed_ms },
    auditFields: raw.auditFields,
    state: compileState(raw.state, boundary, cel),
    strictSchema: raw.strictSchema,
    faults: raw.faults?.map((fault) => compileFault(fault, boundary, cel)),
    reactions: raw.reactions?.map((reaction) => compileReaction(reaction, boundary, cel)),
    export: raw.export,
    response:
      raw.response === undefined &&
      raw.hateoas === undefined &&
      raw.mask === undefined &&
      raw.deprecated === undefined
        ? undefined
        : {
            ...(raw.response === undefined
              ? {}
              : { transform: responseHelper(raw.response, helpers, boundary) }),
            hateoas: raw.hateoas?.map((link) => ({
              rel: link.rel,
              href: value<ResponseContext, string>(
                link.href,
                CelPhase.Response,
                boundary,
                cel,
                decodeString,
                true,
              ),
            })),
            mask: raw.mask,
            deprecated: raw.deprecated,
          },
  };
}

function compilePolicies(
  dsl: YamlLinkedProgram,
  cel: CelEvaluator,
  helpers: RuntimeDependencies['helpers'],
  clock: RuntimeDependencies['clock'],
): RuntimePolicies {
  const globalFaults = dsl.faults?.map((fault) => compileFault(fault, GLOBAL_BOUNDARY, cel));
  const coverage = compileCoverage(dsl.coverage);
  return {
    ...(dsl.controlHeaders === undefined ? {} : { controlDefaults: dsl.controlHeaders }),
    // Keep a default bearer actor resolver even when the YAML omits an
    // explicit auth block. The contract fixtures use the documented
    // `Bearer actor:scope` form without declaring a policy, and authorization
    // still needs to distinguish an unauthenticated caller from a caller who
    // lacks the required scope.
    auth: {
      ...(dsl.auth?.mode === undefined ? {} : { mode: dsl.auth.mode }),
      authenticate: (request) => {
        const actor = resolveActor(
          request.headers.authorization ?? request.headers.Authorization,
          dsl.auth,
        );
        // JWT mode is a complete authentication policy: an absent bearer
        // credential is invalid even when the matched behaviour does not
        // declare a scope. Keeping this at the YAML policy boundary means the
        // direct engine and the Specmatic forward path have identical
        // authentication semantics.
        if (actor === null && dsl.auth?.mode === 'jwt') {
          throw new JwtValidationError(
            'Authorization header is required in JWT mode',
            'JWT_MISSING',
          );
        }
        return actor ?? undefined;
      },
      ...(dsl.auth?.jwt === undefined ? {} : { jwt: dsl.auth.jwt }),
      ...(dsl.auth?.session === undefined ? {} : { session: dsl.auth.session }),
    },
    idempotency: dsl.idempotency,
    securityHeaders:
      dsl.securityHeaders === undefined
        ? undefined
        : {
            enabled: dsl.securityHeaders.enabled,
            hsts: dsl.securityHeaders.hsts,
            includeSubDomains: dsl.securityHeaders.hsts,
            nosniff: dsl.securityHeaders.nosniff,
            frameDeny: dsl.securityHeaders.frame_deny,
            referrerPolicy: dsl.securityHeaders.referrer_policy,
            customHeaders: dsl.securityHeaders.custom_headers,
          },
    hateoas: dsl.hateoas,
    versioning: dsl.versioning,
    fallback: dsl.fallback,
    ...(coverage === undefined ? {} : { coverage }),
    sagas: dsl.sagas?.map((saga) => compileSaga(saga, GLOBAL_BOUNDARY, cel)),
    derivedProjections: dsl.derivedProjections?.map(
      (projection): RuntimeDerivedProjection => ({
        name: projection.name,
        key: value<ProjectionContext, string>(
          projection.key,
          CelPhase.Projection,
          GLOBAL_BOUNDARY,
          cel,
          decodeString,
        ),
        subscribe: projection.subscribe,
        reduce: projection.reduce.map((reducer) => {
          const patches = reducer.patches;
          return {
            on: reducer.on,
            ...(patches === undefined
              ? {}
              : {
                  apply: (context: Readonly<RuntimeReducerContext>) =>
                    patches.map((patch) => compilePatch(patch, GLOBAL_BOUNDARY, cel, context)),
                }),
          };
        }),
      }),
    ),
    faults: globalFaults,
    reactions: dsl.reactions?.map((reaction) =>
      compileReaction(reaction, reaction.boundary ?? GLOBAL_BOUNDARY, cel),
    ),
    webhooks: dsl.webhooks?.map((webhook) => compileWebhook(webhook, GLOBAL_BOUNDARY, cel)),
    lifecycle: compileLifecycle(dsl.lifecycle, helpers, clock),
  };
}

function compileCoverage(coverage: YamlLinkedProgram['coverage']): RuntimePolicies['coverage'] {
  if (coverage === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(coverage).map(([aggregate, policy]) => [
      aggregate,
      {
        ...(policy.strict === undefined ? {} : { strict: policy.strict }),
        ...(policy.initial_states === undefined ? {} : { initialStates: policy.initial_states }),
        ...(policy.terminal_states === undefined ? {} : { terminalStates: policy.terminal_states }),
        ...(policy.operations === undefined ? {} : { operations: policy.operations }),
        ...(policy.suppress_states === undefined ? {} : { suppressStates: policy.suppress_states }),
      },
    ]),
  );
}

/** Convert the fully linked YAML projection into the pure core runtime program. */
export function compileYamlModel(
  dsl: YamlLinkedProgram,
  options: ParserRuntimeOptions,
): RuntimeModel {
  return compileRuntime(compileYamlDefinitionModel(dsl, options), options.dependencies);
}

/** Lower the linked YAML graph without validating references against another source. */
export function compileYamlDefinitionModel(
  dsl: YamlLinkedProgram,
  options: ParserRuntimeOptions,
): RuntimeDefinition {
  const custom = new Map(
    (options.helpers ?? []).map((helper) => [
      helper.name,
      (args: readonly unknown[], _context: Readonly<Record<string, unknown>>, phase: CelPhase) =>
        helper.invoke(jsonArguments(args), phase),
    ]),
  );
  const cel =
    options.cel ??
    createCelEvaluator({
      externalClockOffset: options.dependencies.clock.offsetMs,
      uuid: options.dependencies.helpers.uuid,
      random: options.dependencies.helpers.random,
      now: options.dependencies.helpers.now,
      custom,
      logger: options.logger,
    });
  const definition: RuntimeDefinition = {
    boundaries: dsl.boundaries.map((boundary) => compileBoundary(boundary, cel, options.helpers)),
    policies: compilePolicies(dsl, cel, options.dependencies.helpers, options.dependencies.clock),
    helpers: options.helpers,
  };
  return definition;
}
