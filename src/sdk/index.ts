/**
 * Canonical developer SDK for TypeScript Potemkin configurations.
 *
 * The loader injects this exact object for `potemkin/sdk` imports. Keeping the
 * object here makes the developer import surface and the engine execution
 * surface identical: there is no second registry or path-based reducer API.
 */

import * as authoring from "../authoring/public.js";
import * as composition from "../authoring/composition.js";
import { createPotemkinConfigure, PotemkinConfigure } from "../authoring/factory.js";
import { TypeScriptAuthoringError } from "../authoring/errors.js";
import { ConfigurationError, isConfigurationError } from "../errors.js";
import type { TypeScriptDiagnosticCode, TypeScriptSourceLocation } from "../authoring/errors.js";
import type { TypeScriptHelper, TypeScriptHelperDefinition } from "../authoring/helpers.js";
import type { DeepReadonly, JsonObject, JsonValue } from "../types.js";
import type {
  EventContext,
  IdentityContext,
  MatchContext,
  RuntimeReducerContext,
} from "../model/runtime.js";
import type {
  FactoryRegistrar,
  FactoryContext,
  FactoryOutput,
  RegisteredFactory,
  TypeScriptFactory,
} from "../authoring/factory.js";
import * as resources from "../authoring/resourceModel.js";
import * as references from "../authoring/references.js";
import type {
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
  FaultName,
  SagaName,
  SagaStepName,
  FactoryName,
  HelperName,
  HttpMethod,
  LinkRelation,
  OperationId,
  ResourceName,
  ScopeName,
  SchemaReference,
} from "../authoring/references.js";
import type {
  ComponentDefinition,
  ComponentInclude,
  ComponentSource,
  UseDefinition,
} from "../authoring/composition.js";
import type {
  ResourceDefinition,
  ResourceOperation,
  ResourceValue,
} from "../authoring/resourceModel.js";
import type {
  AuthoringPredicate,
  AuthoringValue,
  BehaviorBuilder,
  BehaviorDefinition,
  BoundaryBuilder,
  BoundaryDefinition,
  EventBuilder,
  EventDefinition,
  FaultDefinition,
  GlobalDefinition,
  GuardDefinition,
  IdentityDefinition,
  ProjectionDefinition,
  QueryExpression,
  ReactionDefinition,
  ReducerExpression,
  ResponseDefinition,
  ResponseLinkDefinition,
  SagaCompensationDefinition,
  SagaDefinition,
  SagaStepDefinition,
  SecondaryCommandDefinition,
  SimulationBuilder,
  SimulationDefinition,
  TypedEventContext,
  TypedEventDefinition,
  TypedMatchContext,
  TypedReducerContext,
  WebhookDefinition,
} from "../authoring/runtimeModel.js";

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
  compileProgram,
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
} = authoring;

const { defineComponent, include, use } = composition;

const { defineResource } = resources;

const {
  boundaryName,
  behaviorName,
  componentName,
  contractPath,
  eventReference,
  eventType,
  faultName,
  sagaName,
  sagaStepName,
  field,
  fieldPath,
  factoryName,
  helperName,
  linkRelation,
  operationId,
  pathParameter,
  pathSegment,
  resourceName,
  schemaReference,
  scopeName,
  TypeScriptReferenceError,
} = references;

/** The exact runtime object imported by TypeScript configuration modules. */
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
  compileProgram,
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
  defineResource,
  boundaryName,
  behaviorName,
  componentName,
  contractPath,
  eventReference,
  eventType,
  faultName,
  sagaName,
  sagaStepName,
  field,
  fieldPath,
  factoryName,
  helperName,
  linkRelation,
  operationId,
  pathParameter,
  pathSegment,
  resourceName,
  scopeName,
  schemaReference,
  TypeScriptReferenceError,
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
  ComponentInclude,
  ComponentSource,
  UseDefinition,
  ResourceDefinition,
  ResourceOperation,
  ResourceValue,
  AuthoringPredicate,
  AuthoringValue,
  BehaviorBuilder,
  BehaviorDefinition,
  BoundaryBuilder,
  BoundaryDefinition,
  EventBuilder,
  EventDefinition,
  FaultDefinition,
  GlobalDefinition,
  GuardDefinition,
  IdentityDefinition,
  ProjectionDefinition,
  QueryExpression,
  ReactionDefinition,
  ReducerExpression,
  ResponseDefinition,
  ResponseLinkDefinition,
  SagaCompensationDefinition,
  SagaDefinition,
  SagaStepDefinition,
  SecondaryCommandDefinition,
  SimulationBuilder,
  SimulationDefinition,
  TypedEventContext,
  TypedEventDefinition,
  TypedMatchContext,
  TypedReducerContext,
  WebhookDefinition,
  TypeScriptHelper,
  TypeScriptHelperDefinition,
  TypeScriptDiagnosticCode,
  TypeScriptSourceLocation,
  JsonObject,
  JsonValue,
  DeepReadonly,
  EventContext,
  IdentityContext,
  MatchContext,
  RuntimeReducerContext,
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
  FaultName,
  SagaName,
  SagaStepName,
  FactoryName,
  HelperName,
  HttpMethod,
  LinkRelation,
  OperationId,
  ResourceName,
  ScopeName,
  SchemaReference,
};

export { TypeScriptAuthoringError, TypeScriptReferenceError };

/** Only this package subpath is a valid developer SDK import. */
export const TYPESCRIPT_SDK_MODULE = "potemkin/sdk" as const;

export function isTypeScriptSdkSpecifier(specifier: string): boolean {
  return specifier === TYPESCRIPT_SDK_MODULE;
}
