import SwaggerParser from "@apidevtools/swagger-parser";
import type { OpenAPI } from "openapi-types";
import * as yaml from "js-yaml";
import * as fs from "node:fs";
import * as path from "node:path";
import { glob } from "tinyglobby";
import { createNoopLogger, type Logger } from "../observability/logger.js";
import { createNoopTracer, withSpan, type Tracer } from "../observability/tracing.js";
import type { JsonObject } from "../types.js";

export interface OpenApiParameter {
  readonly name: string;
  readonly in: "path" | "query" | "header";
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

export interface OpenApiDoc {
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
  if (typeof source !== "string") return undefined;
  const sourcePath = path.resolve(source);
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) return undefined;
  const mapPath = path.join(path.dirname(path.dirname(sourcePath)), "error-code-map.json");
  if (!fs.existsSync(mapPath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(mapPath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.some(([, value]) => typeof value !== "string")) return undefined;
    return Object.fromEntries(entries) as Readonly<Record<string, string>>;
  } catch {
    return undefined;
  }
}

export interface OpenApiLoadObservability {
  readonly logger?: Logger;
  readonly tracer?: Tracer;
}

function asJsonObject(v: unknown): JsonObject | undefined {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    return v as JsonObject;
  }
  return undefined;
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
  if (value === null || typeof value !== "object") return value;
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
  if (node["nullable"] !== true) return node;
  const { nullable: _drop, ...rest } = node;
  // An `enum` rejects null regardless of `type`, so add null to the allowed set.
  if (Array.isArray(rest["enum"]) && !(rest["enum"] as unknown[]).includes(null)) {
    rest["enum"] = [...(rest["enum"] as unknown[]), null];
  }
  const t = rest["type"];
  if (typeof t === "string" && t !== "null") {
    rest["type"] = [t, "null"];
    return rest;
  }
  if (Array.isArray(t)) {
    if (!t.includes("null")) rest["type"] = [...t, "null"];
    return rest;
  }
  // No bare `type` (anyOf / oneOf / allOf / $ref content): permit null via anyOf.
  return { anyOf: [rest, { type: "null" }] };
}

function extractParameters(rawParams: unknown): readonly OpenApiParameter[] {
  if (!Array.isArray(rawParams)) return [];
  const result: OpenApiParameter[] = [];
  for (const p of rawParams) {
    if (p === null || typeof p !== "object" || Array.isArray(p)) continue;
    const param = p as Record<string, unknown>;
    if (typeof param["name"] !== "string") continue;
    const inVal = param["in"];
    if (inVal !== "path" && inVal !== "query" && inVal !== "header") continue;
    const extensions: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(param)) {
      if (k.startsWith("x-")) extensions[k] = v;
    }
    result.push({
      name: param["name"],
      in: inVal,
      required: typeof param["required"] === "boolean" ? param["required"] : undefined,
      schema: asJsonObject(param["schema"]),
      ...extensions,
    });
  }
  return result;
}

function extractOperation(rawOp: unknown): OpenApiOperation | undefined {
  if (rawOp === null || typeof rawOp !== "object" || Array.isArray(rawOp)) return undefined;
  const op = rawOp as Record<string, unknown>;

  const operationId = typeof op["operationId"] === "string" ? op["operationId"] : undefined;

  let requestBodySchema: JsonObject | undefined;
  const rb = op["requestBody"];
  if (rb !== null && typeof rb === "object" && !Array.isArray(rb)) {
    const rbObj = rb as Record<string, unknown>;
    const content = rbObj["content"];
    if (content !== null && typeof content === "object" && !Array.isArray(content)) {
      const contentObj = content as Record<string, unknown>;
      // Prefer JSON, but fall back to form-encoded media types so operations that
      // declare their body only as application/x-www-form-urlencoded (e.g. the
      // real Stripe spec) still get request-body validation. Without this, an
      // invalid form-op body skips validation, mutates state, and only trips
      // response validation — surfacing as a 500 instead of a 400.
      const mediaType =
        contentObj["application/json"] ??
        contentObj["application/x-www-form-urlencoded"] ??
        contentObj["multipart/form-data"];
      if (mediaType !== null && typeof mediaType === "object" && !Array.isArray(mediaType)) {
        const mtObj = mediaType as Record<string, unknown>;
        const rbSchema = asJsonObject(mtObj["schema"]);
        requestBodySchema = rbSchema ? (decycleSchema(rbSchema) as JsonObject) : undefined;
      }
    }
  }

  const responseSchemas: Record<string, JsonObject> = {};
  const responseHeaders: Record<string, readonly string[]> = {};
  const responses = op["responses"];
  if (responses !== null && typeof responses === "object" && !Array.isArray(responses)) {
    for (const [status, resp] of Object.entries(responses as Record<string, unknown>)) {
      // The runtime resolver intentionally supports only an exact numeric
      // status or `default`. OpenAPI also permits response ranges such as
      // `4XX`, but treating those as a catch-all here would make an operation
      // appear to declare statuses it does not actually expose to Potemkin's
      // deterministic error mappers.
      if (status !== "default" && !/^\d{3}$/.test(status)) continue;
      if (resp === null || typeof resp !== "object" || Array.isArray(resp)) continue;
      const respObj = resp as Record<string, unknown>;
      const headers = respObj["headers"];
      if (headers !== null && typeof headers === "object" && !Array.isArray(headers)) {
        responseHeaders[status] = Object.keys(headers as Record<string, unknown>).map((name) =>
          name.toLowerCase(),
        );
      }
      const content = respObj["content"];
      if (content === null || typeof content !== "object" || Array.isArray(content)) continue;
      const contentObj = content as Record<string, unknown>;
      const json = contentObj["application/json"];
      if (json === null || typeof json !== "object" || Array.isArray(json)) continue;
      const jsonObj = json as Record<string, unknown>;
      const schema = asJsonObject(jsonObj["schema"]);
      if (schema) responseSchemas[status] = decycleSchema(schema) as JsonObject;
    }
  }

  const operationExtensions: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(op)) {
    if (k.startsWith("x-")) operationExtensions[k] = v;
  }

  return {
    operationId,
    requestBodySchema,
    responseSchemas: Object.keys(responseSchemas).length > 0 ? responseSchemas : undefined,
    responseHeaders: Object.keys(responseHeaders).length > 0 ? responseHeaders : undefined,
    parameters: extractParameters(op["parameters"]),
    ...operationExtensions,
  };
}

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

