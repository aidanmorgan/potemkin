import SwaggerParser from '@apidevtools/swagger-parser';
import type { OpenAPI } from 'openapi-types';
import * as yaml from 'js-yaml';
import { createLogger } from '../observability/index.js';
import { getTracer, withSpan } from '../observability/index.js';
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

const logger = createLogger({ name: 'contract.loader' });

function asJsonObject(v: unknown): JsonObject | undefined {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    return v as JsonObject;
  }
  return undefined;
}

function extractParameters(rawParams: unknown): readonly OpenApiParameter[] {
  if (!Array.isArray(rawParams)) return [];
  const result: OpenApiParameter[] = [];
  for (const p of rawParams) {
    if (p === null || typeof p !== 'object' || Array.isArray(p)) continue;
    const param = p as Record<string, unknown>;
    if (typeof param['name'] !== 'string') continue;
    const inVal = param['in'];
    if (inVal !== 'path' && inVal !== 'query' && inVal !== 'header') continue;
    result.push({
      name: param['name'],
      in: inVal,
      required: typeof param['required'] === 'boolean' ? param['required'] : undefined,
      schema: asJsonObject(param['schema']),
    });
  }
  return result;
}

function extractOperation(rawOp: unknown): OpenApiOperation | undefined {
  if (rawOp === null || typeof rawOp !== 'object' || Array.isArray(rawOp)) return undefined;
  const op = rawOp as Record<string, unknown>;

  const operationId =
    typeof op['operationId'] === 'string' ? op['operationId'] : undefined;

  // requestBodySchema from requestBody.content['application/json'].schema
  let requestBodySchema: JsonObject | undefined;
  const rb = op['requestBody'];
  if (rb !== null && typeof rb === 'object' && !Array.isArray(rb)) {
    const rbObj = rb as Record<string, unknown>;
    const content = rbObj['content'];
    if (content !== null && typeof content === 'object' && !Array.isArray(content)) {
      const contentObj = content as Record<string, unknown>;
      const json = contentObj['application/json'];
      if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
        const jsonObj = json as Record<string, unknown>;
        requestBodySchema = asJsonObject(jsonObj['schema']);
      }
    }
  }

  // responseSchemas: map status string → schema from responses[status].content['application/json'].schema
  const responseSchemas: Record<string, JsonObject> = {};
  const responses = op['responses'];
  if (responses !== null && typeof responses === 'object' && !Array.isArray(responses)) {
    for (const [status, resp] of Object.entries(responses as Record<string, unknown>)) {
      if (resp === null || typeof resp !== 'object' || Array.isArray(resp)) continue;
      const respObj = resp as Record<string, unknown>;
      const content = respObj['content'];
      if (content === null || typeof content !== 'object' || Array.isArray(content)) continue;
      const contentObj = content as Record<string, unknown>;
      const json = contentObj['application/json'];
      if (json === null || typeof json !== 'object' || Array.isArray(json)) continue;
      const jsonObj = json as Record<string, unknown>;
      const schema = asJsonObject(jsonObj['schema']);
      if (schema) responseSchemas[status] = schema;
    }
  }

  return {
    operationId,
    requestBodySchema,
    responseSchemas: Object.keys(responseSchemas).length > 0 ? responseSchemas : undefined,
    parameters: extractParameters(op['parameters']),
  };
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

function normalisePaths(rawDoc: OpenAPI.Document): Record<string, OpenApiPathItem> {
  const paths: Record<string, OpenApiPathItem> = {};
  const rawPaths = (rawDoc as Record<string, unknown>)['paths'];
  if (rawPaths === null || typeof rawPaths !== 'object' || Array.isArray(rawPaths)) {
    return paths;
  }

  for (const [pathTemplate, rawPathItem] of Object.entries(rawPaths as Record<string, unknown>)) {
    if (rawPathItem === null || typeof rawPathItem !== 'object' || Array.isArray(rawPathItem)) continue;
    const pathItemObj = rawPathItem as Record<string, unknown>;
    const pathItem: Record<string, OpenApiOperation> = {};

    for (const method of HTTP_METHODS) {
      const rawOp = pathItemObj[method as string];
      if (rawOp === undefined) continue;
      const op = extractOperation(rawOp);
      if (op) pathItem[method as string] = op;
    }

    paths[pathTemplate] = pathItem as OpenApiPathItem;
  }

  return paths;
}

/**
 * Load and normalise an OpenAPI document from a file path string or a pre-parsed object.
 * Uses @apidevtools/swagger-parser under the hood to dereference $refs.
 */
export async function loadOpenApi(source: string | object): Promise<OpenApiDoc> {
  return withSpan(getTracer('contract'), 'contract.load', async () => {
    let parseTarget: string | OpenAPI.Document;

    if (typeof source === 'string') {
      const trimmed = source.trimStart();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        // Inline JSON string — parse first, then pass as object
        parseTarget = JSON.parse(source) as OpenAPI.Document;
      } else if (
        !source.startsWith('http://') &&
        !source.startsWith('https://') &&
        !source.startsWith('/') &&
        !source.match(/^[a-zA-Z]:\\/) &&
        (source.includes('\n') || source.includes(':'))
      ) {
        // Likely inline YAML
        parseTarget = yaml.load(source) as OpenAPI.Document;
      } else {
        // File path or URL — swagger-parser handles it directly
        parseTarget = source;
      }
    } else {
      parseTarget = source as OpenAPI.Document;
    }

    const dereferenced = await SwaggerParser.dereference(parseTarget);

    const paths = normalisePaths(dereferenced);
    const pathCount = Object.keys(paths).length;
    const operationCount = Object.values(paths).reduce(
      (sum, item) => sum + Object.keys(item).length,
      0,
    );

    logger.info({ pathCount, operationCount }, 'OpenAPI contract loaded');

    return {
      raw: dereferenced,
      paths,
    };
  });
}
