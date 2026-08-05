/**
 * Canonical developer SDK for TypeScript Potemkin configurations.
 *
 * The loader injects this exact object for `potemkin/sdk` imports. This module
 * contains authoring tools only; compilation into the private runtime model
 * belongs to the host/parser boundary.
 */

import * as authoring from '../authoring/public.js';
import * as composition from '../authoring/composition.js';
import { createPotemkinConfigure, PotemkinConfigure } from '../authoring/factory.js';
import { TypeScriptAuthoringError } from '../authoring/errors.js';
import { ConfigurationError, isConfigurationError } from '../errors.js';
import type { TypeScriptDiagnosticCode, TypeScriptSourceLocation } from '../authoring/errors.js';
import type {
  TypeScriptHelper,
  TypeScriptHelperDefinition,
  TypeScriptHelperOptions,
  TypeScriptHelperPhase,
} from '../authoring/public.js';
import type { DataFormat, DataGenerator } from '../contracts/data.js';
import type { JwtValidationConfig } from '../contracts/identity.js';
import type { DeepReadonly, JsonObject, JsonValue } from '../contracts/value.js';
import type {
  FactoryRegistrar,
  FactoryContext,
  FactoryOutput,
  RegisteredFactory,
  TypeScriptFactory,
} from '../authoring/factory.js';
import * as resources from '../authoring/resourceModel.js';
import * as references from '../domain/references.js';
import type {
  BoundaryName,
  BehaviorName,
  ComponentName,
  ContractPath,
  ContractPathSegment,
  EventReference,
  EventSelector,
  FieldPath,
  FieldPathSegment,
  QueryPath,
  StateFieldName,
  FaultName,
  GuardName,
  SagaName,
  SagaStepName,
  WebhookName,
  FactoryName,
  HelperName,
  HttpMethod,
  LinkRelation,
  ProjectionName,
  ReactionName,
  ResourceName,
  ScopeName,
  SchemaReference,
} from '../domain/references.js';
import type { EventType, OperationId } from '../domain/references.js';
import type {
  ComponentDefinition,
  ComponentReference,
  ComponentInclude,
  ComponentParameterDefinition,
  ComponentParameterType,
  ComponentSource,
  ExportDefinition,
  UseDefinition,
  YamlComponentReference,
} from '../authoring/composition.js';
import type {
  ResourceDefinition,
  ResourceOperation,
  ResourceValue,
} from '../authoring/resourceModel.js';
import type {
  AuthoringPredicate,
  AuthoringValue,
  AuthoringHelpers,
  AuthoringRequest,
  RequestControls,
  BehaviorBuilder,
  BehaviorEmissionDefinition,
  BehaviorDefinition,
  BoundaryBuilder,
  BoundaryDefinition,
  EventBuilder,
  EventDefinition,
  FaultDefinition,
  FaultErrorClass,
  FaultResponseDefinition,
  FaultSelectorDefinition,
  GlobalDefinition,
  GuardDefinition,
  IdentityDefinition,
  IdentityKeyDefinition,
  InitializationDefinition,
  SeedDefinition,
  StateDefinition,
  StateFieldType,
  ComputedFieldDefinition,
  InternalFieldDefinition,
  QueryMappingDefinition,
  DeprecationDefinition,
  LatencyDefinition,
  ProjectionDefinition,
  QueryDefinition,
  QueryExpression,
  QueryValue,
  ReactionDefinition,
  ReducerExpression,
  ReducerDefinition,
  Response,
  ResponseDefinition,
  ResponseLinkDefinition,
  SagaCompensationDefinition,
  SagaDefinition,
  SagaStepDefinition,
  SagaTriggerDefinition,
  SecondaryCommandDefinition,
  SimulationBuilder,
  SimulationDefinition,
  EventContext,
  IdentityContext,
  MatchContext,
  QueryContext,
  ReducerContext,
  PostCommitContext,
  ResponseContext,
  FaultContext,
  WebhookContext,
  SagaContext,
  ProjectionContext,
  TypedEventContext,
  TypedEventDefinition,
  TypedMatchContext,
  TypedReducerContext,
  Expression,
  ExpressionPhase,
  WebhookDefinition,
} from '../authoring/types.js';
import type {
  AuthDefinition,
  ControlDefaultsDefinition,
  CoverageDefinition,
  FallbackDefinition,
  FallbackRuleDefinition,
  HateoasDefinition,
  IdempotencyDefinition,
  LifecycleDefinition,
  SecurityHeadersDefinition,
  VersionDefinition,
  VersioningDefinition,
} from '../authoring/policyModel.js';

