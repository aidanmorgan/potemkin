import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { ValidateFunction } from 'ajv';
import type { JsonObject, JsonValue } from '../types.js';
import type { OpenApiDoc } from './loader.js';
import type { BoundaryConfig } from '../dsl/types.js';
import { ContractViolationError, InternalExecutionError } from '../errors.js';
import { matchRoute } from './router.js';
import { createLogger, getTracer } from '../observability/index.js';

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

  /**
   * Validate a state-graph entity against the schema for its boundary.
   * @throws {InternalExecutionError} (500) on failure.
   */
  validateEntity(boundary: string, entity: JsonObject): void;
}

const logger = createLogger({ name: 'contract.validator' });

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
    if (node === null || typeof node !== 'object') return node;
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(node)) {
      if ((key === 'additionalProperties' || key === 'unevaluatedProperties') && value === false) {
        // Drop the strict constraint entirely (default is permissive).
        continue;
      }
      out[key] = relax(value);
    }
    return out;
  };
  return relax(schema) as JsonObject;
}

/** Numeric value-range keywords the engine owns at runtime, not the request contract. */
const VALUE_RANGE_KEYWORDS = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
]);

/**
 * Return a deep copy of a JSON-Schema fragment with every numeric value-range
 * keyword (`minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`) removed.
 *
 * Value ranges describe business rules the engine enforces at runtime — DSL
 * `requires` guards (e.g. `dailyCallQuota > 0` → 422 INVALID_QUOTA) and the query
 * engine's pagination clamping (negative offset → 0, limit handling → 200). The
 * request contract validates SHAPE only (type, required, format, enum, length,
 * additionalProperties); a right-typed-but-out-of-range value must reach the
 * engine so the guard fires (422) or the value is clamped (200) rather than being
 * pre-empted by a 400. Type/required/enum/format constraints are left intact so a
 * genuinely malformed request (wrong type, missing field) still 400s.
 */
function stripValueRanges(schema: JsonObject): JsonObject {
  const strip = (node: JsonValue): JsonValue => {
    if (Array.isArray(node)) return node.map(strip);
    if (node === null || typeof node !== 'object') return node;
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(node)) {
      if (VALUE_RANGE_KEYWORDS.has(key)) continue;
      out[key] = strip(value);
    }
    return out;
  };
  return strip(schema) as JsonObject;
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

/**
 * Create a ContractValidator backed by the given OpenAPI document and boundary configs.
 */
