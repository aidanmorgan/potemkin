/**
 * Source-neutral semantic references used across authoring and runtime seams.
 *
 * Raw strings are accepted only at parser/transport boundaries. Domain and
 * authoring code receives branded values constructed by the validators below.
 */

declare const referenceBrand: unique symbol;

type Brand<Value, Kind extends string> = Value & {
  readonly [referenceBrand]: Kind;
};

export type PotemkinReference<Kind extends string> = Brand<string, Kind>;

type StringReference<Kind extends string, Value extends string> = Brand<Value, Kind>;

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
export type OperationId<Name extends string = string> = StringReference<'operation-id', Name>;
export type EventType<Name extends string = string> = StringReference<'event-type', Name>;
export type AggregateId = PotemkinReference<'aggregate-id'>;
export type EventId = PotemkinReference<'event-id'>;
export type CommandId = PotemkinReference<'command-id'>;
export type FaultId = PotemkinReference<'fault-id'>;
export type JsonPath = PotemkinReference<'json-path'>;
export type SequenceVersion = Brand<number, 'sequence-version'>;

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
> = StringReference<'event-reference', `${Boundary}:${Name}`>;

export type EventSelector<Boundary extends string = string, Name extends string = string> =
  | EventType<Name>
  | EventReference<Boundary, Name>;

export type ContractPath = PotemkinReference<'contract-path'>;
export type SchemaReference<Name extends string = string> = StringReference<
  'schema-reference',
  Name
>;
export type FieldPath = PotemkinReference<'field-path'>;
export type QueryPath = PotemkinReference<'query-path'>;
export type StateFieldName = PotemkinReference<'state-field-name'>;

const HTTP_METHOD_NAMES = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
  Head: 'HEAD',
  Options: 'OPTIONS',
  Trace: 'TRACE',
} as const;

export const httpMethods = [
  HTTP_METHOD_NAMES.Get,
  HTTP_METHOD_NAMES.Post,
  HTTP_METHOD_NAMES.Put,
  HTTP_METHOD_NAMES.Patch,
  HTTP_METHOD_NAMES.Delete,
  HTTP_METHOD_NAMES.Head,
  HTTP_METHOD_NAMES.Options,
  HTTP_METHOD_NAMES.Trace,
] as const;

export type HttpMethod = (typeof HTTP_METHOD_NAMES)[keyof typeof HTTP_METHOD_NAMES];

const HTTP_METHOD_VALUES: ReadonlySet<string> = new Set(httpMethods);

function isHttpMethod(value: string): value is HttpMethod {
  return HTTP_METHOD_VALUES.has(value);
}

export function httpMethod(value: string): HttpMethod {
  const normalized = value.trim().toUpperCase();
  if (!isHttpMethod(normalized)) {
    throw new ReferenceValidationError('http-method', `unsupported method "${value}"`);
  }
  return normalized;
}

export const HttpMethod = freezeCompanion(
  {
    Get: HTTP_METHOD_NAMES.Get,
    Post: HTTP_METHOD_NAMES.Post,
    Put: HTTP_METHOD_NAMES.Put,
    Patch: HTTP_METHOD_NAMES.Patch,
    Delete: HTTP_METHOD_NAMES.Delete,
    Head: HTTP_METHOD_NAMES.Head,
    Options: HTTP_METHOD_NAMES.Options,
    Trace: HTTP_METHOD_NAMES.Trace,
    parse: httpMethod,
  },
  ['parse'],
);

export interface ContractPathSegment {
  readonly kind: 'literal' | 'parameter';
  readonly value: string;
}

export interface FieldPathSegment {
  readonly value: string;
}

export class ReferenceValidationError extends Error {
  readonly code = 'DOMAIN_REFERENCE_INVALID';
  readonly kind: string;

