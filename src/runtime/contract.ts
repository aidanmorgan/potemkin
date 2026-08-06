import { lookupOperationId, type OpenApiDoc } from '../contract/loader.js';
import { matchRoute } from '../contract/router.js';
import { createContractValidator, type ContractValidator } from '../contract/validator.js';
import { responseSupportsHateoas } from '../contract/hateoas.js';
import { buildContractErrorBody, validateContractErrorBody } from '../contract/errorBody.js';
import type { RuntimeContract, RuntimeRequest } from '../model/runtime.js';
import { isJsonObject, type JsonObject, type JsonValue } from '../contracts/value.js';
import { InternalExecutionError } from '../errors.js';
import {
  HttpMethod,
  OperationId,
  type BoundaryName,
  type EventType,
  type SchemaReference,
} from '../domain/references.js';

export interface ContractBindingOptions {
  readonly now?: () => string;
  readonly codeMap?: Readonly<Record<string, string>>;
}

interface OperationRoute {
  readonly operationId: OperationId;
  readonly method: HttpMethod;
  readonly path: string;
}

function parseHttpMethod(value: string): HttpMethod | undefined {
  try {
    return HttpMethod.parse(value);
  } catch {
    return undefined;
  }
}

function inputOperation(doc: OpenApiDoc, path: string, method: HttpMethod) {
  return doc.paths[path]?.[method.toLowerCase()];
}

function operationRoutes(doc: OpenApiDoc): ReadonlyMap<string, OperationRoute> {
  const routes = new Map<string, OperationRoute>();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [rawMethod, operation] of Object.entries(item)) {
      const method = parseHttpMethod(rawMethod);
      if (method === undefined || operation?.operationId === undefined) continue;
      const operationId = OperationId.parse(operation.operationId);
      routes.set(operationId, { operationId, method, path });
    }
  }
  return routes;
}

function requestRoute(
  doc: OpenApiDoc,
  routes: ReadonlyMap<string, OperationRoute>,
  operation: OperationId,
  request?: Readonly<RuntimeRequest>,
) {
  const route = routes.get(operation);
  if (route === undefined) return undefined;
  const requestMatch =
    request === undefined
      ? null
      : matchRoute(doc, request.command.httpMethod, request.command.path);
  const matched =
    request === undefined
      ? matchRoute(doc, route.method, route.path)
      : (requestMatch ?? matchRoute(doc, route.method, request.command.path));
  return {
    method:
      matched === null || requestMatch === null
        ? route.method
        : (request?.command.httpMethod ?? route.method),
    path: matched === null ? route.path : (request?.command.path ?? route.path),
    pathParams: matched?.pathParams ?? {},
  };
}

function responseStatusFor(
  doc: OpenApiDoc,
  routes: ReadonlyMap<string, OperationRoute>,
  operationId: OperationId,
  intent: RuntimeRequest['command']['intent'],
): number | undefined {
  const route = routes.get(operationId);
  if (route === undefined) return undefined;
  const operation = inputOperation(doc, route.path, route.method);
  const statuses = Object.keys(operation?.responseSchemas ?? {})
    .map(Number)
    .filter((status) => Number.isInteger(status) && status >= 200 && status < 300)
    .sort((left, right) => left - right);
  if (statuses.length === 0) return undefined;
  if (intent === 'creation' && statuses.includes(201)) return 201;
  if (statuses.includes(200)) return 200;
  return statuses[0];
}

function shapeError(
  doc: OpenApiDoc,
  routes: ReadonlyMap<string, OperationRoute>,
  options: ContractBindingOptions,
  operationId: OperationId,
  status: number,
  body: JsonValue,
): JsonValue | undefined {
  const route = routes.get(operationId);
  if (route === undefined) return undefined;
  const candidate = isJsonObject(body) ? body : {};
  if (validateContractErrorBody(doc, route.method, route.path, status, body).valid) return body;
  const code =
    typeof candidate['code'] === 'string'
      ? candidate['code']
      : typeof candidate['error'] === 'string'
        ? candidate['error']
        : undefined;
  return buildContractErrorBody(
    doc,
    route.method,
    route.path,
    status,
    {
      code,
      message: typeof candidate['message'] === 'string' ? candidate['message'] : undefined,
      details:
        candidate['details'] ??
        (code === undefined
          ? undefined
          : {
              code,
            }),
    },
    {
      ...(options.codeMap === undefined ? {} : { codeMap: options.codeMap }),
      ...(options.now === undefined ? {} : { now: options.now }),
    },
  );
}

