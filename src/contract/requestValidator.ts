import type { ValidateFunction } from 'ajv';
import { isJsonObject, isJsonValue, type JsonObject, type JsonValue } from '../contracts/value.js';
import type { OpenApiDoc } from './loader.js';
import { ContractViolationError } from '../errors.js';
import { matchRoute } from './router.js';
import type { Logger } from '../observability/logger.js';
import { normalizeEntityTag } from '../http/entityTag.js';

export type RequestHeaders = Readonly<Record<string, string | string[] | undefined>>;

export interface RequestValidator {
  readonly validateRequest: (
    method: string,
    path: string,
    payload: JsonValue,
    queryParams: Record<string, string | string[]>,
    pathParams: Record<string, string>,
    headers?: RequestHeaders,
  ) => void;
  readonly validateRequestBatch: RequestValidator['validateRequest'];
  readonly validateRequestItem: RequestValidator['validateRequest'];
}

interface RequestValidatorDependencies {
  readonly doc: OpenApiDoc;
  readonly getValidator: (schema: JsonObject) => ValidateFunction;
  readonly logger: Logger;
}

type ValidationMode = 'full' | 'batch' | 'batch-item';

function coerceParamValue(value: string, schema: JsonObject | undefined): unknown {
  if (schema === undefined) return value;
  const type = schema['type'];
  if (type === 'number' || type === 'integer') {
    const number = Number(value);
    if (!Number.isNaN(number)) return number;
  }
  return value;
}

function validateParameter(
  parameter: NonNullable<
    NonNullable<ReturnType<typeof matchRoute>>['operation']['parameters']
  >[number],
  rawValue: string | string[] | undefined,
  getValidator: RequestValidatorDependencies['getValidator'],
  logger: Logger,
): void {
  if (rawValue === undefined) {
    if (parameter.required) {
      throw new ContractViolationError(
        `Missing required ${parameter.in} parameter: ${parameter.name}`,
      );
    }
    return;
  }
  if (parameter.schema === undefined) return;

  const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
  const normalizedValue =
    parameter.in === 'header' && parameter.name.toLowerCase() === 'if-match'
      ? value === undefined
        ? undefined
        : normalizeEntityTag(value)
      : value;
  const coerced = coerceParamValue(normalizedValue ?? '', parameter.schema);
  const validate = getValidator(parameter.schema);
  if (validate(coerced)) return;

  logger.debug(
    { param: parameter.name, errors: validate.errors },
    `${parameter.in[0]?.toUpperCase()}${parameter.in.slice(1)} parameter validation failed`,
  );
  throw new ContractViolationError(
    `${parameter.in[0]?.toUpperCase()}${parameter.in.slice(1)} parameter '${parameter.name}' failed validation`,
    { errors: validationErrors(validate.errors) },
  );
}

function validateParameters(
  operation: NonNullable<ReturnType<typeof matchRoute>>['operation'],
  queryParams: Record<string, string | string[]>,
  pathParams: Record<string, string>,
  headers: RequestHeaders,
  getValidator: RequestValidatorDependencies['getValidator'],
  logger: Logger,
): void {
  for (const parameter of operation.parameters ?? []) {
    const rawValue =
      parameter.in === 'path'
        ? pathParams[parameter.name]
        : parameter.in === 'query'
          ? queryParams[parameter.name]
          : Object.entries(headers).find(
              ([name]) => name.toLowerCase() === parameter.name.toLowerCase(),
            )?.[1];
    validateParameter(parameter, rawValue, getValidator, logger);
  }
}

function validateBody(
  operation: NonNullable<ReturnType<typeof matchRoute>>['operation'],
  payload: JsonValue,
  mode: ValidationMode,
  getValidator: RequestValidatorDependencies['getValidator'],
  logger: Logger,
  method: string,
  path: string,
  formEncoded: boolean,
): void {
  const schema = operation.requestBodySchema;
  if (schema === undefined || (mode === 'batch' && schema.type !== 'array')) return;
  if (formEncoded) coerceFormPayload(payload, schema);
  const itemSchema =
    mode === 'batch-item' && schema.type === 'array' ? asSchema(schema.items) : schema;
  if (itemSchema === undefined) return;

  const validate = getValidator(itemSchema);
  if (validate(payload)) return;
  logger.debug({ errors: validate.errors }, 'Request body validation failed');
  throw new ContractViolationError(
    `Request body failed contract validation for ${method} ${path}`,
    {
      errors: validationErrors(validate.errors),
    },
  );
}

