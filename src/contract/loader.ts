import SwaggerParser from '@apidevtools/swagger-parser';
import type { OpenAPI } from 'openapi-types';
import { parse } from 'yaml';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { glob } from 'tinyglobby';
import { createNoopLogger, type Logger } from '../observability/logger.js';
import { createNoopTracer, withSpan, type Tracer } from '../observability/tracing.js';
import { asRecord, isJsonObject, isRecord, type JsonObject } from '../contracts/value.js';

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
  /** Response header names declared by status code, normalized to lowercase. */
  readonly responseHeaders?: Readonly<Record<string, readonly string[]>>;
  readonly parameters?: readonly OpenApiParameter[];
  readonly [key: `x-${string}`]: unknown;
}

export interface OpenApiPathItem {
  readonly [method: string]: OpenApiOperation | undefined;
}

type MutableOpenApiPathItem = {
  [method: string]: OpenApiOperation | undefined;
};

export interface OpenApiDoc {
  /** Original contract document, retained for source-oriented tooling such as type generation. */
  readonly source?: unknown;
  /** Local source files represented by this document, when known. */
  readonly sourcePaths?: readonly string[];
  readonly raw: unknown;
  readonly paths: Record<string, OpenApiPathItem>;
  /** Optional flat engine-error-code -> contract-error-value map colocated with an example. */
  readonly errorCodeMap?: Readonly<Record<string, string>>;
  /**
   * Reverse index from "<METHOD> <path-template>" → operationId, built once at load.
   * Carried on the doc instance (no module-level cache) so lookups are O(1) and the
   * index lifecycle matches the doc lifecycle. Always populated by loadOpenApi; optional
   * only so hand-built doc literals in tests can omit it (lookupOperationId then derives
   * the answer directly from paths).
   */
  readonly operationIdIndex?: ReadonlyMap<string, string>;
}

function loadErrorCodeMap(source: string | object): Readonly<Record<string, string>> | undefined {
  if (typeof source !== 'string') return undefined;
  const sourcePath = path.resolve(source);
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) return undefined;
  const mapPath = path.join(path.dirname(path.dirname(sourcePath)), 'error-code-map.json');
  if (!fs.existsSync(mapPath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    const record = asRecord(parsed);
    if (record === undefined) return undefined;
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) {
      if (typeof value !== 'string') return undefined;
      result[key] = value;
    }
    return result;
  } catch {
    return undefined;
  }
}

export interface OpenApiLoadObservability {
  readonly logger?: Logger;
  readonly tracer?: Tracer;
}

function asJsonObject(v: unknown): JsonObject | undefined {
  return isJsonObject(v) ? v : undefined;
}

function decycledJsonObject(value: unknown): JsonObject | undefined {
  return asJsonObject(decycleSchema(value));
}

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
    const source = asRecord(value);
    if (source === undefined) return value;
    for (const [k, v] of Object.entries(source)) {
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
  const enumValues = rest['enum'];
  if (Array.isArray(enumValues) && !enumValues.includes(null)) {
    rest['enum'] = [...enumValues, null];
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
    const param = asRecord(p);
    if (param === undefined) continue;
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
      schema: decycledJsonObject(param['schema']),
      ...extensions,
    });
  }
  return result;
}

