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
  readonly union?: readonly ObjectGraphSchema[];   // when kind === 'union'
  readonly format?: string;                        // e.g. 'date-time', 'uuid'
  readonly nullable?: boolean;
  /** Default false (strict). */
  readonly additionalProperties?: boolean | ObjectGraphSchema;
  readonly description?: string;
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