function validateRequestWithMode(
  dependencies: RequestValidatorDependencies,
  method: string,
  path: string,
  payload: JsonValue,
  queryParams: Record<string, string | string[]>,
  pathParams: Record<string, string>,
  headers: RequestHeaders,
  mode: ValidationMode,
): void {
  const matched = matchRoute(dependencies.doc, method, path);
  if (matched === null) throw new ContractViolationError(`No route matches ${method} ${path}`);
  validateParameters(
    matched.operation,
    queryParams,
    pathParams,
    headers,
    dependencies.getValidator,
    dependencies.logger,
  );
  validateBody(
    matched.operation,
    payload,
    mode,
    dependencies.getValidator,
    dependencies.logger,
    method,
    path,
    isFormEncoded(headers),
  );
}

function isFormEncoded(headers: RequestHeaders): boolean {
  const contentType = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === 'content-type',
  )?.[1];
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  return (
    typeof value === 'string' &&
    /^(application\/x-www-form-urlencoded|multipart\/form-data)/i.test(value)
  );
}

/** Form transports carry primitive values as strings; normalize them before the
 * source-independent engine sees the command. JSON transports remain strict. */
function coerceFormPayload(payload: JsonValue, schema: JsonObject): void {
  if (Array.isArray(payload)) {
    const itemSchema = asSchema(schema['items']);
    if (itemSchema !== undefined) for (const item of payload) coerceFormPayload(item, itemSchema);
    return;
  }
  if (!isJsonObject(payload)) return;
  const properties = schemaProperties(schema);
  for (const [key, value] of Object.entries(payload)) {
    const fieldSchema = properties[key];
    if (fieldSchema === undefined) continue;
    const normalized = coerceFormValue(value, fieldSchema);
    if (normalized !== value) payload[key] = normalized;
  }
}

function coerceFormValue(value: JsonValue, schema: JsonObject): JsonValue {
  const selected = selectSchema(value, schema);
  const type = selected['type'];
  if (typeof value === 'string' && type === 'boolean') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  if (typeof value === 'string' && (type === 'integer' || type === 'number')) {
    const number = Number(value);
    if (Number.isFinite(number) && (type !== 'integer' || Number.isInteger(number))) return number;
  }
  if (value !== null && typeof value === 'object') coerceFormPayload(value, selected);
  return value;
}

function selectSchema(value: JsonValue, schema: JsonObject): JsonObject {
  const branches = [schema['anyOf'], schema['oneOf']].find(Array.isArray);
  if (branches === undefined) return schema;
  return (
    branches
      .map(asSchema)
      .find(
        (branch): branch is JsonObject => branch !== undefined && matchesSchemaType(value, branch),
      ) ?? schema
  );
}

function schemaProperties(schema: JsonObject): Record<string, JsonObject> {
  const properties = schema['properties'];
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return {};
  return Object.fromEntries(
    Object.entries(properties).flatMap(([key, value]) => {
      const child = asSchema(value);
      return child === undefined ? [] : [[key, child]];
    }),
  );
}

function asSchema(value: unknown): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function validationErrors(errors: ValidateFunction['errors']): JsonValue {
  const candidate: unknown = errors ?? [];
  return isJsonValue(candidate) ? candidate : [];
}

function matchesSchemaType(value: JsonValue, schema: JsonObject): boolean {
  const type = schema['type'];
  if (type === 'object') return isJsonObject(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'boolean')
    return typeof value === 'boolean' || value === 'true' || value === 'false';
  if (type === 'integer' || type === 'number')
    return typeof value === 'number' || /^-?\d+(\.\d+)?$/.test(String(value));
  if (type === 'string') return typeof value === 'string';
  return true;
}

export function createRequestValidator(
  dependencies: RequestValidatorDependencies,
): RequestValidator {
  const validate = (
    method: string,
    path: string,
    payload: JsonValue,
    queryParams: Record<string, string | string[]>,
    pathParams: Record<string, string>,
    headers: RequestHeaders = {},
    mode: ValidationMode = 'full',
  ): void => {
    validateRequestWithMode(
      dependencies,
      method,
      path,
      payload,
      queryParams,
      pathParams,
      headers,
      mode,
    );
  };

  return {
    validateRequest: (...args) => validate(...args),
    validateRequestBatch: (method, path, payload, queryParams, pathParams, headers = {}) =>
      validate(method, path, payload, queryParams, pathParams, headers, 'batch'),
    validateRequestItem: (method, path, payload, queryParams, pathParams, headers = {}) =>
      validate(method, path, payload, queryParams, pathParams, headers, 'batch-item'),
  };
}
