import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";
import type { JsonObject, JsonValue } from "../types.js";
import type { OpenApiDoc } from "./loader.js";
import { decycleSchema } from "./loader.js";
import { InternalExecutionError } from "../errors.js";
import { matchRoute } from "./router.js";
import { resolveResponseSchema } from "./responseSchema.js";
import { createNoopLogger, type Logger } from "../observability/logger.js";
import { createNoopTracer, type Tracer } from "../observability/tracing.js";
import { createRequestValidator } from "./requestValidator.js";
import type { RequestHeaders } from "./requestValidator.js";

export interface ContractValidator {
  /**
   * Validate an inbound request payload and query/path params against the OpenAPI spec.
   * @throws {ContractViolationError} (400) on failure.
   */
  validateRequest(
    method: string,
    path: string,
    payload: JsonValue,
    queryParams: Record<string, string | string[]>,
    pathParams: Record<string, string>,
    headers?: RequestHeaders,
  ): void;

  /**
   * Validate the original payload of a runtime batch. Array request schemas
   * are checked as one document; object request schemas are validated against
   * each expanded command instead.
   */
  validateRequestBatch(
    method: string,
    path: string,
    payload: JsonValue,
    queryParams: Record<string, string | string[]>,
    pathParams: Record<string, string>,
    headers?: RequestHeaders,
  ): void;

  /** Validate one expanded command from a runtime batch. */
  validateRequestItem(
    method: string,
    path: string,
    payload: JsonValue,
    queryParams: Record<string, string | string[]>,
    pathParams: Record<string, string>,
    headers?: RequestHeaders,
  ): void;

  /**
   * Validate an outbound response body against the OpenAPI spec.
   * @param options.allowAdditionalProperties When true, the response schema is
   *   relaxed so that objects carrying properties beyond those declared in the
   *   contract no longer fail validation (the strict `additionalProperties: false`
   *   constraint is dropped recursively before compiling the validator).
   * @throws {InternalExecutionError} (500) on failure.
   */
  validateResponse(
    method: string,
    path: string,
    status: number,
    body: JsonValue,
    options?: { readonly allowAdditionalProperties?: boolean },
  ): void;

  /** Validate the response body for one expanded runtime batch item. */
  validateResponseItem(
    method: string,
    path: string,
    status: number,
    body: JsonValue,
    options?: { readonly allowAdditionalProperties?: boolean },
  ): void;

  /** Validate the aggregated response body for a runtime batch. */
  validateResponseBatch(
    method: string,
    path: string,
    status: number,
    body: JsonValue,
    options?: { readonly allowAdditionalProperties?: boolean },
  ): void;

  /**
   * Validate a state-graph entity against the schema for its boundary.
   * @throws {InternalExecutionError} (500) on failure.
   */
  validateEntity(boundary: string, entity: JsonObject): void;

  /** Validate a payload against a JSON Schema or OpenAPI component reference. */
  validateSchema(schemaRef: string, payload: JsonObject): void;
}

/**
 * Return a deep copy of a JSON-Schema fragment with every strict
 * `additionalProperties: false` / `unevaluatedProperties: false` constraint
 * removed (recursively, through nested objects/arrays and the standard schema
 * combinators). Used to honour X-Potemkin-Allow-Additional-Properties without
 * mutating the document or the cached strict validators. Schema-valued
 * `additionalProperties` (an object schema, not the literal `false`) is
 * preserved and recursed into.
 */
function relaxAdditionalProperties(schema: JsonObject): JsonObject {
  const relax = (node: JsonValue): JsonValue => {
    if (Array.isArray(node)) return node.map(relax);
    if (node === null || typeof node !== "object") return node;
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(node)) {
      if ((key === "additionalProperties" || key === "unevaluatedProperties") && value === false) {
        // Drop the strict constraint entirely (default is permissive).
        continue;
      }
      out[key] = relax(value);
    }
    return out;
  };
  return relax(schema) as JsonObject;
}

export interface ContractValidatorCacheOptions {
  /**
   * Maximum number of entries in the JSON-key-based validator cache.
   * Once the cap is reached the oldest entry is evicted (LRU by insertion order).
   * Defaults to 512, which is ample for typical single-contract deployments while
   * bounding memory under workloads that emit many structurally-distinct schemas.
   */
  readonly maxKeyedValidators?: number;
}

