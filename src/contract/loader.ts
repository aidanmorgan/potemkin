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
  // F-07: Preserve vendor extension fields (x-*) from the original OpenAPI parameter.
  readonly [key: `x-${string}`]: unknown;
}

export interface OpenApiOperation {
  readonly operationId?: string;
  readonly requestBodySchema?: JsonObject;
  readonly responseSchemas?: Record<string, JsonObject>;
  readonly parameters?: readonly OpenApiParameter[];
  // F-07: Preserve vendor extension fields (x-*) from the original OpenAPI operation.
  readonly [key: `x-${string}`]: unknown;
}

export interface OpenApiPathItem {
  readonly [method: string]: OpenApiOperation | undefined;
}

export interface OpenApiDoc {
  readonly raw: unknown;
  readonly paths: Record<string, OpenApiPathItem>;
  /**
   * Reverse index from "<METHOD> <path-template>" → operationId, built once at load.
   * Carried on the doc instance (no module-level cache) so lookups are O(1) and the
   * index lifecycle matches the doc lifecycle. Always populated by loadOpenApi; optional
   * only so hand-built doc literals in tests can omit it (lookupOperationId then derives
   * the answer directly from paths).
   */
  readonly operationIdIndex?: ReadonlyMap<string, string>;
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
    // F-07: Carry through vendor extension keys (x-*).
    const extensions: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(param)) {
      if (k.startsWith('x-')) extensions[k] = v;
    }
    result.push({
      name: param['name'],
      in: inVal,
      required: typeof param['required'] === 'boolean' ? param['required'] : undefined,
      schema: asJsonObject(param['schema']),
      ...extensions,
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

  // F-07: Carry through vendor extension keys (x-*) from the raw operation.
  const operationExtensions: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(op)) {
    if (k.startsWith('x-')) operationExtensions[k] = v;
  }

  return {
    operationId,
    requestBodySchema,
    responseSchemas: Object.keys(responseSchemas).length > 0 ? responseSchemas : undefined,
    parameters: extractParameters(op['parameters']),
    ...operationExtensions,
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

/** Build the "<METHOD> <path>" → operationId reverse index from normalised paths. */
function buildOperationIdIndex(paths: Record<string, OpenApiPathItem>): Map<string, string> {
  const index = new Map<string, string>();
  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(pathItem)) {
      if (op?.operationId === undefined) continue;
      index.set(`${method.toUpperCase()} ${pathTemplate}`, op.operationId);
    }
  }
  return index;
}

/**
 * Resolve the OpenAPI operationId for a templated path + HTTP method.
 *
 * Uses the reverse index built at load and carried on the doc. The method is matched
 * case-insensitively (e.g. 'post' resolves the same as 'POST'). Returns undefined when
 * no operation matches the (path, method) pair, or when the matched operation declared
 * no operationId.
 */
export function lookupOperationId(
  doc: OpenApiDoc,
  path: string,
  method: string,
): string | undefined {
  const key = `${method.toUpperCase()} ${path}`;
  if (doc.operationIdIndex) return doc.operationIdIndex.get(key);
  // Fallback for hand-built doc literals without a prebuilt index: derive from paths.
  return doc.paths[path]?.[method.toLowerCase()]?.operationId;
}

/**
 * Load and normalise an OpenAPI document from a file path string, a pre-parsed object,
 * or a Buffer containing UTF-8 JSON/YAML.
 * Uses @apidevtools/swagger-parser under the hood to dereference $refs.
 */
export async function loadOpenApi(source: string | object): Promise<OpenApiDoc> {
  return withSpan(getTracer('contract'), 'contract.load', async () => {
    let parseTarget: string | OpenAPI.Document;

    // F-05: Detect Buffer and convert to UTF-8 string before further processing.
    const normalizedSource: string | object = Buffer.isBuffer(source)
      ? (source as Buffer).toString('utf8')
      : source;

    if (typeof normalizedSource === 'string') {
      const trimmed = normalizedSource.trimStart();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        // Inline JSON string — parse first, then pass as object
        parseTarget = JSON.parse(normalizedSource) as OpenAPI.Document;
      } else if (
        !normalizedSource.startsWith('http://') &&
        !normalizedSource.startsWith('https://') &&
        !normalizedSource.startsWith('/') &&
        !normalizedSource.match(/^[a-zA-Z]:\\/) &&
        (normalizedSource.includes('\n') || normalizedSource.includes(':'))
      ) {
        // Likely inline YAML
        parseTarget = yaml.load(normalizedSource) as OpenAPI.Document;
      } else {
        // File path or URL — swagger-parser handles it directly
        parseTarget = normalizedSource;
      }
    } else {
      parseTarget = normalizedSource as OpenAPI.Document;
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
      operationIdIndex: buildOperationIdIndex(paths),
    };
  });
}
