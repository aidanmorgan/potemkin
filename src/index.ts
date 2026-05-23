// ── Core types ────────────────────────────────────────────────────────────────
export type {
  JsonScalar,
  JsonArray,
  JsonObject,
  JsonValue,
  Intent,
  Origin,
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
  SecondaryCommandSpec,
  ReducerRule,
  IdentityConfig,
  BoundaryConfig,
  CompiledDsl,
} from './dsl/types.js';
export { validateBoundaryConfig } from './dsl/schema.js';
export { parseDslYaml, compileDsl } from './dsl/parser.js';

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
export { registerAdminRoutes } from './http/adminRoutes.js';
