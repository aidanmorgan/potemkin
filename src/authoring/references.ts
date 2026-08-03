/**
 * Semantic references used by the TypeScript authoring surface.
 *
 * The runtime model deliberately stores protocol identifiers as strings. The
 * authoring layer is stricter: callers construct a value for the role they
 * mean, so an operation identifier cannot accidentally be supplied where an
 * event type, contract path, or response mask is expected.
 */

import { TypeScriptAuthoringError } from "./errors.js";

declare const referenceBrand: unique symbol;

export type PotemkinReference<Kind extends string> = string & {
  readonly [referenceBrand]: Kind;
};

export type BoundaryName = PotemkinReference<"boundary-name">;
export type BehaviorName = PotemkinReference<"behavior-name">;
export type FaultName = PotemkinReference<"fault-name">;
export type SagaName = PotemkinReference<"saga-name">;
export type SagaStepName = PotemkinReference<"saga-step-name">;
export type ResourceName = PotemkinReference<"resource-name">;
export type ComponentName = PotemkinReference<"component-name">;
export type HelperName = PotemkinReference<"helper-name">;
export type FactoryName = PotemkinReference<"factory-name">;
export type ScopeName = PotemkinReference<"scope-name">;
export type LinkRelation = PotemkinReference<"link-relation">;
export type OperationId = PotemkinReference<"operation-id">;
export type EventType = PotemkinReference<"event-type">;
export type EventReference = PotemkinReference<"event-reference">;
export type EventSelector = EventType | EventReference;
export type ContractPath = PotemkinReference<"contract-path">;
export type SchemaReference = PotemkinReference<"schema-reference">;
export type FieldPath = PotemkinReference<"field-path">;

/** OpenAPI/HTTP methods supported by the Potemkin authoring surface. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "TRACE";

export interface ContractPathSegment {
  readonly kind: "literal" | "parameter";
  readonly value: string;
}

export interface FieldPathSegment {
  readonly value: string;
}

function reference<Kind extends string>(kind: Kind, value: string): PotemkinReference<Kind> {
  const normalized = value.trim();
  if (normalized === "") throw new TypeScriptReferenceError(kind, "must not be empty");
  return normalized as PotemkinReference<Kind>;
}

export class TypeScriptReferenceError extends TypeScriptAuthoringError {
  readonly kind: string;

  constructor(kind: string, reason: string) {
    super("TS_REFERENCE_INVALID", `Invalid Potemkin ${kind}: ${reason}`, {
      details: { kind, reason },
    });
    this.kind = kind;
    this.name = "TypeScriptReferenceError";
  }
}

export function boundaryName(value: string): BoundaryName {
  return reference("boundary-name", value);
}

export function behaviorName(value: string): BehaviorName {
  return reference("behavior-name", value);
}

export function faultName(value: string): FaultName {
  return reference("fault-name", value);
}

export function sagaName(value: string): SagaName {
  return reference("saga-name", value);
}

export function sagaStepName(value: string): SagaStepName {
  return reference("saga-step-name", value);
}

export function resourceName(value: string): ResourceName {
  return reference("resource-name", value);
}

export function componentName(value: string): ComponentName {
  return reference("component-name", value);
}

export function helperName(value: string): HelperName {
  const result = reference("helper-name", value);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(result)) {
    throw new TypeScriptReferenceError("helper-name", "must be a CEL identifier");
  }
  return result;
}

export function factoryName(value: string): FactoryName {
  return reference("factory-name", value);
}

export function scopeName(value: string): ScopeName {
  return reference("scope-name", value);
}

export function linkRelation(value: string): LinkRelation {
  return reference("link-relation", value);
}

export function operationId(value: string): OperationId {
  return reference("operation-id", value);
}

export function eventType(value: string): EventType {
  return reference("event-type", value);
}

/** Identify an event emitted by a specific boundary for cross-boundary policies. */
export function eventReference(boundary: BoundaryName, event: EventType): EventReference {
  return reference("event-reference", `${boundary}:${event}`);
}

export function schemaReference(value: string): SchemaReference {
  return reference("schema-reference", value);
}

/** Create a literal OpenAPI path segment without embedding slash syntax. */
export function pathSegment(value: string): ContractPathSegment {
  const normalized = value.trim();
  if (normalized === "" || normalized.includes("/") || /[{}]/.test(normalized)) {
    throw new TypeScriptReferenceError("contract-path segment", "must be a non-empty token");
  }
  return Object.freeze({ kind: "literal" as const, value: normalized });
}

/** Create a parameterised OpenAPI path segment. */
export function pathParameter(value: string): ContractPathSegment {
  const normalized = value.trim();
  if (normalized === "" || normalized.includes("/") || /[{}]/.test(normalized)) {
    throw new TypeScriptReferenceError("contract-path parameter", "must be a non-empty name");
  }
  return Object.freeze({ kind: "parameter" as const, value: normalized });
}

/** Build an OpenAPI path from typed literal and parameter segments. */
export function contractPath(...segments: readonly ContractPathSegment[]): ContractPath {
  if (segments.length === 0) return reference("contract-path", "/") as ContractPath;
  const value = `/${segments
    .map((segment) => (segment.kind === "parameter" ? `{${segment.value}}` : segment.value))
    .join("/")}`;
  return reference("contract-path", value) as ContractPath;
}

export function field(value: string): FieldPathSegment {
  const normalized = value.trim();
  if (normalized === "" || normalized.includes("/")) {
    throw new TypeScriptReferenceError("field path segment", "must be a non-empty token");
  }
  return Object.freeze({ value: normalized });
}

/** Build an RFC 6901 response-mask path from typed field segments. */
export function fieldPath(...segments: readonly FieldPathSegment[]): FieldPath {
  if (segments.length === 0) throw new TypeScriptReferenceError("field path", "needs a segment");
  const pointer = segments
    .map((segment) => segment.value.replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("/");
  const value = segments.length === 1 ? pointer : `/${pointer}`;
  return reference("field-path", value) as FieldPath;
}
