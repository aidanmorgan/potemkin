import request from 'supertest';
import { matchRoute } from '../contract/router.js';
import type { RuntimeBoundary } from '../model/runtime.js';
import type { RuntimeSystem } from '../runtime/system.js';
import { isJsonObject, isJsonValue, type JsonObject, type JsonValue } from '../contracts/value.js';
import {
  AggregateId,
  BoundaryName,
  EventId,
  EventType,
  SequenceVersion,
} from '../domain/references.js';
import {
  isFormOperation,
  operationRequest,
  requestBody,
  routesFor,
  type OperationRoute,
  type ExportRequestTarget,
} from './transition-examples.js';
import type { ExportExample } from './exportContracts.js';

interface SeedExample {
  readonly example: ExportExample;
  readonly boundary: RuntimeBoundary;
  readonly id: string;
  readonly state: JsonObject;
}

const VOLATILE_HEADERS = new Set([
  'connection',
  'content-length',
  'date',
  'etag',
  'keep-alive',
  'transfer-encoding',
  'x-powered-by',
]);

function jsonObject(value: unknown): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'example';
}

function responseHeaders(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): Record<string, string> {
  const stable: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)
    .filter(([headerName]) => !VOLATILE_HEADERS.has(headerName.toLowerCase()))
    .sort(([left], [right]) => left.localeCompare(right))) {
    stable[name.toLowerCase()] =
      typeof value === 'string' ? value : value === undefined ? '' : [...value].join(', ');
  }
  return stable;
}

function example(
  name: string,
  method: string,
  path: string,
  response: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
    readonly body: unknown;
  },
  request?: Readonly<{
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: JsonValue;
  }>,
): ExportExample {
  return {
    name,
    httpRequest: {
      method,
      path,
      ...(request?.headers === undefined ? {} : { headers: { ...request.headers } }),
      ...(request?.body === undefined ? {} : { body: request.body }),
    },
    httpResponse: {
      status: response.status,
      headers: responseHeaders(response.headers),
      body: response.body === undefined || !isJsonValue(response.body) ? null : response.body,
    },
  };
}

function collectionBoundaryForRoute(
  system: RuntimeSystem,
  contractPath: string,
): RuntimeBoundary | undefined {
  return [...system.program.boundaries]
    .filter(
      (candidate) =>
        !candidate.contractPath.includes('{') &&
        contractPath.startsWith(`${candidate.contractPath}/`),
    )
    .sort((left, right) => right.contractPath.length - left.contractPath.length)[0];
}

function pathParameterNames(pathTemplate: string): readonly string[] {
  return [...pathTemplate.matchAll(/\{([^}]+)\}/g)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
}

function parameterSchema(route: OperationRoute, name: string): JsonObject | undefined {
  return route.operation.parameters?.find(
    (parameter) => parameter.in === 'path' && parameter.name === name,
  )?.schema;
}

function sentinelFor(route: OperationRoute, name: string): string {
  const schema = parameterSchema(route, name);
  if (schema?.format === 'uuid') return '00000000-0000-7000-8000-000000000404';
  if (schema?.type === 'integer' || schema?.type === 'number') return '404404';
  const pattern = schema?.pattern;
  const prefix = typeof pattern === 'string' ? /^\^([A-Za-z]+_)/.exec(pattern)?.[1] : undefined;
  return `${prefix ?? 'potemkin-'}not-found-404`;
}

function concretePath(route: OperationRoute, valueFor: (name: string) => string): string {
  return route.path.replace(/\{([^}]+)\}/g, (_match, name: string) =>
    encodeURIComponent(valueFor(name)),
  );
}

function seedExamples(
  system: RuntimeSystem,
  examples: readonly ExportExample[],
): readonly SeedExample[] {
  const result: SeedExample[] = [];
  for (const candidate of examples) {
    // Tier-2 examples have a state segment between the boundary and GET. Tier-1
    // baseline examples intentionally remain available only as a fallback.
    const matched = matchRoute(
      system.openapi,
      candidate.httpRequest.method,
      candidate.httpRequest.path,
    );
    if (matched === null || matched.operation.operationId === undefined) continue;
    const boundary = collectionBoundaryForRoute(system, matched.contractPath);
    const state = jsonObject(candidate.httpResponse.body);
    const id = Object.values(matched.pathParams)[0];
    if (boundary === undefined || state === undefined || id === undefined) continue;
    result.push({ example: candidate, boundary, id, state });
  }
  return result.sort((left, right) => left.example.name.localeCompare(right.example.name));
}

function restoreSeed(system: RuntimeSystem, seed: SeedExample, route: OperationRoute): void {
  const baseline = system.engine.snapshot();
  const seedEvent = {
    eventId: EventId.parse(`tier3-seed-${route.operation.operationId ?? route.path}-${seed.id}`),
    type: EventType.parse('BaselineEntityCreatedEvent'),
    boundary: BoundaryName.parse(seed.boundary.boundary),
    aggregateId: AggregateId.parse(seed.id),
    payload: seed.state,
    timestamp: new Date(system.clock.nowMs()).toISOString(),
    sequenceVersion: SequenceVersion.parse(1),
    causedBy: null,
  } as const;
  system.engine.restore({
    state: [...baseline.state.filter(([id]) => id !== seed.id), [seed.id, seed.state]],
    events: [...baseline.events.filter((event) => event.aggregateId !== seed.id), seedEvent],
    projections: baseline.projections,
  });
}