function extractOperation(rawOp: unknown): OpenApiOperation | undefined {
  if (rawOp === null || typeof rawOp !== 'object' || Array.isArray(rawOp)) return undefined;
  const op = asRecord(rawOp);
  if (op === undefined) return undefined;

  const operationId = typeof op['operationId'] === 'string' ? op['operationId'] : undefined;

  let requestBodySchema: JsonObject | undefined;
  const rb = op['requestBody'];
  if (rb !== null && typeof rb === 'object' && !Array.isArray(rb)) {
    const rbObj = asRecord(rb);
    if (rbObj === undefined) return undefined;
    const content = rbObj['content'];
    if (content !== null && typeof content === 'object' && !Array.isArray(content)) {
      const contentObj = asRecord(content);
      if (contentObj === undefined) return undefined;
      // Prefer JSON, but fall back to form-encoded media types so operations that
      // declare their body only as application/x-www-form-urlencoded (e.g. the
      // real Stripe spec) still get request-body validation. Without this, an
      // invalid form-op body skips validation, mutates state, and only trips
      // response validation — surfacing as a 500 instead of a 400.
      const mediaType =
        contentObj['application/json'] ??
        contentObj['application/x-www-form-urlencoded'] ??
        contentObj['multipart/form-data'];
      if (mediaType !== null && typeof mediaType === 'object' && !Array.isArray(mediaType)) {
        const mtObj = asRecord(mediaType);
        requestBodySchema = mtObj === undefined ? undefined : decycledJsonObject(mtObj['schema']);
      }
    }
  }

  const responseSchemas: Record<string, JsonObject> = {};
  const responseHeaders: Record<string, readonly string[]> = {};
  const responses = op['responses'];
  if (responses !== null && typeof responses === 'object' && !Array.isArray(responses)) {
    const responseMap = asRecord(responses);
    if (responseMap === undefined) return undefined;
    for (const [status, resp] of Object.entries(responseMap)) {
      // The runtime resolver intentionally supports only an exact numeric
      // status or `default`. OpenAPI also permits response ranges such as
      // `4XX`, but treating those as a catch-all here would make an operation
      // appear to declare statuses it does not actually expose to Potemkin's
      // deterministic error mappers.
      if (status !== 'default' && !/^\d{3}$/.test(status)) continue;
      if (resp === null || typeof resp !== 'object' || Array.isArray(resp)) continue;
      const respObj = asRecord(resp);
      if (respObj === undefined) continue;
      const headers = respObj['headers'];
      if (headers !== null && typeof headers === 'object' && !Array.isArray(headers)) {
        const headerMap = asRecord(headers);
        if (headerMap !== undefined)
          responseHeaders[status] = Object.keys(headerMap).map((name) => name.toLowerCase());
      }
      const content = respObj['content'];
      if (content === null || typeof content !== 'object' || Array.isArray(content)) continue;
      const contentObj = asRecord(content);
      if (contentObj === undefined) continue;
      const json = contentObj['application/json'];
      if (json === null || typeof json !== 'object' || Array.isArray(json)) continue;
      const jsonObj = asRecord(json);
      if (jsonObj === undefined) continue;
      const schema = decycledJsonObject(jsonObj['schema']);
      if (schema !== undefined) responseSchemas[status] = schema;
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
    responseHeaders: Object.keys(responseHeaders).length > 0 ? responseHeaders : undefined,
    parameters: extractParameters(op['parameters']),
    ...operationExtensions,
  };
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/**
 * Keep inline contract parsing compatible with the former js-yaml loader.
 * `yaml` requires merge keys and timestamp resolution to be opted into when
 * using its core schema; both are part of the contract-source dialect.
 */
function parseLegacyYaml(source: string): unknown {
  return parse(source, {
    schema: 'core',
    merge: true,
    customTags: ['timestamp'],
  });
}

function normalisePaths(rawDoc: OpenAPI.Document): Record<string, OpenApiPathItem> {
  const paths: Record<string, OpenApiPathItem> = {};
  const rawPaths = asRecord(rawDoc)?.['paths'];
  if (rawPaths === null || typeof rawPaths !== 'object' || Array.isArray(rawPaths)) {
    return paths;
  }

  const pathMap = asRecord(rawPaths);
  if (pathMap === undefined) return paths;
  for (const [pathTemplate, rawPathItem] of Object.entries(pathMap)) {
    const pathItemObj = asRecord(rawPathItem);
    if (pathItemObj === undefined) continue;
    const pathItem: MutableOpenApiPathItem = {};

    for (const method of HTTP_METHODS) {
      const rawOp = pathItemObj[method];
      if (rawOp === undefined) continue;
      const op = extractOperation(rawOp);
      if (op !== undefined) pathItem[method] = op;
    }

    paths[pathTemplate] = pathItem;
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

export async function loadOpenApi(
  source: string | object,
  observability: OpenApiLoadObservability = {},
): Promise<OpenApiDoc> {
  const logger = observability.logger ?? createNoopLogger();
  return withSpan(observability.tracer ?? createNoopTracer(), 'contract.load', async () => {
    let parseTarget: string | OpenAPI.Document;

    const normalizedSource: string | object = Buffer.isBuffer(source)
      ? source.toString('utf8')
      : source;

    if (typeof normalizedSource === 'string') {
      const trimmed = normalizedSource.trimStart();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        parseTarget = asOpenApiDocument(JSON.parse(normalizedSource));
      } else if (
        !normalizedSource.startsWith('http://') &&
        !normalizedSource.startsWith('https://') &&
        !normalizedSource.startsWith('/') &&
        !normalizedSource.match(/^[a-zA-Z]:\\/) &&
        (normalizedSource.includes('\n') || normalizedSource.includes(':'))
      ) {
        // Likely inline YAML
        parseTarget = asOpenApiDocument(parseLegacyYaml(normalizedSource));
      } else {
        parseTarget = normalizedSource;
      }
    } else {
      parseTarget = asOpenApiDocument(normalizedSource);
    }

    // Keep the authoring document separate from the dereferenced runtime graph. The
    // latter is deliberately decycled below and may contain cycles introduced by
    // `$ref` resolution, while generators need the original reusable components.
    const sourceDocument = await SwaggerParser.parse(parseTarget);
    const dereferenced = await SwaggerParser.dereference(parseTarget);

    const paths = normalisePaths(dereferenced);
    const pathCount = Object.keys(paths).length;
    const operationCount = Object.values(paths).reduce(
      (sum, item) => sum + Object.keys(item).length,
      0,
    );

    logger.info({ pathCount, operationCount }, 'OpenAPI contract loaded');

    const errorCodeMap = loadErrorCodeMap(source);

    return {
      source: sourceDocument,
      ...(typeof normalizedSource === 'string' &&
      !normalizedSource.startsWith('http://') &&
      !normalizedSource.startsWith('https://') &&
      fs.existsSync(path.resolve(normalizedSource))
        ? { sourcePaths: [path.resolve(normalizedSource)] }
        : {}),
      raw: dereferenced,
      paths,
      ...(errorCodeMap !== undefined ? { errorCodeMap } : {}),
      operationIdIndex: buildOperationIdIndex(paths),
    };
  });
}

/** Load and merge the OpenAPI documents selected by one or more file globs. */
export async function loadOpenApiDocuments(
  sources: string | readonly string[],
  cwd = process.cwd(),
  observability: OpenApiLoadObservability = {},
): Promise<OpenApiDoc> {
  const patterns = (typeof sources === 'string' ? [sources] : [...sources]).flatMap((source) =>
    source
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const files = await glob(patterns, { cwd, absolute: true, onlyFiles: true });
  const uniqueFiles = [...new Set(files.map((file) => path.resolve(file)))].sort();
  if (uniqueFiles.length === 0)
    throw new Error(`No OpenAPI documents matched: ${patterns.join(', ')}`);
  const documents = await Promise.all(uniqueFiles.map((file) => loadOpenApi(file, observability)));
  return documents.length === 1 ? documents[0] : mergeOpenApiDocuments(documents, uniqueFiles);
}

function mergeOpenApiDocuments(
  documents: readonly OpenApiDoc[],
  sources: readonly string[],
): OpenApiDoc {
  const paths: Record<string, OpenApiPathItem> = {};
  const operationIdIndex = new Map<string, string>();
  const errorCodeMap: Record<string, string> = {};

  for (let index = 0; index < documents.length; index++) {
    const document = documents[index];
    for (const [routePath, item] of Object.entries(document.paths)) {
      const existing = paths[routePath];
      if (existing === undefined) paths[routePath] = { ...item };
      else {
        const mergedItem: MutableOpenApiPathItem = { ...existing };
        for (const [method, operation] of Object.entries(item)) {
          if (mergedItem[method] !== undefined) {
            throw new Error(
              `Duplicate OpenAPI operation ${method.toUpperCase()} ${routePath} in ${sources[index]}`,
            );
          }
          mergedItem[method] = operation;
        }
        paths[routePath] = mergedItem;
      }
    }
    for (const [key, value] of Object.entries(document.errorCodeMap ?? {})) {
      if (errorCodeMap[key] !== undefined && errorCodeMap[key] !== value)
        throw new Error(`Conflicting OpenAPI error code mapping "${key}" in ${sources[index]}`);
      errorCodeMap[key] = value;
    }
  }

  for (const [routePath, item] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (operation?.operationId !== undefined)
        operationIdIndex.set(`${method.toUpperCase()} ${routePath}`, operation.operationId);
    }
  }

  return {
    source: mergeRawOpenApiDocuments(documents.map((document) => document.source ?? document.raw)),
    sourcePaths: documents.flatMap((document) => document.sourcePaths ?? []),
    raw: mergeRawOpenApiDocuments(documents.map((document) => document.raw)),
    paths,
    ...(Object.keys(errorCodeMap).length === 0 ? {} : { errorCodeMap }),
    operationIdIndex,
  };
}

function mergeRawOpenApiDocuments(rawDocuments: readonly unknown[]): unknown {
  const merged = cloneRecord(rawDocuments[0]);
  const mergedPaths = asRecord(merged['paths']) ?? {};
  const mergedComponents = asRecord(merged['components']) ?? {};
  for (const raw of rawDocuments.slice(1)) {
    const document = cloneRecord(raw);
    const paths = asRecord(document['paths']) ?? {};
    for (const [routePath, item] of Object.entries(paths)) {
      const existing = asRecord(mergedPaths[routePath]);
      if (existing === undefined) mergedPaths[routePath] = item;
      else Object.assign(existing, item);
    }
    const components = asRecord(document['components']) ?? {};
    for (const [kind, values] of Object.entries(components)) {
      const existing = asRecord(mergedComponents[kind]);
      if (existing === undefined) mergedComponents[kind] = values;
      else Object.assign(existing, values);
    }
    for (const [key, value] of Object.entries(document)) {
      if (key !== 'paths' && key !== 'components' && merged[key] === undefined) merged[key] = value;
    }
  }
  merged['paths'] = mergedPaths;
  if (Object.keys(mergedComponents).length > 0) merged['components'] = mergedComponents;
  return merged;
}

function cloneRecord(value: unknown): Record<string, unknown> {
  if (asRecord(value) === undefined) return {};
  const cloned: unknown = structuredClone(value);
  return asRecord(cloned) ?? {};
}

function asOpenApiDocument(value: unknown): OpenAPI.Document {
  if (!isOpenApiDocument(value)) {
    throw new TypeError('OpenAPI document must declare a version and info.title/info.version');
  }
  return value;
}

function isOpenApiDocument(value: unknown): value is OpenAPI.Document {
  if (!isRecord(value)) return false;
  const info = asRecord(value['info']);
  return (
    info !== undefined &&
    typeof info['title'] === 'string' &&
    typeof info['version'] === 'string' &&
    (typeof value['openapi'] === 'string' || typeof value['swagger'] === 'string')
  );
}
