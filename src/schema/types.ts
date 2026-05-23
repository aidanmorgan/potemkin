import type { JsonValue } from '../types.js';

export type SchemaTypeKind =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null'
  | 'union'
  | 'any';

export interface ObjectGraphSchema {
  readonly name: string;
  readonly kind: SchemaTypeKind;
  readonly properties?: Record<string, ObjectGraphSchema>;
  readonly items?: ObjectGraphSchema;
  readonly required?: readonly string[];
  readonly enum?: readonly JsonValue[];
  readonly union?: readonly ObjectGraphSchema[];   // when kind === 'union' or 'oneOf'
  readonly format?: string;                        // e.g. 'date-time', 'uuid'
  readonly nullable?: boolean;
  /** Default false (strict). */
  readonly additionalProperties?: boolean | ObjectGraphSchema;
  readonly description?: string;
  /**
   * Distinguishes oneOf (exactly one match) from anyOf (at least one match) when kind === 'union'.
   * Maps from OpenAPI `oneOf` vs `anyOf`.
   */
  readonly unionVariant?: 'oneOf' | 'anyOf';
  /**
   * Minimum numeric value (inclusive). Enforced for integer and number kinds.
   * Maps from OpenAPI `minimum`.
   */
  readonly minimum?: number;
  /**
   * Maximum numeric value (inclusive). Enforced for integer and number kinds.
   * Maps from OpenAPI `maximum`.
   */
  readonly maximum?: number;
  /**
   * Exclusive minimum numeric value. Enforced for integer and number kinds.
   * Maps from OpenAPI `exclusiveMinimum` (numeric form).
   */
  readonly exclusiveMinimum?: number;
  /**
   * Exclusive maximum numeric value. Enforced for integer and number kinds.
   * Maps from OpenAPI `exclusiveMaximum` (numeric form).
   */
  readonly exclusiveMaximum?: number;
  /**
   * Minimum string length (inclusive). Enforced for string kind.
   * Maps from OpenAPI `minLength`.
   */
  readonly minLength?: number;
  /**
   * Maximum string length (inclusive). Enforced for string kind.
   * Maps from OpenAPI `maxLength`.
   */
  readonly maxLength?: number;
  /**
   * Regex pattern that a string value must match.
   * Maps from OpenAPI `pattern`.
   */
  readonly pattern?: string;
}

export interface BoundarySchemas {
  readonly boundary: string;
  readonly entity: ObjectGraphSchema;
  /** Dot-paths that are arrays (computed convenience). */
  readonly arrayPaths: readonly string[];
}

export interface ObjectGraphSchemaRegistry {
  readonly byBoundary: Record<string, BoundarySchemas>;
  get(boundary: string): BoundarySchemas | undefined;
}