export function createContractValidator(
  doc: OpenApiDoc,
  _boundaries: readonly BoundaryConfig[],
  cacheOptions?: ContractValidatorCacheOptions,
): ContractValidator {
  const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
  addFormats(ajv);

  // F-02: Build a case-insensitive lookup map for components.schemas at construction time.
  // Keys are lowercased; values are the original schema objects. This allows boundary names
  // that differ in casing (e.g. "opportunity" vs "Opportunity") to still resolve correctly.
  const caseInsensitiveSchemaMap = new Map<string, unknown>();
  const rawDocForInit = doc.raw as Record<string, unknown>;
  const componentsForInit = rawDocForInit['components'];
  if (componentsForInit && typeof componentsForInit === 'object' && !Array.isArray(componentsForInit)) {
    const schemasForInit = (componentsForInit as Record<string, unknown>)['schemas'];
    if (schemasForInit && typeof schemasForInit === 'object' && !Array.isArray(schemasForInit)) {
      for (const [key, val] of Object.entries(schemasForInit as Record<string, unknown>)) {
        caseInsensitiveSchemaMap.set(key.toLowerCase(), val);
      }
    }
  }

  const maxKeyedValidators = cacheOptions?.maxKeyedValidators ?? 512;

  // Cache compiled validators by schema object reference (using WeakMap) and
  // by a serialized JSON key (using Map) for primitive-keyed lookups.
  // The WeakMap is the fast, identity-keyed primary cache (GC'd automatically).
  // The Map is bounded to maxKeyedValidators entries; the oldest entry is evicted
  // when the cap is reached (Map iteration order is insertion order).
  const validatorCache = new WeakMap<object, ValidateFunction>();
  const validatorCacheByKey = new Map<string, ValidateFunction>();

  function getValidator(schema: JsonObject): ValidateFunction {
    // Use WeakMap first (identity-based, zero-cost for repeated calls)
    const cached = validatorCache.get(schema);
    if (cached) return cached;

    // Fall back to JSON serialization key for structurally identical schemas
    const key = JSON.stringify(schema);
    const keyCached = validatorCacheByKey.get(key);
    if (keyCached) {
      validatorCache.set(schema, keyCached);
      return keyCached;
    }

    const compiled = ajv.compile(schema);
    validatorCache.set(schema, compiled);

    // Evict the oldest entry before inserting to keep the map within the cap
    if (validatorCacheByKey.size >= maxKeyedValidators) {
      const oldestKey = validatorCacheByKey.keys().next().value;
      if (oldestKey !== undefined) {
        validatorCacheByKey.delete(oldestKey);
      }
    }
    validatorCacheByKey.set(key, compiled);
    return compiled;
  }

  function coerceParamValue(
    value: string,
    schema: JsonObject | undefined,
  ): unknown {
    /* istanbul ignore next — callers always provide schema (checked before calling) */
    if (!schema) return value;
    const t = schema['type'];
    if (t === 'number' || t === 'integer') {
      const n = Number(value);
      if (!Number.isNaN(n)) return n;
    }
    return value;
  }

  function validateRequest(
    method: string,
    path: string,
    payload: JsonValue,
    queryParams: Record<string, string | string[]>,
    pathParams: Record<string, string>,
  ): void {
    const matched = matchRoute(doc, method, path);
    if (!matched) {
      throw new ContractViolationError(`No route matches ${method} ${path}`);
    }

    const { operation } = matched;

    // Validate parameters (path + query)
    if (operation.parameters) {
      for (const param of operation.parameters) {
        if (param.in === 'path') {
          const rawValue = pathParams[param.name];
          if (rawValue === undefined) {
            if (param.required) {
              throw new ContractViolationError(
                `Missing required path parameter: ${param.name}`,
              );
            }
            continue;
          }
          if (param.schema) {
            const coerced = coerceParamValue(rawValue, param.schema);
            const validate = getValidator(param.schema);
            if (!validate(coerced)) {
              logger.debug(
                { param: param.name, errors: validate.errors },
                'Path parameter validation failed',
              );
              throw new ContractViolationError(
                `Path parameter '${param.name}' failed validation`,
                { errors: validate.errors as JsonValue },
              );
            }
          }
        } else if (param.in === 'query') {
          const rawValue = queryParams[param.name];
          if (rawValue === undefined) {
            if (param.required) {
              throw new ContractViolationError(
                `Missing required query parameter: ${param.name}`,
              );
            }
            continue;
          }
          if (param.schema) {
            const valueToValidate = Array.isArray(rawValue) ? rawValue[0] : rawValue;
            const coerced = coerceParamValue(valueToValidate, param.schema);
            // Pagination/range query params (offset, limit, …) carry value-range
            // bounds the query engine clamps at runtime; validate the type only.
            const validate = getValidator(stripValueRanges(param.schema));
            if (!validate(coerced)) {
              logger.debug(
                { param: param.name, errors: validate.errors },
                'Query parameter validation failed',
              );
              throw new ContractViolationError(
                `Query parameter '${param.name}' failed validation`,
                { errors: validate.errors as JsonValue },
              );
            }
          }
        }
      }
    }

    // Validate request body — shape only. Numeric value-range bounds are stripped
    // so a right-typed but out-of-range value (e.g. dailyCallQuota: 0 against
    // minimum: 1) reaches the engine and trips the DSL `requires` guard (422)
    // instead of being pre-empted by a 400. Type/required/enum/format/length
    // constraints remain, so genuinely malformed bodies still 400.
    if (operation.requestBodySchema) {
      const validate = getValidator(stripValueRanges(operation.requestBodySchema));
      if (!validate(payload)) {
        logger.debug({ errors: validate.errors }, 'Request body validation failed');
        throw new ContractViolationError(
          `Request body failed contract validation for ${method} ${path}`,
          { errors: validate.errors as JsonValue },
        );
      }
    }
  }

  function validateResponse(
    method: string,
    path: string,
    status: number,
    body: JsonValue,
    options?: { readonly allowAdditionalProperties?: boolean },
  ): void {
    const matched = matchRoute(doc, method, path);
    if (!matched) {
      throw new InternalExecutionError(
        `Response failed contract validation: no route matches ${method} ${path}`,
      );
    }

    const { operation } = matched;
    const responseSchemas = operation.responseSchemas;
    if (!responseSchemas) return;

    // Look up by exact status, then fall back to 'default'
    const schema =
      responseSchemas[String(status)] ??
      responseSchemas['default'];

    if (!schema) return;

    // X-Potemkin-Allow-Additional-Properties (admin-gated): relax the schema so a
    // response carrying undeclared properties still validates. We strip every
    // `additionalProperties: false` (and `unevaluatedProperties: false`) recursively
    // from a deep copy so the cached strict validator is never mutated.
    const effectiveSchema = options?.allowAdditionalProperties === true
      ? relaxAdditionalProperties(schema)
      : schema;

    const validate = getValidator(effectiveSchema);
    if (!validate(body)) {
      logger.debug(
        { method, path, status, errors: validate.errors },
        'Response body validation failed',
      );
      throw new InternalExecutionError(
        'Response failed contract validation',
        { errors: validate.errors as JsonValue },
      );
    }
  }

  function validateEntity(boundary: string, entity: JsonObject): void {
    const tracer = getTracer('contract');
    tracer.startActiveSpan('contract.validateEntity', (span) => {
      try {
        const rawDoc = doc.raw as Record<string, unknown>;
        const components = rawDoc['components'];
        if (!components || typeof components !== 'object' || Array.isArray(components)) {
          throw new InternalExecutionError('Entity violates contract', {
            boundary,
            errors: `No components section in OpenAPI document` as unknown as JsonValue,
          });
        }
        const schemas = (components as Record<string, unknown>)['schemas'];
        if (!schemas || typeof schemas !== 'object' || Array.isArray(schemas)) {
          throw new InternalExecutionError('Entity violates contract', {
            boundary,
            errors: `No components.schemas section in OpenAPI document` as unknown as JsonValue,
          });
        }
        // F-02: Try exact-case lookup first; fall back to case-insensitive map.
        const schema =
          (schemas as Record<string, unknown>)[boundary] ??
          caseInsensitiveSchemaMap.get(boundary.toLowerCase());
        if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
          throw new InternalExecutionError('Entity violates contract', {
            boundary,
            errors: `No schema found for boundary '${boundary}'` as unknown as JsonValue,
          });
        }

        const validate = getValidator(schema as JsonObject);
        if (!validate(entity)) {
          logger.debug(
            { boundary, errors: validate.errors },
            'Entity validation failed',
          );
          throw new InternalExecutionError('Entity violates contract', {
            boundary,
            errors: validate.errors as JsonValue,
          });
        }
      } finally {
        span.end();
      }
    });
  }

  return {
    validateRequest,
    validateResponse,
    validateEntity,
  };
}
