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
  readonly [key: `x-${string}`]: unknown;
}

export interface OpenApiOperation {
  readonly operationId?: string;
  readonly requestBodySchema?: JsonObject;
  readonly responseSchemas?: Record<string, JsonObject>;
  readonly parameters?: readonly OpenApiParameter[];
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

/**
 * Maximum nesting depth retained when copying an operation's request/response
 * schema. Large real specs (e.g. Stripe) inline every `$ref` on dereference, so a
 * single resource schema fans out into an astronomically large tree; beyond this
 * depth the subtree is collapsed to `{}` (accept-anything).
 */
/**
 * Maximum object-nesting depth retained when copying a (dereferenced) schema.
 * Deeper schema objects are collapsed to `{}` (accept-anything). Real specs inline
 * every `$ref` on dereference, so a single resource schema fans out into an
 * astronomically large tree; this cap keeps the copy finite. Counts only object
 * nesting (arrays do not consume depth), so a chain like
 * object → anyOf[] → object → properties → object still descends through several
 * meaningful resource levels before collapsing.
 */
const MAX_OPERATION_SCHEMA_DEPTH = 8;

/**
 * Produce an acyclic, depth-bounded deep copy of a (dereferenced) OpenAPI schema.
 *
 * After `SwaggerParser.dereference`, schemas in large real specs are cyclic object
 * graphs (e.g. customer → subscription → customer). Both Ajv compilation and the
 * validator's `JSON.stringify` cache key overflow / throw on such graphs, and the
 * acyclic-but-inlined remainder is astronomically large. An *object* node that is
 * either already on the current recursion path (a cycle) or past the depth cap is
 * collapsed to `{}` (Ajv: "any value is valid"). Arrays are always copied through
 * — never collapsed and not counted toward depth — so keyword arrays (`required`,
 * `enum`, `anyOf`, `oneOf`, `allOf`, tuple `items`) keep their JSON shape and stay
 * valid schemas. `path` is a single shared Set mutated with add/delete (O(depth)
 * memory). The cycle/depth boundary is always reached via a nested reference
 * field, so the resource's own top-level required scalars remain fully validated.
 */
export function decycleSchema(value: unknown, path: Set<object> = new Set(), depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => decycleSchema(item, path, depth));
  }
  if (path.has(value) || depth >= MAX_OPERATION_SCHEMA_DEPTH) return {};
  path.add(value);
  try {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = decycleSchema(v, path, depth + 1);
    }
    return normalizeNullable(out);
  } finally {
    path.delete(value);
  }
}

/**
 * Rewrite an OpenAPI 3.0 `nullable: true` node into a form a JSON-Schema validator
 * (Ajv) accepts while preserving its meaning (the value may also be `null`).
 *
 * Ajv has no `nullable` keyword and rejects it outright ("nullable cannot be used
 * without type"). The transform depends on how the node constrains values:
 *   - plain `type` (string or array) → fold `null` into the type union
 *     (`type: "string"` → `type: ["string", "null"]`);
 *   - any other constrained node (`anyOf`/`oneOf`/`enum`/`allOf` with no bare
 *     `type`) → wrap as `{ anyOf: [ <node minus nullable>, { type: "null" } ] }`
 *     so `null` is explicitly allowed alongside the original constraint. This is
 *     essential for Stripe's many `nullable` enum/reference fields (e.g.
 *     payment_intent.cancellation_reason, .customer, .latest_charge), which the
 *     simulation legitimately emits as `null`.
 */
function normalizeNullable(node: Record<string, unknown>): Record<string, unknown> {
  if (node['nullable'] !== true) return node;
  const { nullable: _drop, ...rest } = node;
  // An `enum` rejects null regardless of `type`, so add null to the allowed set.
  if (Array.isArray(rest['enum']) && !(rest['enum'] as unknown[]).includes(null)) {
    rest['enum'] = [...(rest['enum'] as unknown[]), null];
  }
  const t = rest['type'];
  if (typeof t === 'string' && t !== 'null') {
    rest['type'] = [t, 'null'];
    return rest;
  }
  if (Array.isArray(t)) {
    if (!t.includes('null')) rest['type'] = [...t, 'null'];
    return rest;
  }
  // No bare `type` (anyOf / oneOf / allOf / $ref content): permit null via anyOf.
  return { anyOf: [rest, { type: 'null' }] };
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
        const rbSchema = asJsonObject(jsonObj['schema']);
        requestBodySchema = rbSchema ? (decycleSchema(rbSchema) as JsonObject) : undefined;
      }
    }
  }

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
      if (schema) responseSchemas[status] = decycleSchema(schema) as JsonObject;
    }
  }

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

export async function loadOpenApi(source: string | object): Promise<OpenApiDoc> {
  return withSpan(getTracer('contract'), 'contract.load', async () => {
    let parseTarget: string | OpenAPI.Document;

    const normalizedSource: string | object = Buffer.isBuffer(source)
      ? (source as Buffer).toString('utf8')
      : source;

    if (typeof normalizedSource === 'string') {
      const trimmed = normalizedSource.trimStart();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
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
