/**
 * Potemkin's deliberately small package root.
 *
 * Authoring, runtime embedding, project loading, generation, and transport
 * each have an explicit package surface. Keeping this entry point limited to
 * dependency-free values, diagnostics, and configuration prevents compiler
 * state and infrastructure implementations from becoming accidental public
 * API.
 */

import type { Intent, Origin, Command, DomainEvent, ExecutionResult } from './contracts/domain.js';
import type { Actor } from './contracts/identity.js';
import { aggregateId, commandId, eventId, sequenceVersion } from './domain/references.js';
import type { AggregateId, CommandId, EventId, SequenceVersion } from './domain/references.js';
import type {
  JsonScalar,
  JsonArray,
  JsonObject,
  JsonValue,
  DeepReadonly,
} from './contracts/value.js';

import {
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
  ConfigurationError,
  ExportError,
  SessionLimitError,
  deserializeSimError,
  isConfigurationError,
} from './errors.js';

import {
  definePotemkinConfig,
  definePluginConfig,
  defineWorkflowConfig,
  defineOverlayConfig,
  defineGovernanceConfig,
  defineSeedConfig,
  toEngineConfigurationResponse,
} from './config.js';

import type {
  ScanEntry,
  ScanConfig,
  PluginConfiguration,
  SeedDefinition,
  WorkflowDefinition,
  OverlayDefinition,
  GovernanceDefinition,
  GovernanceReportConfig,
  GovernanceSuccessCriteria,
  PotemkinConfiguration,
  EngineConfigurationResponse,
} from './contracts/config.js';

export type {
  JsonScalar,
  JsonArray,
  JsonObject,
  JsonValue,
  DeepReadonly,
  Intent,
  Origin,
  AggregateId,
  CommandId,
  EventId,
  SequenceVersion,
  Actor,
  Command,
  DomainEvent,
  ExecutionResult,
  ScanEntry,
  ScanConfig,
  PluginConfiguration,
  SeedDefinition,
  WorkflowDefinition,
  OverlayDefinition,
  GovernanceDefinition,
  GovernanceReportConfig,
  GovernanceSuccessCriteria,
  PotemkinConfiguration,
  EngineConfigurationResponse,
};

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
  ConfigurationError,
  ExportError,
  SessionLimitError,
  deserializeSimError,
  isConfigurationError,
  definePotemkinConfig,
  definePluginConfig,
  defineWorkflowConfig,
  defineOverlayConfig,
  defineGovernanceConfig,
  defineSeedConfig,
  toEngineConfigurationResponse,
  aggregateId,
  commandId,
  eventId,
  sequenceVersion,
};
