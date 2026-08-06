/**
 * Canonical developer SDK for TypeScript Potemkin configurations.
 *
 * The loader injects this exact object for `potemkin/sdk` imports. This module
 * contains authoring tools only; compilation into the private runtime model
 * belongs to the host/parser boundary.
 */

import * as authoring from '../authoring/public.js';
import { defineComponent, include, use } from '../authoring/composition.js';
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
import { defineResource } from '../authoring/resourceModel.js';
import * as references from '../domain/references.js';
import {
  BoundaryName,
  EventType,
  HttpMethod,
  OperationId,
  SchemaReference,
} from '../domain/references.js';
import type {
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
  LinkRelation,
  ProjectionName,
  ReactionName,
  ResourceName,
  ScopeName,
} from '../domain/references.js';
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

type StringRegistryKeys<Registry> = Extract<keyof Registry, string>;
type RegistryName<Registry> = [StringRegistryKeys<Registry>] extends [never]
  ? string
  : StringRegistryKeys<Registry>;
type RegistryValue<Registry, Name extends string, Empty = never> = [
  StringRegistryKeys<Registry>,
] extends [never]
  ? Empty
  : Name extends StringRegistryKeys<Registry>
    ? Registry[Name]
    : never;
type AcceptedRegistryName<Registry, Name extends string> = [StringRegistryKeys<Registry>] extends [
  never,
]
  ? Name
  : Name extends StringRegistryKeys<Registry>
    ? Name
    : never;

export type ScenarioEventName = RegistryName<ScenarioEventRegistry>;
export type ScenarioEventPayload<Name extends ScenarioEventName> = RegistryValue<
  ScenarioEventRegistry,
  Name,
  Record<string, unknown>
>;
export type ScenarioPath = RegistryName<ScenarioPathRegistry>;
export type ScenarioSchemaName = RegistryName<ScenarioSchemaRegistry>;
export type ScenarioSchema<Name extends ScenarioSchemaName> = RegistryValue<
  ScenarioSchemaRegistry,
  Name
>;
export type ScenarioOperationName = RegistryName<ScenarioOperationRegistry>;
export type ScenarioOperation<Name extends ScenarioOperationName> = RegistryValue<
  ScenarioOperationRegistry,
  Name
>;
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

type AcceptedScenarioEventName<Name extends string> = AcceptedRegistryName<
  ScenarioEventRegistry,
  Name
>;
type AcceptedScenarioOperationName<Name extends string> = AcceptedRegistryName<
  ScenarioOperationRegistry,
  Name
>;
type AcceptedScenarioSchemaName<Name extends string> = AcceptedRegistryName<
  ScenarioSchemaRegistry,
  Name
>;

function typedEventType<const Name extends string>(
  value: Name & AcceptedScenarioEventName<Name>,
): EventType<Name> {
  return references.eventType(value);
}

function typedOperationId<const Name extends string>(
  value: Name & AcceptedScenarioOperationName<Name>,
): OperationId<Name> {
  return references.operationId(value);
}

function typedSchemaReference<const Name extends string>(
  value: Name & AcceptedScenarioSchemaName<Name>,
): SchemaReference<Name> {
  return references.schemaReference(value);
}

/** Named developer exports mirror the injected SDK object for IDE/type-checking. */
export const {
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
  yamlComponent,
  ReferenceValidationError,
} = authoring;

export {
  defineComponent,
  include,
  use,
  defineResource,
  BoundaryName,
  boundaryName,
  behaviorName,
  componentName,
  contractPath,
  eventReference,
  EventType,
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
  OperationId,
  projectionName,
  reactionName,
  pathParameter,
  pathSegment,
  resourceName,
  typedSchemaReference as schemaReference,
  SchemaReference,
  HttpMethod,
  scopeName,
  PotemkinConfigure,
  ConfigurationError,
  isConfigurationError,
};

/** The exact authoring object imported by TypeScript configuration modules. */
export const sdk = Object.freeze({
  ...authoring,
  // The SDK facade adds generated-registry typing to these reference helpers.
  eventType: typedEventType,
  operationId: typedOperationId,
  schemaReference: typedSchemaReference,
  // These authoring extensions are not part of authoring/public.ts.
  defineComponent,
  include,
  use,
  defineResource,
  componentName,
  factoryName,
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
  LinkRelation,
  ProjectionName,
  ReactionName,
  ResourceName,
  ScopeName,
};

export { TypeScriptAuthoringError };

/** Only this package subpath is a valid developer SDK import. */
export const TYPESCRIPT_SDK_MODULE = 'potemkin/sdk';

export function isTypeScriptSdkSpecifier(specifier: string): boolean {
  return specifier === TYPESCRIPT_SDK_MODULE;
}
