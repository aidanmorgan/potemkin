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
   * @throws {InternalExecutionError} (500) on failure.
   */
  validateResponse(
    method: string,
    path: string,
    status: number,
    body: JsonValue,
  ): void;

  /**
   * Validate a state-graph entity against the schema for its boundary.
   * @throws {InternalExecutionError} (500) on failure.
   */
  validateEntity(boundary: string, entity: JsonObject): void;
}

const logger = createLogger({ name: 'contract.validator' });

/**
 * Create a ContractValidator backed by the given OpenAPI document and boundary configs.
 */
export function createContractValidator(
  doc: OpenApiDoc,
  _boundaries: readonly BoundaryConfig[],
): ContractValidator {
  const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
  addFormats(ajv);

  // Cache compiled validators by schema object reference (using WeakMap) and
  // by a serialized JSON key (using Map) for primitive-keyed lookups.
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
            const validate = getValidator(param.schema);
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

    // Validate request body
    if (operation.requestBodySchema) {
      const validate = getValidator(operation.requestBodySchema);
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

    const validate = getValidator(schema);
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
        const schema = (schemas as Record<string, unknown>)[boundary];
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
