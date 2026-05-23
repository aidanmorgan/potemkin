import type { JsonObject } from '../types.js';

export interface OpenApiParameter {
  readonly name: string;
  readonly in: 'path' | 'query' | 'header';
  readonly required?: boolean;
  readonly schema?: JsonObject;
}

export interface OpenApiOperation {
  readonly operationId?: string;
  readonly requestBodySchema?: JsonObject;
  readonly responseSchemas?: Record<string, JsonObject>;
  readonly parameters?: readonly OpenApiParameter[];
}

export interface OpenApiPathItem {
  readonly [method: string]: OpenApiOperation | undefined;
}

export interface OpenApiDoc {
  readonly raw: unknown;
  readonly paths: Record<string, OpenApiPathItem>;
}

/**
 * Load and normalise an OpenAPI document from a file path string or a pre-parsed object.
 * Uses @apidevtools/swagger-parser under the hood to dereference $refs.
 */
export async function loadOpenApi(source: string | object): Promise<OpenApiDoc> {
  throw new Error('NotImplemented: contract/loader.loadOpenApi');
}