  constructor(kind: string, reason: string) {
    super(`Invalid Potemkin ${kind}: ${reason}`);
    this.name = 'ReferenceValidationError';
    this.kind = kind;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function freezeCompanion<const Value extends object>(
  value: Value,
  nonEnumerableKeys: readonly (keyof Value)[],
): Readonly<Value> {
  for (const key of nonEnumerableKeys) {
    Object.defineProperty(value, key, { enumerable: false });
  }
  return Object.freeze(value);
}

function reference<Kind extends string>(
  kind: Kind,
  value: string,
  options: { readonly allowEmpty?: boolean } = {},
): PotemkinReference<Kind> {
  const normalized = value.trim();
  if (normalized === '' && options.allowEmpty !== true) {
    throw new ReferenceValidationError(kind, 'must not be empty');
  }
  // Runtime validation is the single construction boundary for branded strings.
  return normalized as PotemkinReference<Kind>;
}

function literalReference<Kind extends string, const Value extends string>(
  kind: Kind,
  value: Value,
  options: { readonly allowEmpty?: boolean } = {},
): StringReference<Kind, Value> {
  if (value.trim() !== value) {
    throw new ReferenceValidationError(
      kind,
      'must be canonical and must not contain surrounding whitespace',
    );
  }
  // The exact-input check makes preserving Value sound after validation.
  return reference(kind, value, options) as StringReference<Kind, Value>;
}

function sequence(value: number): SequenceVersion {
  // Numbers cannot carry runtime brand metadata; validation happens at each caller.
  return value as SequenceVersion;
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
export function operationId<const Name extends string>(value: Name): OperationId<Name> {
  return literalReference('operation-id', value);
}
export function aggregateId(value: string): AggregateId {
  return reference('aggregate-id', value);
}
export function eventId(value: string): EventId {
  return reference('event-id', value);
}
export function commandId(value: string): CommandId {
  return reference('command-id', value);
}
export function faultId(value: string): FaultId {
  return reference('fault-id', value);
}
export function sequenceVersion(value: number): SequenceVersion {
  if (!Number.isInteger(value) || value < 0) {
    throw new ReferenceValidationError('sequence-version', 'must be a non-negative integer');
  }
  return sequence(value);
}
export function committedSequenceVersion(value: number): SequenceVersion {
  if (!Number.isInteger(value) || value < 1) {
    throw new ReferenceValidationError('committed-sequence-version', 'must be a positive integer');
  }
  return sequence(value);
}
export function jsonPath(value: string): JsonPath {
  const normalized = value.trim();
  if (normalized !== '' && !normalized.startsWith('/')) {
    throw new ReferenceValidationError('json-path', 'must be an RFC 6901 pointer');
  }
  return reference('json-path', normalized, { allowEmpty: true });
}
export function eventType<const Name extends string>(
  value: Name & AcceptedScenarioEventName<Name>,
): EventType<Name> {
  return literalReference('event-type', value);
}
export function eventReference<const Boundary extends string, const Name extends string>(
  boundary: BoundaryName & Boundary,
  event: EventType<Name>,
): EventReference<Boundary, Name> {
  const value: `${Boundary}:${Name}` = `${boundary}:${event}`;
  return literalReference('event-reference', value);
}
export function schemaReference<const Name extends string>(value: Name): SchemaReference<Name> {
  return literalReference('schema-reference', value);
}
export function pathSegment(value: string): ContractPathSegment {
  const normalized = value.trim();
  if (normalized === '' || normalized.includes('/') || /[{}]/.test(normalized)) {
    throw new ReferenceValidationError('contract-path segment', 'must be a non-empty token');
  }
  const segment = { kind: 'literal', value: normalized } satisfies ContractPathSegment;
  return Object.freeze(segment);
}
export function pathParameter(value: string): ContractPathSegment {
  const normalized = value.trim();
  if (normalized === '' || normalized.includes('/') || /[{}]/.test(normalized)) {
    throw new ReferenceValidationError('contract-path parameter', 'must be a non-empty name');
  }
  const segment = { kind: 'parameter', value: normalized } satisfies ContractPathSegment;
  return Object.freeze(segment);
}
export function contractPath(...segments: readonly ContractPathSegment[]): ContractPath {
  if (segments.length === 0) return reference('contract-path', '/');
  const value = `/${segments
    .map((segment) => (segment.kind === 'parameter' ? `{${segment.value}}` : segment.value))
    .join('/')}`;
  return reference('contract-path', value);
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
  return reference('field-path', value);
}
export function queryPath(...segments: readonly FieldPathSegment[]): QueryPath {
  if (segments.length === 0) throw new ReferenceValidationError('query path', 'needs a segment');
  return reference('query-path', segments.map((segment) => segment.value).join('.'));
}

export const BoundaryName = freezeCompanion({ parse: boundaryName }, ['parse']);

export const OperationId = freezeCompanion(
  {
    parse(value: string): OperationId {
      return reference('operation-id', value);
    },
    literal<const Name extends string>(value: Name): OperationId<Name> {
      return operationId(value);
    },
  },
  ['parse', 'literal'],
);

export const EventType = freezeCompanion(
  {
    parse(value: string): EventType {
      return reference('event-type', value);
    },
    literal<const Name extends string>(
      value: Name & AcceptedScenarioEventName<Name>,
    ): EventType<Name> {
      return eventType(value);
    },
  },
  ['parse', 'literal'],
);

export const AggregateId = freezeCompanion({ parse: aggregateId }, ['parse']);
export const EventId = freezeCompanion({ parse: eventId }, ['parse']);
export const CommandId = freezeCompanion({ parse: commandId }, ['parse']);
export const FaultId = freezeCompanion({ parse: faultId }, ['parse']);

export const SequenceVersion = freezeCompanion({ parse: sequenceVersion }, ['parse']);

export const SchemaReference = freezeCompanion(
  {
    parse(value: string): SchemaReference {
      return reference('schema-reference', value);
    },
    literal<const Name extends string>(value: Name): SchemaReference<Name> {
      return schemaReference(value);
    },
  },
  ['parse', 'literal'],
);
