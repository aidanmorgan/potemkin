// ── Core types ────────────────────────────────────────────────────────────────
export type {
  JsonScalar,
  JsonArray,
  JsonObject,
  JsonValue,
  Intent,
  Origin,
  Actor,
  Command,
  DomainEvent,
  ExecutionResult,
} from './types.js';

// ── Errors ────────────────────────────────────────────────────────────────────
export {
  SimError,
  BootError,
  ContractViolationError,
  EntityAbsenceError,
  EntityConflictError,
  UnhandledOperationError,
  ConcurrencyConflictError,
  MissingPreconditionError,
  InternalExecutionError,
  InfiniteLoopError,
  FaultSimulatedError,
  AuthenticationRequiredError,
  AuthorizationDeniedError,
  IdempotencyConflictError,
} from './errors.js';

// ── IDs ───────────────────────────────────────────────────────────────────────
export { nextUuidv7, epochAnchoredUuidv7, isUuidv7 } from './ids/uuidv7.js';

// ── CEL ───────────────────────────────────────────────────────────────────────
export { CelPhase } from './cel/phases.js';
export type { BuiltinContext } from './cel/builtins.js';
export { BUILTINS, callBuiltin } from './cel/builtins.js';
export type { CompiledCel, CelContext, CelEvaluator } from './cel/evaluator.js';
export { createCelEvaluator } from './cel/evaluator.js';

// ── DSL ───────────────────────────────────────────────────────────────────────
export type {
  EventCatalogEntry,
  BehaviorRule,
  RequiresGuard,
  EmitWhenEntry,
  SecondaryCommandSpec,
  ReducerRule,
  IdentityConfig,
  ScriptDeclaration,
  BoundaryConfig,
  CompiledDsl,
  SagaConfig,
  SagaStep,
  SagaTrigger,
  SagaCompensation,
  IdempotencyConfig,
  DerivedProjectionConfig,
  DerivedProjectionReduceEntry,
} from './dsl/types.js';
export { validateBoundaryConfig, validateGlobalConfig } from './dsl/schema.js';
export type { GlobalConfig } from './dsl/schema.js';
export { parseDslYaml, compileDsl } from './dsl/parser.js';

// ── Scripts (inline TypeScript escape hatch) ───────────────────────────────────
export type {
  ScriptContext,
  ScriptHelpers,
  ScriptHandle,
  ScriptRegistry,
} from './scripts/types.js';
export { buildScriptRegistry } from './scripts/registry.js';

// ── Contract ──────────────────────────────────────────────────────────────────
export type {
  OpenApiParameter,
  OpenApiOperation,
  OpenApiPathItem,
  OpenApiDoc,
} from './contract/loader.js';
export { loadOpenApi } from './contract/loader.js';
export type { ContractValidator } from './contract/validator.js';
export { createContractValidator } from './contract/validator.js';
export type { MatchedRoute } from './contract/router.js';
export { matchRoute } from './contract/router.js';

// ── Event Store ───────────────────────────────────────────────────────────────
export type { EventStore } from './eventstore/store.js';
export { createEventStore } from './eventstore/store.js';

// ── State Graph ───────────────────────────────────────────────────────────────
export type { StateGraph } from './stategraph/graph.js';
export { createStateGraph, deepClone, deepMerge } from './stategraph/graph.js';
export type { ShadowGraph } from './stategraph/shadow.js';
export { createShadowGraph } from './stategraph/shadow.js';

// ── Engine ────────────────────────────────────────────────────────────────────
export type { IntentTranslationInput } from './engine/router.js';
export { translateIntent } from './engine/router.js';
export type {
  PatternMatchInput,
  PatternMatchOutcome,
} from './engine/patternMatcher.js';
export { runPatternMatch } from './engine/patternMatcher.js';
export type { ProjectionInput } from './engine/projection.js';
export { projectEvent } from './engine/projection.js';
export type { UowInput } from './engine/uow.js';
export { executeUnitOfWork } from './engine/uow.js';
export type { BootInput, BootedSystem } from './engine/boot.js';
export { bootSystem } from './engine/boot.js';
export { resetSystem } from './engine/reset.js';
export type { QueryRequest } from './engine/query.js';
export { runQuery } from './engine/query.js';
export type { FaultSignal } from './engine/faultSim.js';
export { extractFaultSignal } from './engine/faultSim.js';

// ── HTTP ──────────────────────────────────────────────────────────────────────
export type { ExpressApp } from './http/gateway.js';
export { createGateway } from './http/gateway.js';

// ── Forwarding (/_engine/*) ───────────────────────────────────────────────────
export type { ForwardedRequest, ForwardedResponse, RoutesDiscoveryResponse } from './forwarding/index.js';
export { createForwardingHandler, healthHandler, createRoutesHandler } from './forwarding/index.js';
export { registerAdminRoutes } from './http/adminRoutes.js';

// ── Schema ────────────────────────────────────────────────────────────────────
export type {
  SchemaTypeKind,
  ObjectGraphSchema,
  BoundarySchemas,
  ObjectGraphSchemaRegistry,
} from './schema/types.js';
export { deriveSchemasFromOpenApi } from './schema/fromOpenApi.js';
export { resolvePath, isValidPath, pathExists } from './schema/pathResolver.js';
export { typeOfJson, isAssignable, validateEntityAgainstSchema } from './schema/typeCheck.js';
export { staticCheckDsl } from './schema/dslStaticChecker.js';
export type { DslCheckError } from './schema/dslStaticChecker.js';
export { guardAssignPath, guardAssignedValue } from './schema/runtimeGuard.js';

// ── Identity (REQ-84) ─────────────────────────────────────────────────────────
export { extractActor } from './identity/actorExtractor.js';
export { checkScopes } from './identity/scopeChecker.js';

// ── Idempotency (REQ-81) ──────────────────────────────────────────────────────
export type { IdempotencyStore, IdempotencyEntry, CachedResponse } from './idempotency/store.js';
export { createIdempotencyStore, getIdempotencyStore, resetIdempotencyStore } from './idempotency/store.js';

// ── Sagas (REQ-73) ────────────────────────────────────────────────────────────
export { runSaga, findTriggeredSagas } from './sagas/orchestrator.js';

// ── Derived Projections (REQ-88) ──────────────────────────────────────────────
export type { DerivedStateMap, DerivedProjectionRegistry } from './projections/types.js';
export {
  createDerivedProjectionRegistry,
  applyEventToDerivedProjections,
  getDerivedProjection,
} from './projections/engine.js';