const {
  all,
  any,
  not,
  pipe,
  compose,
  mapReadonly,
  concatReadonly,
  query,
  expression,
  event,
  behavior,
  reducerRule,
  defineSimulation,
  defineEvent,
  defineBehavior,
  defineFault,
  defineReaction,
  defineWebhook,
  defineSaga,
  defineProjection,
  defineGlobal,
  defineResponse,
  defineQuery,
  boundary,
  simulation,
  defineHelper,
} = authoring;

const { defineComponent, include, use, yamlComponent } = composition;

const { defineResource } = resources;

const {
  boundaryName,
  behaviorName,
  componentName,
  contractPath,
  eventReference,
  faultName,
  guardName,
  sagaName,
  sagaStepName,
  webhookName,
  field,
  fieldPath,
  queryPath,
  stateFieldName,
  factoryName,
  helperName,
  linkRelation,
  projectionName,
  reactionName,
  pathParameter,
  pathSegment,
  resourceName,
  scopeName,
  ReferenceValidationError,
} = references;

/** Generated declarations augment these registries for project-local typing. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- generated declarations merge into this registry.
export interface ScenarioEventRegistry {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- generated declarations merge into this registry.
export interface ScenarioPathRegistry {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- generated declarations merge into this registry.
export interface ScenarioSchemaRegistry {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- generated declarations merge into this registry.
export interface ScenarioOperationRegistry {}

export type ScenarioEventName = [keyof ScenarioEventRegistry] extends [never]
  ? string
  : keyof ScenarioEventRegistry & string;
export type ScenarioEventPayload<Name extends ScenarioEventName> =
  Name extends keyof ScenarioEventRegistry ? ScenarioEventRegistry[Name] : Record<string, unknown>;
export type ScenarioPath = [keyof ScenarioPathRegistry] extends [never]
  ? string
  : keyof ScenarioPathRegistry & string;
export type ScenarioSchemaName = [keyof ScenarioSchemaRegistry] extends [never]
  ? string
  : keyof ScenarioSchemaRegistry & string;
export type ScenarioSchema<Name extends ScenarioSchemaName> =
  Name extends keyof ScenarioSchemaRegistry ? ScenarioSchemaRegistry[Name] : never;
export type ScenarioOperationName = [keyof ScenarioOperationRegistry] extends [never]
  ? string
  : keyof ScenarioOperationRegistry & string;
export type ScenarioOperation<Name extends ScenarioOperationName> =
  Name extends keyof ScenarioOperationRegistry ? ScenarioOperationRegistry[Name] : never;
export type ScenarioOperationRequest<Name extends ScenarioOperationName> =
  ScenarioOperation<Name> extends {
    request: infer Request;
  }
    ? Request
    : never;
export type ScenarioOperationResponses<Name extends ScenarioOperationName> =
  ScenarioOperation<Name> extends {
    responses: infer Responses;
  }
    ? Responses
    : never;

type AcceptedScenarioEventName<Name extends string> = [keyof ScenarioEventRegistry] extends [never]
  ? Name
  : Name extends keyof ScenarioEventRegistry
    ? Name
    : never;
type AcceptedScenarioOperationName<Name extends string> = [
  keyof ScenarioOperationRegistry,
] extends [never]
  ? Name
  : Name extends keyof ScenarioOperationRegistry
    ? Name
    : never;
type AcceptedScenarioSchemaName<Name extends string> = [keyof ScenarioSchemaRegistry] extends [
  never,
]
  ? Name
  : Name extends keyof ScenarioSchemaRegistry
    ? Name
    : never;

function typedEventType<const Name extends string>(
  value: Name & AcceptedScenarioEventName<Name>,
): EventType<Name> {
  return references.eventType(value);
}

function typedOperationId<const Name extends string>(
  value: Name & AcceptedScenarioOperationName<Name>,
): OperationId & Name {
  return references.operationId(value) as OperationId & Name;
}

function typedSchemaReference<const Name extends string>(
  value: Name & AcceptedScenarioSchemaName<Name>,
): SchemaReference & Name {
  return references.schemaReference(value) as SchemaReference & Name;
}

/** Named developer exports mirror the injected SDK object for IDE/type-checking. */
export {
  all,
  any,
  not,
  pipe,
  compose,
  mapReadonly,
  concatReadonly,
  query,
  expression,
  event,
  behavior,
  reducerRule,
  defineSimulation,
  defineEvent,
  defineBehavior,
  defineFault,
  defineReaction,
  defineWebhook,
  defineSaga,
  defineProjection,
  defineGlobal,
  defineResponse,
  defineQuery,
  boundary,
  simulation,
  defineHelper,
  defineComponent,
  include,
  use,
  yamlComponent,
  defineResource,
  boundaryName,
  behaviorName,
  componentName,
  contractPath,
  eventReference,
  typedEventType as eventType,
  faultName,
  guardName,
  sagaName,
  sagaStepName,
  webhookName,
  field,
  fieldPath,
  queryPath,
  stateFieldName,
  factoryName,
  helperName,
  linkRelation,
  typedOperationId as operationId,
  projectionName,
  reactionName,
  pathParameter,
  pathSegment,
  resourceName,
  typedSchemaReference as schemaReference,
  scopeName,
  PotemkinConfigure,
  ConfigurationError,
  isConfigurationError,
};