function headersFor(route: OperationRoute): Readonly<Record<string, string>> | undefined {
  const requiresIfMatch = route.operation.parameters?.some(
    (parameter) =>
      parameter.in === 'header' &&
      parameter.name.toLowerCase() === 'if-match' &&
      parameter.required === true,
  );
  return requiresIfMatch ? { 'If-Match': '1' } : undefined;
}

function requestHeadersFor(route: OperationRoute): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {
    'content-type': route.form === true ? 'application/x-www-form-urlencoded' : 'application/json',
  };
  const authoredHeaders = headersFor(route);
  if (authoredHeaders !== undefined) Object.assign(headers, authoredHeaders);
  return headers;
}

function requestExample(
  route: OperationRoute,
  body?: JsonValue,
): { readonly headers?: Readonly<Record<string, string>>; readonly body?: JsonValue } {
  const result: { headers?: Readonly<Record<string, string>>; body?: JsonValue } = {};
  const headers = headersFor(route);
  if (headers !== undefined) result.headers = headers;
  if (body !== undefined) result.body = body;
  return result;
}

async function collect404Examples(
  routes: readonly OperationRoute[],
  app: ExportRequestTarget,
): Promise<readonly ExportExample[]> {
  const result: ExportExample[] = [];
  for (const route of routes) {
    if (route.operation.responseSchemas?.['404'] === undefined) continue;
    const names = pathParameterNames(route.path);
    if (names.length === 0) continue;
    const path = concretePath(route, (name) => sentinelFor(route, name));
    const requestRoute = { ...route, path, headers: requestHeadersFor(route) };
    const hasRequestBody = route.operation.requestBodySchema !== undefined;
    const response =
      route.method === 'GET'
        ? await request(app).get(path)
        : await operationRequest(app, requestRoute, hasRequestBody ? requestBody(route, 0) : {});
    if (response.status !== 404) {
      console.warn(
        `Declared-error export coverage: unable to reach 404 for ${route.operation.operationId ?? route.path} ${path}; skipped`,
      );
      continue;
    }
    result.push(
      example(
        `${safeName(route.operation.operationId ?? route.path)}__404__${safeName(path)}`,
        route.method,
        path,
        response,
        route.method === 'GET'
          ? undefined
          : requestExample(route, hasRequestBody ? requestBody(route, 0) : undefined),
      ),
    );
  }
  return result;
}

async function collect422Examples(
  system: RuntimeSystem,
  routes: readonly OperationRoute[],
  seeds: readonly SeedExample[],
  app: ExportRequestTarget,
): Promise<readonly ExportExample[]> {
  const result: ExportExample[] = [];
  for (const route of routes) {
    if (route.method === 'GET' || route.operation.responseSchemas?.['422'] === undefined) continue;
    if (pathParameterNames(route.path).length === 0) {
      console.warn(
        `Declared-error export coverage: ${route.operation.operationId ?? route.path} has no target parameter for a state-dependent 422; skipped`,
      );
      continue;
    }
    const boundary = collectionBoundaryForRoute(system, route.path);
    if (boundary === undefined) {
      console.warn(
        `Declared-error export coverage: no runtime boundary for ${route.operation.operationId ?? route.path}; skipped 422`,
      );
      continue;
    }
    const candidates = seeds.filter((seed) => seed.boundary.boundary === boundary.boundary);
    let captured = false;
    for (const seed of candidates) {
      await system.engine.reset();
      restoreSeed(system, seed, route);
      const path = concretePath(route, () => seed.id);
      const requestRoute: OperationRoute = {
        ...route,
        path,
        form: isFormOperation(system.openapi, route),
        headers: requestHeadersFor(route),
      };
      const body = requestBody(route, 0);
      const response = await operationRequest(app, requestRoute, body);
      if (response.status !== 422) continue;
      result.push(
        example(
          `${safeName(route.operation.operationId ?? route.path)}__422__${safeName(path)}`,
          route.method,
          path,
          response,
          requestExample(route, body),
        ),
      );
      captured = true;
      break;
    }
    if (!captured) {
      console.warn(
        `Declared-error export coverage: unable to reach 422 for ${route.operation.operationId ?? route.path} against a pre-seeded entity; skipped`,
      );
    }
  }
  return result;
}

/**
 * Collect only contract-declared error pins. The 404 strategy is stateless;
 * the 422 strategy reuses successful Tier-2 snapshots as committed seed state.
 */
export async function collectDeclaredErrorExamples(
  system: RuntimeSystem,
  seededExamples: readonly ExportExample[],
  app: ExportRequestTarget,
): Promise<readonly ExportExample[]> {
  await system.engine.reset();
  const routes = routesFor(system.openapi);
  const seeds = seedExamples(system, seededExamples);
  const missing = await collect404Examples(routes, app);
  const invalid = await collect422Examples(system, routes, seeds, app);
  return [...missing, ...invalid].sort((left, right) => left.name.localeCompare(right.name));
}
