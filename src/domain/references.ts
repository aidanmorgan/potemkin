/**
 * Source-neutral semantic references used across authoring and runtime seams.
 *
 * Raw strings are accepted only at parser/transport boundaries. Domain and
 * authoring code receives branded values constructed by the validators below.
 */

declare const referenceBrand: unique symbol;

export type PotemkinReference<Kind extends string> = string & {
  readonly [referenceBrand]: Kind;
};

export type BoundaryName = PotemkinReference<'boundary-name'>;
export type BehaviorName = PotemkinReference<'behavior-name'>;
export type FaultName = PotemkinReference<'fault-name'>;
export type GuardName = PotemkinReference<'guard-name'>;
export type ReactionName = PotemkinReference<'reaction-name'>;
export type SagaName = PotemkinReference<'saga-name'>;
export type SagaStepName = PotemkinReference<'saga-step-name'>;
export type WebhookName = PotemkinReference<'webhook-name'>;
export type ProjectionName = PotemkinReference<'projection-name'>;
export type ResourceName = PotemkinReference<'resource-name'>;
export type ComponentName = PotemkinReference<'component-name'>;
export type HelperName = PotemkinReference<'helper-name'>;
export type FactoryName = PotemkinReference<'factory-name'>;
export type ScopeName = PotemkinReference<'scope-name'>;
export type LinkRelation = PotemkinReference<'link-relation'>;
export type OperationId = PotemkinReference<'operation-id'>;
export type EventType<Name extends string = string> = PotemkinReference<'event-type'> & Name;
export type AggregateId = PotemkinReference<'aggregate-id'>;
export type EventId = PotemkinReference<'event-id'>;
export type JsonPath = PotemkinReference<'json-path'>;
export type SequenceVersion = number & { readonly [referenceBrand]: 'sequence-version' };