/** The exact authoring object imported by TypeScript configuration modules. */
export const sdk = Object.freeze({
  all,
  any,
  not,
  pipe,
  compose,
  mapReadonly,
  concatReadonly,
  query,
  expression,
  event,
  behavior,
  reducerRule,
  defineSimulation,
  defineEvent,
  defineBehavior,
  defineFault,
  defineReaction,
  defineWebhook,
  defineSaga,
  defineProjection,
  defineGlobal,
  boundary,
  simulation,
  defineHelper,
  defineComponent,
  include,
  use,
  yamlComponent,
  defineResource,
  boundaryName,
  behaviorName,
  componentName,
  contractPath,
  eventReference,
  eventType: typedEventType,
  faultName,
  guardName,
  sagaName,
  sagaStepName,
  webhookName,
  field,
  fieldPath,
  queryPath,
  stateFieldName,
  factoryName,
  helperName,
  linkRelation,
  operationId: typedOperationId,
  projectionName,
  reactionName,
  pathParameter,
  pathSegment,
  resourceName,
  scopeName,
  schemaReference: typedSchemaReference,
  ReferenceValidationError,
  PotemkinConfigure,
  TypeScriptAuthoringError,
  ConfigurationError,
  isConfigurationError,
});

export type TypeScriptSdk = typeof sdk;

/**
 * Create the SDK object for one TypeScript load. The loader supplies a
 * per-load factory registrar, so decorator registration cannot leak between
 * watcher reloads or concurrent runtime instances.
 */
export function createTypeScriptSdk(
  registrar: FactoryRegistrar,
  base: TypeScriptSdk = sdk,
): TypeScriptSdk {
  return Object.freeze({
    ...base,
    PotemkinConfigure: createPotemkinConfigure(registrar),
  });
}