export function createRuntimeContract(
  doc: OpenApiDoc,
  validator: ContractValidator,
  options: ContractBindingOptions = {},
): RuntimeContract {
  const routes = operationRoutes(doc);
  return {
    operationIdFor: (path: string, method: string) => {
      const matched = matchRoute(doc, method, path);
      const rawOperationId = matched?.operation.operationId ?? lookupOperationId(doc, path, method);
      if (rawOperationId === undefined) return undefined;
      return routes.get(rawOperationId)?.operationId ?? OperationId.parse(rawOperationId);
    },
    responseStatusFor: (operation, intent) => responseStatusFor(doc, routes, operation, intent),
    pathForOperation: (operation, targetId) => {
      const route = routes.get(operation);
      if (route === undefined) return undefined;
      if (targetId === undefined || targetId === null) return route.path;
      return route.path.replace(/\{[^}]+\}/g, encodeURIComponent(targetId));
    },
    validateRequest: (operation, payload, request) => {
      const resolved = requestRoute(doc, routes, operation, request);
      if (resolved === undefined) return;
      const validate =
        request?.batchItem === undefined
          ? validator.validateRequest
          : validator.validateRequestItem;
      validate(
        resolved.method,
        resolved.path,
        payload,
        request?.command.queryParams ?? {},
        resolved.pathParams,
        request?.headers,
      );
    },
    validateBatchRequest: (operation, payload, request) => {
      const resolved = requestRoute(doc, routes, operation, request);
      if (resolved === undefined) return;
      validator.validateRequestBatch(
        resolved.method,
        resolved.path,
        payload,
        request?.command.queryParams ?? {},
        resolved.pathParams,
        request?.headers,
      );
    },
    validateResponse: (operation, status, body, request, validationOptions) => {
      const resolved = requestRoute(doc, routes, operation, request);
      if (resolved === undefined) return;
      const validate =
        request?.batchItem === undefined
          ? validator.validateResponse
          : validator.validateResponseItem;
      validate(resolved.method, resolved.path, status, body, validationOptions);
    },
    validateBatchResponse: (operation, status, body, request, validationOptions) => {
      const resolved = requestRoute(doc, routes, operation, request);
      if (resolved === undefined) return;
      validator.validateResponseBatch(
        resolved.method,
        resolved.path,
        status,
        body,
        validationOptions,
      );
    },
    shapeError: (operation, status, body) =>
      shapeError(doc, routes, options, operation, status, body),
    requiresPrecondition: (operation) => {
      const route = routes.get(operation);
      if (route === undefined) return false;
      return (
        inputOperation(doc, route.path, route.method)?.parameters?.some(
          (parameter) =>
            parameter.in === 'header' &&
            parameter.name.toLowerCase() === 'if-match' &&
            parameter.required === true,
        ) ?? false
      );
    },
    validateEvent: (_boundary: BoundaryName, _eventType: EventType, payload, schemaRef) => {
      if (schemaRef === undefined) return;
      try {
        validator.validateSchema(schemaRef, payload);
      } catch (error) {
        if (error instanceof InternalExecutionError) throw error;
        throw new InternalExecutionError('Event payload failed schema validation', {
          code: 'SCHEMA_TYPE_MISMATCH',
          error: String(error),
        });
      }
    },
    validateEntity: (boundary: BoundaryName | SchemaReference, entity: JsonObject) => {
      try {
        validator.validateEntity(boundary, entity);
      } catch (error) {
        const details = error instanceof InternalExecutionError ? error.details : undefined;
        const errors = isJsonObject(details) ? details.errors : undefined;
        if (errors === `No schema found for boundary '${boundary}'`) return;
        throw error;
      }
    },
    responseSupportsHateoas: (operation, status, body) => {
      const route = routes.get(operation);
      const definition =
        route === undefined ? undefined : inputOperation(doc, route.path, route.method);
      return responseSupportsHateoas(definition, status, body);
    },
    responseAllowsPaginationEnvelope: () => true,
  };
}

export function createContractValidatorForRuntime(doc: OpenApiDoc): ContractValidator {
  return createContractValidator(doc, []);
}