/** Source-neutral boundary metadata accepted by the validator factory. */
export interface ContractBoundaryReference {
  readonly boundary: string;
  readonly schema?: string;
}

export interface ContractValidatorObservability {
  readonly logger?: Logger;
  readonly tracer?: Tracer;
}

/**
 * OpenAPI documents may define domain-specific formats that are meaningful to
 * the provider contract but are not portable JSON Schema validators. Register
 * them explicitly so AJV treats them as known vocabulary while the contract's
 * type/pattern constraints remain authoritative.
 */
const NON_VALIDATING_DOCUMENT_FORMATS = ["currency", "decimal", "unix-time"] as const;

function registerDocumentFormats(ajv: Ajv): void {
  for (const format of NON_VALIDATING_DOCUMENT_FORMATS) ajv.addFormat(format, true);
}

export function createContractValidator(
  doc: OpenApiDoc,
  _boundaries: readonly ContractBoundaryReference[] = [],
  cacheOptions?: ContractValidatorCacheOptions,
  observability: ContractValidatorObservability = {},
): ContractValidator {
  const logger = observability.logger ?? createNoopLogger();
  const tracer = observability.tracer ?? createNoopTracer();
  const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
  addFormats(ajv);
  registerDocumentFormats(ajv);

  // Case-insensitive schema map: boundary names that differ only in casing (e.g. "opportunity" vs "Opportunity") still resolve.
  const caseInsensitiveSchemaMap = new Map<string, unknown>();
  const rawDocForInit = doc.raw as Record<string, unknown>;
  const componentsForInit = rawDocForInit["components"];
  if (
    componentsForInit &&
    typeof componentsForInit === "object" &&
    !Array.isArray(componentsForInit)
  ) {
    const schemasForInit = (componentsForInit as Record<string, unknown>)["schemas"];
    if (schemasForInit && typeof schemasForInit === "object" && !Array.isArray(schemasForInit)) {
      for (const [key, val] of Object.entries(schemasForInit as Record<string, unknown>)) {
        caseInsensitiveSchemaMap.set(key.toLowerCase(), val);
      }
    }
  }

  const maxKeyedValidators = cacheOptions?.maxKeyedValidators ?? 512;

  // WeakMap: fast identity-keyed primary cache (GC'd automatically).
  // Map: bounded to maxKeyedValidators; oldest entry evicted on cap (insertion order).
  const validatorCache = new WeakMap<object, ValidateFunction>();
  const validatorCacheByKey = new Map<string, ValidateFunction>();

  function getValidator(schema: JsonObject): ValidateFunction {
    const cached = validatorCache.get(schema);
    if (cached) return cached;

    // Break cycles + bound depth before stringifying/compiling: dereferenced
    // schemas from large real specs (e.g. Stripe) are cyclic object graphs that
    // would overflow JSON.stringify and Ajv. For small acyclic specs this is
    // behaviour-preserving — it only rewrites `nullable` nodes into the
    // equivalent type-union form, leaving validation outcomes unchanged.
    const acyclic = decycleSchema(schema) as JsonObject;

    const key = JSON.stringify(acyclic);
    const keyCached = validatorCacheByKey.get(key);
    if (keyCached) {
      validatorCache.set(schema, keyCached);
      return keyCached;
    }

    const compiled = ajv.compile(acyclic);
    validatorCache.set(schema, compiled);

    if (validatorCacheByKey.size >= maxKeyedValidators) {
      const oldestKey = validatorCacheByKey.keys().next().value;
      if (oldestKey !== undefined) {
        validatorCacheByKey.delete(oldestKey);
      }
    }
    validatorCacheByKey.set(key, compiled);
    return compiled;
  }

  const requestValidator = createRequestValidator({ doc, getValidator, logger });

  function validateResponseWithMode(
    method: string,
    path: string,
    status: number,
    body: JsonValue,
    options?: { readonly allowAdditionalProperties?: boolean },
    mode: "full" | "batch" | "batch-item" = "full",
  ): void {
    const matched = matchRoute(doc, method, path);
    if (!matched) {
      throw new InternalExecutionError(
        `Response failed contract validation: no route matches ${method} ${path}`,
      );
    }

    const schema = resolveResponseSchema(doc, method, path, status);
    if (!schema) return;

    if (mode === "batch" && schema.type !== "array") return;
    const itemSchema =
      mode === "batch-item" && schema.type === "array"
        ? (schema.items as JsonObject | undefined)
        : schema;
    if (itemSchema === undefined) return;

    const effectiveSchema =
      options?.allowAdditionalProperties === true
        ? relaxAdditionalProperties(itemSchema)
        : itemSchema;

    const validate = getValidator(effectiveSchema);
    if (!validate(body)) {
      logger.debug(
        { method, path, status, errors: validate.errors },
        "Response body validation failed",
      );
      throw new InternalExecutionError("Response failed contract validation", {
        errors: validate.errors as JsonValue,
      });
    }
  }

  function validateResponse(
    method: string,
    path: string,
    status: number,
    body: JsonValue,
    options?: { readonly allowAdditionalProperties?: boolean },
  ): void {
    validateResponseWithMode(method, path, status, body, options);
  }

  function validateResponseItem(
    method: string,
    path: string,
    status: number,
    body: JsonValue,
    options?: { readonly allowAdditionalProperties?: boolean },
  ): void {
    validateResponseWithMode(method, path, status, body, options, "batch-item");
  }

  function validateResponseBatch(
    method: string,
    path: string,
    status: number,
    body: JsonValue,
    options?: { readonly allowAdditionalProperties?: boolean },
  ): void {
    validateResponseWithMode(method, path, status, body, options, "batch");
  }

  function validateEntity(boundary: string, entity: JsonObject): void {
    tracer.startActiveSpan("contract.validateEntity", (span) => {
      try {
        const rawDoc = doc.raw as Record<string, unknown>;
        const components = rawDoc["components"];
        if (!components || typeof components !== "object" || Array.isArray(components)) {
          throw new InternalExecutionError("Entity violates contract", {
            boundary,
            errors: `No components section in OpenAPI document` as unknown as JsonValue,
          });
        }
        const schemas = (components as Record<string, unknown>)["schemas"];
        if (!schemas || typeof schemas !== "object" || Array.isArray(schemas)) {
          throw new InternalExecutionError("Entity violates contract", {
            boundary,
            errors: `No components.schemas section in OpenAPI document` as unknown as JsonValue,
          });
        }
        // Exact-case lookup first; fall back to case-insensitive map.
        const schema =
          (schemas as Record<string, unknown>)[boundary] ??
          caseInsensitiveSchemaMap.get(boundary.toLowerCase());
        if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
          throw new InternalExecutionError("Entity violates contract", {
            boundary,
            errors: `No schema found for boundary '${boundary}'` as unknown as JsonValue,
          });
        }

        const validate = getValidator(schema as JsonObject);
        // `_deleted` and `_deletedAt` are runtime graph metadata. They are
        // intentionally not part of an API resource schema, so validate the
        // public entity shape without those internal markers while retaining
        // them in the in-memory state graph for query semantics.
        const contractEntity = { ...entity };
        delete contractEntity["_deleted"];
        delete contractEntity["_deletedAt"];
        if (!validate(contractEntity)) {
          logger.debug({ boundary, errors: validate.errors }, "Entity validation failed");
          throw new InternalExecutionError("Entity violates contract", {
            boundary,
            errors: validate.errors as JsonValue,
          });
        }
      } finally {
        span.end();
      }
    });
  }

  function validateSchema(schemaRef: string, payload: JsonObject): void {
    const raw = doc.raw as Record<string, unknown>;
    const segments = schemaRef
      .replace(/^#\//, "")
      .split("/")
      .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
    let current: unknown = raw;
    for (const segment of segments) {
      if (current === null || typeof current !== "object" || Array.isArray(current)) {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    if (
      current === undefined ||
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      throw new InternalExecutionError("Event payload schema reference was not found", {
        schemaRef,
        code: "SCHEMA_TYPE_MISMATCH",
      });
    }
    const validate = getValidator(current as JsonObject);
    if (!validate(payload)) {
      throw new InternalExecutionError("Event payload failed schema validation", {
        schemaRef,
        code: "SCHEMA_TYPE_MISMATCH",
        errors: validate.errors as JsonValue,
      });
    }
  }

  return {
    ...requestValidator,
    validateResponse,
    validateResponseItem,
    validateResponseBatch,
    validateEntity,
    validateSchema,
  };
}