function normalisePaths(rawDoc: OpenAPI.Document): Record<string, OpenApiPathItem> {
  const paths: Record<string, OpenApiPathItem> = {};
  const rawPaths = (rawDoc as Record<string, unknown>)["paths"];
  if (rawPaths === null || typeof rawPaths !== "object" || Array.isArray(rawPaths)) {
    return paths;
  }

  for (const [pathTemplate, rawPathItem] of Object.entries(rawPaths as Record<string, unknown>)) {
    if (rawPathItem === null || typeof rawPathItem !== "object" || Array.isArray(rawPathItem))
      continue;
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

export async function loadOpenApi(
  source: string | object,
  observability: OpenApiLoadObservability = {},
): Promise<OpenApiDoc> {
  const logger = observability.logger ?? createNoopLogger();
  return withSpan(observability.tracer ?? createNoopTracer(), "contract.load", async () => {
    let parseTarget: string | OpenAPI.Document;

    const normalizedSource: string | object = Buffer.isBuffer(source)
      ? (source as Buffer).toString("utf8")
      : source;

    if (typeof normalizedSource === "string") {
      const trimmed = normalizedSource.trimStart();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        parseTarget = JSON.parse(normalizedSource) as OpenAPI.Document;
      } else if (
        !normalizedSource.startsWith("http://") &&
        !normalizedSource.startsWith("https://") &&
        !normalizedSource.startsWith("/") &&
        !normalizedSource.match(/^[a-zA-Z]:\\/) &&
        (normalizedSource.includes("\n") || normalizedSource.includes(":"))
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

    logger.info({ pathCount, operationCount }, "OpenAPI contract loaded");

    const errorCodeMap = loadErrorCodeMap(source);

    return {
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
  const patterns = (typeof sources === "string" ? [sources] : [...sources]).flatMap((source) =>
    source
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const files = await glob(patterns, { cwd, absolute: true, onlyFiles: true });
  const uniqueFiles = [...new Set(files.map((file) => path.resolve(file)))].sort();
  if (uniqueFiles.length === 0)
    throw new Error(`No OpenAPI documents matched: ${patterns.join(", ")}`);
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
        const mutable = existing as Record<string, OpenApiOperation | undefined>;
        for (const [method, operation] of Object.entries(item)) {
          if (existing[method] !== undefined) {
            throw new Error(
              `Duplicate OpenAPI operation ${method.toUpperCase()} ${routePath} in ${sources[index]}`,
            );
          }
          mutable[method] = operation;
        }
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
    raw: mergeRawOpenApiDocuments(documents.map((document) => document.raw)),
    paths,
    ...(Object.keys(errorCodeMap).length === 0 ? {} : { errorCodeMap }),
    operationIdIndex,
  };
}

function mergeRawOpenApiDocuments(rawDocuments: readonly unknown[]): unknown {
  const merged = cloneRecord(rawDocuments[0]);
  const mergedPaths = asRecord(merged["paths"]);
  const mergedComponents = asRecord(merged["components"]);
  for (const raw of rawDocuments.slice(1)) {
    const document = cloneRecord(raw);
    const paths = asRecord(document["paths"]);
    for (const [routePath, item] of Object.entries(paths)) {
      const existing = asRecord(mergedPaths[routePath]);
      if (existing === undefined) mergedPaths[routePath] = item;
      else Object.assign(existing, item);
    }
    const components = asRecord(document["components"]);
    for (const [kind, values] of Object.entries(components)) {
      const existing = asRecord(mergedComponents[kind]);
      if (existing === undefined) mergedComponents[kind] = values;
      else Object.assign(existing, values);
    }
    for (const [key, value] of Object.entries(document)) {
      if (key !== "paths" && key !== "components" && merged[key] === undefined) merged[key] = value;
    }
  }
  merged["paths"] = mergedPaths;
  if (Object.keys(mergedComponents).length > 0) merged["components"] = mergedComponents;
  return merged;
}

function cloneRecord(value: unknown): Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (structuredClone(value) as Record<string, any>)
    : {};
}

function asRecord(value: unknown): Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}