export type {
  FactoryContext,
  FactoryRegistrar,
  FactoryOutput,
  RegisteredFactory,
  TypeScriptFactory,
  ComponentDefinition,
  ComponentReference,
  ComponentInclude,
  ComponentParameterDefinition,
  ComponentParameterType,
  ComponentSource,
  ExportDefinition,
  UseDefinition,
  YamlComponentReference,
  ResourceDefinition,
  ResourceOperation,
  ResourceValue,
  AuthoringPredicate,
  AuthoringValue,
  AuthoringHelpers,
  AuthoringRequest,
  RequestControls,
  BehaviorBuilder,
  BehaviorEmissionDefinition,
  BehaviorDefinition,
  BoundaryBuilder,
  BoundaryDefinition,
  EventBuilder,
  EventDefinition,
  FaultDefinition,
  FaultErrorClass,
  FaultResponseDefinition,
  FaultSelectorDefinition,
  GlobalDefinition,
  AuthDefinition,
  JwtValidationConfig,
  ControlDefaultsDefinition,
  CoverageDefinition,
  FallbackDefinition,
  FallbackRuleDefinition,
  HateoasDefinition,
  IdempotencyDefinition,
  LifecycleDefinition,
  SecurityHeadersDefinition,
  VersionDefinition,
  VersioningDefinition,
  GuardDefinition,
  IdentityDefinition,
  IdentityKeyDefinition,
  InitializationDefinition,
  SeedDefinition,
  StateDefinition,
  StateFieldType,
  ComputedFieldDefinition,
  InternalFieldDefinition,
  QueryMappingDefinition,
  DeprecationDefinition,
  LatencyDefinition,
  ProjectionDefinition,
  QueryDefinition,
  QueryExpression,
  QueryValue,
  ReactionDefinition,
  ReducerExpression,
  ReducerDefinition,
  Response,
  ResponseDefinition,
  ResponseLinkDefinition,
  SagaCompensationDefinition,
  SagaDefinition,
  SagaStepDefinition,
  SagaTriggerDefinition,
  SecondaryCommandDefinition,
  SimulationBuilder,
  SimulationDefinition,
  TypedEventContext,
  TypedEventDefinition,
  TypedMatchContext,
  TypedReducerContext,
  Expression,
  ExpressionPhase,
  WebhookDefinition,
  TypeScriptHelper,
  TypeScriptHelperDefinition,
  TypeScriptHelperOptions,
  TypeScriptHelperPhase,
  TypeScriptDiagnosticCode,
  TypeScriptSourceLocation,
  JsonObject,
  JsonValue,
  DeepReadonly,
  DataGenerator,
  DataFormat,
  EventContext,
  IdentityContext,
  MatchContext,
  QueryContext,
  ReducerContext,
  PostCommitContext,
  ResponseContext,
  FaultContext,
  WebhookContext,
  SagaContext,
  ProjectionContext,
};

export type {
  BoundaryName,
  BehaviorName,
  ComponentName,
  ContractPath,
  ContractPathSegment,
  EventReference,
  EventSelector,
  EventType,
  FieldPath,
  FieldPathSegment,
  QueryPath,
  StateFieldName,
  FaultName,
  GuardName,
  SagaName,
  SagaStepName,
  WebhookName,
  FactoryName,
  HelperName,
  HttpMethod,
  LinkRelation,
  OperationId,
  ProjectionName,
  ReactionName,
  ResourceName,
  ScopeName,
  SchemaReference,
};

export { TypeScriptAuthoringError, ReferenceValidationError };

/** Only this package subpath is a valid developer SDK import. */
export const TYPESCRIPT_SDK_MODULE = 'potemkin/sdk' as const;

export function isTypeScriptSdkSpecifier(specifier: string): boolean {
  return specifier === TYPESCRIPT_SDK_MODULE;
}