/** Augmented by generated scenario bindings when a project has known events. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- generated declarations merge into this registry.
export interface ScenarioEventRegistry {}

type AcceptedScenarioEventName<Name extends string> = [keyof ScenarioEventRegistry] extends [never]
  ? Name
  : Name extends keyof ScenarioEventRegistry
    ? Name
    : never;

export type EventReference<
  Boundary extends string = string,
  Name extends string = string,
> = PotemkinReference<'event-reference'> & `${Boundary}:${Name}`;

export type EventSelector<Boundary extends string = string, Name extends string = string> =
  | EventType<Name>
  | EventReference<Boundary, Name>;

export type ContractPath = PotemkinReference<'contract-path'>;
export type SchemaReference = PotemkinReference<'schema-reference'>;
export type FieldPath = PotemkinReference<'field-path'>;
export type QueryPath = PotemkinReference<'query-path'>;
export type StateFieldName = PotemkinReference<'state-field-name'>;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'TRACE';

export interface ContractPathSegment {
  readonly kind: 'literal' | 'parameter';
  readonly value: string;
}

export interface FieldPathSegment {
  readonly value: string;
}

export class ReferenceValidationError extends Error {
  readonly code = 'DOMAIN_REFERENCE_INVALID' as const;
  readonly kind: string;

  constructor(kind: string, reason: string) {
    super(`Invalid Potemkin ${kind}: ${reason}`);
    this.name = 'ReferenceValidationError';
    this.kind = kind;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function reference<Kind extends string>(kind: Kind, value: string): PotemkinReference<Kind> {
  const normalized = value.trim();
  if (normalized === '') throw new ReferenceValidationError(kind, 'must not be empty');
  return normalized as PotemkinReference<Kind>;
}

export function boundaryName(value: string): BoundaryName {
  return reference('boundary-name', value);
}
export function behaviorName(value: string): BehaviorName {
  return reference('behavior-name', value);
}
export function faultName(value: string): FaultName {
  return reference('fault-name', value);
}
export function guardName(value: string): GuardName {
  return reference('guard-name', value);
}
export function reactionName(value: string): ReactionName {
  return reference('reaction-name', value);
}
export function sagaName(value: string): SagaName {
  return reference('saga-name', value);
}
export function sagaStepName(value: string): SagaStepName {
  return reference('saga-step-name', value);
}
export function webhookName(value: string): WebhookName {
  return reference('webhook-name', value);
}
export function projectionName(value: string): ProjectionName {
  return reference('projection-name', value);
}
export function resourceName(value: string): ResourceName {
  return reference('resource-name', value);
}
export function componentName(value: string): ComponentName {
  return reference('component-name', value);
}
export function helperName(value: string): HelperName {
  const result = reference('helper-name', value);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(result)) {
    throw new ReferenceValidationError('helper-name', 'must be a CEL identifier');
  }
  return result;
}
export function factoryName(value: string): FactoryName {
  return reference('factory-name', value);
}
export function scopeName(value: string): ScopeName {
  return reference('scope-name', value);
}
export function linkRelation(value: string): LinkRelation {
  return reference('link-relation', value);
}
export function operationId(value: string): OperationId {
  return reference('operation-id', value);
}
export function aggregateId(value: string): AggregateId {
  return reference('aggregate-id', value);
}
export function eventId(value: string): EventId {
  return reference('event-id', value);
}
export function sequenceVersion(value: number): SequenceVersion {
  if (!Number.isInteger(value) || value < 0) {
    throw new ReferenceValidationError('sequence-version', 'must be a non-negative integer');
  }
  return value as SequenceVersion;
}
export function committedSequenceVersion(value: number): SequenceVersion {
  if (!Number.isInteger(value) || value < 1) {
    throw new ReferenceValidationError('committed-sequence-version', 'must be a positive integer');
  }
  return value as SequenceVersion;
}
export function jsonPath(value: string): JsonPath {
  const normalized = value.trim();
  if (normalized !== '' && !normalized.startsWith('/')) {
    throw new ReferenceValidationError('json-path', 'must be an RFC 6901 pointer');
  }
  return normalized as JsonPath;
}
export function eventType<const Name extends string>(
  value: Name & AcceptedScenarioEventName<Name>,
): EventType<Name> {
  return reference('event-type', value) as EventType<Name>;
}
export function eventReference<const Boundary extends string, const Name extends string>(
  boundary: BoundaryName & Boundary,
  event: EventType<Name>,
): EventReference<Boundary, Name> {
  return reference('event-reference', `${boundary}:${event}`) as EventReference<Boundary, Name>;
}
export function schemaReference(value: string): SchemaReference {
  return reference('schema-reference', value);
}
export function pathSegment(value: string): ContractPathSegment {
  const normalized = value.trim();
  if (normalized === '' || normalized.includes('/') || /[{}]/.test(normalized)) {
    throw new ReferenceValidationError('contract-path segment', 'must be a non-empty token');
  }
  return Object.freeze({ kind: 'literal' as const, value: normalized });
}
export function pathParameter(value: string): ContractPathSegment {
  const normalized = value.trim();
  if (normalized === '' || normalized.includes('/') || /[{}]/.test(normalized)) {
    throw new ReferenceValidationError('contract-path parameter', 'must be a non-empty name');
  }
  return Object.freeze({ kind: 'parameter' as const, value: normalized });
}
export function contractPath(...segments: readonly ContractPathSegment[]): ContractPath {
  if (segments.length === 0) return reference('contract-path', '/') as ContractPath;
  const value = `/${segments
    .map((segment) => (segment.kind === 'parameter' ? `{${segment.value}}` : segment.value))
    .join('/')}`;
  return reference('contract-path', value) as ContractPath;
}
export function parseContractPath(value: string): ContractPath {
  const normalized = value.trim();
  if (!normalized.startsWith('/') || normalized.includes('//')) {
    throw new ReferenceValidationError('contract-path', 'must be an absolute non-empty path');
  }
  return reference('contract-path', normalized);
}
export function field(value: string): FieldPathSegment {
  const normalized = value.trim();
  if (normalized === '' || normalized.includes('/')) {
    throw new ReferenceValidationError('field path segment', 'must be a non-empty token');
  }
  return Object.freeze({ value: normalized });
}
export function stateFieldName(value: string): StateFieldName {
  return reference('state-field-name', value);
}
export function fieldPath(...segments: readonly FieldPathSegment[]): FieldPath {
  if (segments.length === 0) throw new ReferenceValidationError('field path', 'needs a segment');
  const pointer = segments
    .map((segment) => segment.value.replaceAll('~', '~0').replaceAll('/', '~1'))
    .join('/');
  const value = segments.length === 1 ? pointer : `/${pointer}`;
  return reference('field-path', value) as FieldPath;
}
export function queryPath(...segments: readonly FieldPathSegment[]): QueryPath {
  if (segments.length === 0) throw new ReferenceValidationError('query path', 'needs a segment');
  return reference('query-path', segments.map((segment) => segment.value).join('.')) as QueryPath;
}
