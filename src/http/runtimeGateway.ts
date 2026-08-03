import express, { type Express, type NextFunction, type Request, type Response } from "express";
import bodyParser from "body-parser";
import { createHash } from "node:crypto";
import type { RuntimeSystem } from "../runtime/system.js";
import { RuntimeExecutionError } from "../core/errors.js";
import { normalizeEntityTag, parseEntityTagVersion } from "./entityTag.js";
import {
  type RuntimeBoundary,
  type RuntimeControls,
  type RuntimeRequest,
} from "../model/runtime.js";
import type { Actor, Command, JsonObject, JsonValue } from "../types.js";
import { applyPatches, diffJsonJournal, type JournalEntry, type Patch } from "../model/patches.js";
import { applyResponseFormat, compileMaskValuePatches } from "../core/responsePolicies.js";
import { matchRoute, resolveVersion } from "../contract/router.js";
import { parseControlHeaders } from "./controlHeaders.js";
import { controlsFromHeaders, controlsOf } from "./runtimeControls.js";
import { getAllowedOrigin, isOriginAdmitted, type AllowedOrigins } from "./cors.js";
import { POTEMKIN_REQUEST_HEADERS } from "./potemkinHeaders.js";
import {
  validateForwardedRequest,
  type ForwardedRequest,
  type ForwardedResponse,
  type FixturesResponse,
  type RoutesDiscoveryResponse,
} from "./specmaticTransport.js";
import { deriveRuntimeFixtures } from "./runtimeFixtures.js";
import {
  captureParsedRequestBody,
  headersOf,
  installRuntimeObservation,
  queryOf,
  type RuntimeTransportRequestInput,
} from "./runtimeObservation.js";
import { registerRuntimeAdminRoutes } from "./runtimeAdminRoutes.js";
import type { RuntimeGatewayExtensions } from "./runtimeGatewayTypes.js";

export type RuntimeExpressApp = Express;

/** The version is only transport metadata; the runtime has no package-loader dependency. */
const DEFAULT_ROUTES_TTL_SECONDS = 30;

interface RuntimeConfigurationResponse {
  readonly engine: "potemkin-stateful";
  readonly version: string;
  readonly potemkin: unknown;
  readonly pluginMetadata?: unknown;
}

function runtimeConfigurationResponse(
  version: string,
  potemkin: unknown,
  pluginMetadata: unknown,
): RuntimeConfigurationResponse {
  return {
    engine: "potemkin-stateful",
    version,
    potemkin,
    ...(pluginMetadata === undefined ? {} : { pluginMetadata }),
  };
}

function lowerCaseHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function routesTtlSeconds(extensions: RuntimeGatewayExtensions): number {
  const value = extensions.routesTtlSeconds;
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_ROUTES_TTL_SECONDS;
}

function stripEtag(value: string): string {
  return normalizeEntityTag(value);
}

function hasMatchingEtag(request: Request, value: string): boolean {
  const header = request.headers["if-none-match"];
  const candidates: string[] = Array.isArray(header)
    ? header.map(String)
    : header === undefined
      ? []
      : [header];
  return candidates.some((candidate) =>
    candidate.split(",").some((item: string) => stripEtag(item) === value),
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function routesProjection(
  system: RuntimeSystem,
  extensions: RuntimeGatewayExtensions,
): RoutesDiscoveryResponse & { readonly etag: string } {
  const paths = new Set(system.program.byContractPath.keys());
  const session = system.program.policies.auth?.session;
  if (system.program.policies.auth?.mode === "session" && session !== undefined) {
    paths.add(session.loginPath ?? "/sessions");
    paths.add(session.logoutPath ?? "/sessions/current");
  }
  for (const contractPath of Object.keys(system.openapi.paths)) paths.add(contractPath);
  const versioning = system.program.policies.versioning;
  if (versioning?.enabled && versioning.versions !== undefined) {
    for (const version of versioning.versions) {
      for (const contractPath of Array.from(paths)) {
        paths.add(contractPath === "/" ? version.prefix : `${version.prefix}${contractPath}`);
      }
    }
  }
  const sortedPaths = [...paths].sort();
  const etag = checksum(sortedPaths.join("\n"));
  return {
    paths: sortedPaths,
    engine: "potemkin-stateful",
    version: extensions.version ?? "0.1.0",
    ttlSeconds: routesTtlSeconds(extensions),
    generatedAt: new Date(system.clock.nowMs()).toISOString(),
    checksum: etag,
    etag,
  };
}

function fixturesProjection(
  system: RuntimeSystem,
  extensions: RuntimeGatewayExtensions,
): FixturesResponse & { readonly etag: string } {
  const fixtures = deriveRuntimeFixtures(system);
  const etag = checksum(JSON.stringify(fixtures));
  return {
    engine: "potemkin-stateful",
    version: extensions.version ?? "0.1.0",
    generatedAt: new Date(system.clock.nowMs()).toISOString(),
    checksum: etag,
    fixtures,
    etag,
  };
}

function bodyValue(request: Request): JsonValue {
  const body = request.body as unknown;
  return body === undefined ? {} : (body as JsonValue);
}

function objectBody(body: unknown): JsonObject {
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as JsonObject)
    : {};
}

function actorOverride(raw: string | undefined): Actor | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const separator = raw.indexOf(":");
  const id = (separator < 0 ? raw : raw.slice(0, separator)).trim();
  if (id === "") return undefined;
  const scopes =
    separator < 0
      ? []
      : raw
          .slice(separator + 1)
          .split(",")
          .map((scope) => scope.trim())
          .filter(Boolean);
  return { id, scopes };
}

function intentFor(
  method: string,
  boundary: RuntimeBoundary,
  route?: NonNullable<ReturnType<typeof matchRoute>>,
): Command["intent"] {
  switch (method.toUpperCase()) {
    case "GET":
    case "HEAD":
      return "query";
    case "POST":
      return route?.contractPath === boundary.contractPath &&
        (!boundary.contractPath.includes("{") ||
          route.operation.responseSchemas?.["201"] !== undefined)
        ? "creation"
        : "mutation";
    case "PUT":
    case "PATCH":
    case "DELETE":
      return "mutation";
    default:
      return "mutation";
  }
}

function targetFor(
  boundary: RuntimeBoundary,
  route: NonNullable<ReturnType<typeof matchRoute>>,
  query: Record<string, string | string[]>,
  headers: Record<string, string>,
  body: JsonObject,
): string | null {
  const key = boundary.identity?.key;
  if (key === undefined) return route.pathParams["id"] ?? null;
  const read = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0
      ? value
      : typeof value === "number"
        ? String(value)
        : null;
  if (key.from === "path") return read(route.pathParams[key.name ?? "id"]);
  if (key.from === "header")
    return read(
      Object.entries(headers).find(
        ([name]) => name.toLowerCase() === (key.name ?? key.pointer ?? "").toLowerCase(),
      )?.[1],
    );
  const source = key.from === "query" ? query : body;
  const pointer = key.pointer ?? key.name;
  if (pointer === undefined) return null;
  let current: unknown = source;
  for (const segment of pointer.replace(/^\//, "").split(/[./]/).filter(Boolean)) {
    if (current === null || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return read(Array.isArray(current) ? current[0] : current);
}

function boundaryForRoute(
  system: RuntimeSystem,
  contractPath: string,
): RuntimeBoundary | undefined {
  const exact = system.program.byContractPath.get(contractPath);
  if (exact !== undefined) return exact;
  return [...system.program.boundaries]
    .filter(
      (candidate) =>
        !candidate.contractPath.includes("{") &&
        contractPath.startsWith(`${candidate.contractPath}/`),
    )
    .sort((left, right) => right.contractPath.length - left.contractPath.length)[0];
}

function commandId(system: RuntimeSystem): string {
  return system.program.dependencies.helpers.uuid();
}

function adminControlRequested(headers: Record<string, string | string[] | undefined>): boolean {
  const parsed = parseControlHeaders(headers);
  return (
    parsed.identity.actorOverride !== undefined ||
    parsed.identity.impersonate !== undefined ||
    parsed.validation.skipRequestValidation === true ||
    parsed.validation.skipResponseValidation === true ||
    parsed.validation.allowAdditionalProperties === true
  );
}

function adminControlAllowed(
  system: RuntimeSystem,
  headers: Record<string, string>,
  command: Command,
  adminToken: string | undefined,
): boolean {
  if (adminToken !== undefined) return headers.authorization === `Bearer ${adminToken}`;
  const actor = system.program.policies.auth?.authenticate?.({ command, headers });
  return actor?.scopes.includes("admin") ?? false;
}

function errorDetails(error: unknown): {
  status: number;
  body: JsonValue;
  headers: Record<string, string>;
} {
  if (error instanceof RuntimeExecutionError) {
    const body =
      isJsonObject(error.body) &&
      typeof error.body.code === "string" &&
      error.body.details === undefined
        ? { ...error.body, details: { code: error.body.code } }
        : error.body;
    return { status: error.status, body, headers: { ...error.headers } };
  }
  const candidate = error as {
    readonly status?: unknown;
    readonly body?: unknown;
    readonly code?: unknown;
    readonly message?: unknown;
  };
  const status = typeof candidate.status === "number" ? candidate.status : 500;
  const message = candidate.message === undefined ? String(error) : String(candidate.message);
  const details = (error as { readonly details?: unknown }).details;
  const detailObject =
    details !== null && typeof details === "object" && !Array.isArray(details)
      ? (details as Record<string, unknown>)
      : undefined;
  const detailCode = typeof detailObject?.code === "string" ? detailObject.code : undefined;
  const body =
    candidate.body !== undefined && candidate.body !== null && typeof candidate.body === "object"
      ? (candidate.body as JsonValue)
      : {
          code:
            detailCode ??
            (typeof candidate.code === "string"
              ? candidate.code
              : status === 400
                ? "CONTRACT_VIOLATION"
                : "INTERNAL"),
          message,
          ...(detailObject === undefined ? {} : { details: detailObject as JsonObject }),
        };
  return { status, body, headers: status === 401 ? { "WWW-Authenticate": "Bearer" } : {} };
}

function shapeContractError(
  system: RuntimeSystem,
  result: ReturnType<typeof errorDetails>,
  operationId: string | undefined,
): ReturnType<typeof errorDetails> {
  if (operationId === undefined || result.status < 400) return result;
  const body = system.program.dependencies.contract.shapeError?.(
    operationId,
    result.status,
    result.body,
  );
  return body === undefined ? result : { ...result, body };
}

function writeResponse(
  response: Response,
  status: number,
  body: JsonValue | null,
  headers: Record<string, string>,
  head: boolean,
  rawJson = false,
): void {
  if (
    headers["X-Potemkin-Idempotency-Replay"] !== undefined &&
    headers["X-Idempotency-Replay"] === undefined
  ) {
    headers["X-Idempotency-Replay"] = headers["X-Potemkin-Idempotency-Replay"];
  }
  if (headers["x-specmatic-result"] === undefined && headers["X-Specmatic-Result"] === undefined) {
    headers["X-Specmatic-Result"] = status >= 200 && status < 300 ? "success" : "failure";
  }
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  if (head || status === 204 || status === 304) {
    response.status(status).end();
    return;
  }
  if (rawJson && typeof body === "string") {
    if (response.getHeader("Content-Type") === undefined)
      response.setHeader("Content-Type", "application/json");
    response.status(status).end(body);
    return;
  }
  response.status(status).json(body);
}

const CORS_ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS";
const CORS_ALLOW_HEADERS = [
  "Content-Type",
  "Authorization",
  "If-Match",
  "Idempotency-Key",
  ...POTEMKIN_REQUEST_HEADERS,
].join(", ");

function isCredentialed(request: Request): boolean {
  return request.headers.cookie !== undefined || request.headers.authorization !== undefined;
}

function applyCors(
  request: Request,
  response: Response,
  allowedOrigins: AllowedOrigins = "*",
): void {
  const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
  const admitted = isCredentialed(request) && isOriginAdmitted(origin, allowedOrigins);
  response.setHeader(
    "Access-Control-Allow-Origin",
    admitted ? origin! : getAllowedOrigin(origin, allowedOrigins),
  );
  response.setHeader("Access-Control-Allow-Methods", CORS_ALLOW_METHODS);
  response.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
  response.setHeader("Vary", "Origin");
  if (admitted) response.setHeader("Access-Control-Allow-Credentials", "true");
}

function applyRuntimeSecurityHeaders(
  response: Response,
  security: RuntimeSystem["program"]["policies"]["securityHeaders"],
): void {
  if (security?.enabled === false) return;
  if (security?.nosniff) response.setHeader("X-Content-Type-Options", "nosniff");
  if (security?.frameDeny) response.setHeader("X-Frame-Options", "DENY");
  if (security?.hsts)
    response.setHeader(
      "Strict-Transport-Security",
      `max-age=31536000${security.includeSubDomains === false ? "" : "; includeSubDomains"}`,
    );
  if (security?.referrerPolicy) response.setHeader("Referrer-Policy", security.referrerPolicy);
  if (security?.customHeaders)
    for (const [name, value] of Object.entries(security.customHeaders))
      response.setHeader(name, value);
}

function jsonObjectBody(value: JsonValue): JsonObject {
  return isJsonObject(value) ? value : {};
}

function preserveForwardDecorations(base: JsonValue, decorated: JsonValue): JsonValue {
  if (!isJsonObject(base) || !isJsonObject(decorated)) return base;
  const decoration = Object.fromEntries(
    ["_events", "_debug"].flatMap((key) =>
      decorated[key] === undefined ? [] : [[key, decorated[key]]],
    ),
  ) as JsonObject;
  return Object.keys(decoration).length === 0 ? base : { ...base, ...decoration };
}

function runtimeForwardResponse(result: {
  status: number;
  body: JsonValue;
  headers?: Readonly<Record<string, string>>;
  unmaskedBody?: JsonValue | null;
  patches?: readonly JournalEntry[];
}): ForwardedResponse {
  let body = result.unmaskedBody ?? result.body;
  // When `_patches` is present, the forwarding interceptor is responsible for
  // applying response mutations. Return the unmodified body so the plugin can
  // reproduce the direct gateway response exactly. Debug/event decorations are
  // still transport metadata and are safe to carry on the raw body.
  const hasResponsePatches = result.patches !== undefined && result.patches.length > 0;
  if (result.unmaskedBody !== undefined && isJsonObject(body) && isJsonObject(result.body)) {
    const decorated = result.body as JsonObject;
    const decorationKeys = hasResponsePatches
      ? ["_events", "_debug"]
      : ["_links", "_events", "_debug"];
    const decoration = Object.fromEntries(
      decorationKeys.flatMap((key) =>
        decorated[key] === undefined ? [] : [[key, decorated[key]]],
      ),
    ) as JsonObject;
    if (Object.keys(decoration).length > 0) body = { ...body, ...decoration };
  }
  const headers = lowerCaseHeaders({
    ...(body === null ? {} : { "content-type": "application/json" }),
    ...result.headers,
  });
  if (
    headers["x-potemkin-idempotency-replay"] !== undefined &&
    headers["x-idempotency-replay"] === undefined
  ) {
    headers["x-idempotency-replay"] = headers["x-potemkin-idempotency-replay"];
  }
  headers["x-specmatic-result"] =
    result.status >= 200 && result.status < 300 ? "success" : "failure";
  return {
    status: result.status,
    headers,
    body,
    ...(result.patches === undefined || result.patches.length === 0
      ? {}
      : { _patches: result.patches }),
  };
}

/**
 * The Specmatic plugin applies `_patches` after it validates the forwarded
 * base document. The transport observer is attached to Potemkin's HTTP
 * response, so it must apply the same immutable journal to its observation
 * copy; otherwise telemetry contains the unmasked base document rather than
 * the response the caller receives.
 */
function observedForwardResponse(result: ForwardedResponse): ForwardedResponse {
  if (result._patches === undefined || result._patches.length === 0) return result;
  const body = applyPatches(result.body, result._patches.map(journalEntryToPatch), "overlay", {
    autoVivify: true,
  }).newState;
  return { ...result, body };
}

function journalEntryToPatch(entry: JournalEntry): Patch {
  switch (entry.op) {
    case "remove":
      return { op: "remove", path: entry.path };
    case "move":
    case "copy":
      if (entry.from === undefined) {
        throw new RuntimeExecutionError(
          500,
          `Forwarded response ${entry.op} patch is missing its source path`,
        );
      }
      return { op: entry.op, path: entry.path, from: entry.from };
    case "increment":
      if (entry.by === undefined) {
        throw new RuntimeExecutionError(
          500,
          "Forwarded response increment patch is missing its amount",
        );
      }
      return { op: "increment", path: entry.path, by: entry.by };
    case "merge":
      if (!isJsonObject(entry.value)) {
        throw new RuntimeExecutionError(
          500,
          "Forwarded response merge patch is missing an object value",
        );
      }
      return { op: "merge", path: entry.path, value: entry.value };
    case "upsert":
      throw new RuntimeExecutionError(
        500,
        "Forwarded response upsert patches cannot be represented by the transport journal",
      );
    default:
      if (entry.value === undefined) {
        throw new RuntimeExecutionError(
          500,
          `Forwarded response ${entry.op} patch is missing its value`,
        );
      }
      return { op: entry.op, path: entry.path, value: entry.value };
  }
}

function alternateResponsePatchPlan(
  unmaskedBody: JsonValue | null | undefined,
  shapedBody: JsonValue,
  controls: RuntimeControls,
  resourceType: string,
  path: string,
): { readonly body: JsonValue; readonly patches: readonly JournalEntry[] } | undefined {
  const format = controls.responseFormat;
  if (unmaskedBody === undefined || unmaskedBody === null || format === undefined) return undefined;
  if (controls.paginationStyle !== undefined) return undefined;
  const unmaskedShape =
    Array.isArray(unmaskedBody) && Array.isArray(shapedBody)
      ? unmaskedBody.map((item) => applyResponseFormat(item, format, resourceType, path))
      : applyResponseFormat(unmaskedBody, format, resourceType, path);
  if (unmaskedShape === null) return undefined;
  const source = controls.maskFields === undefined ? "overlay" : "mask";
  const patches = diffJsonJournal(unmaskedShape, shapedBody, source);
  if (patches === undefined || patches.length === 0) return undefined;
  return { body: unmaskedShape, patches };
}

async function handleRuntimeForward(
  system: RuntimeSystem,
  forwarded: ForwardedRequest,
  response?: Response,
  extensions: RuntimeGatewayExtensions = {},
): Promise<ForwardedResponse> {
  const rawMethod = forwarded.method.toUpperCase();
  const isHead = rawMethod === "HEAD";
  const method = isHead ? "GET" : rawMethod;
  const version = resolveVersion(forwarded.path, system.program.policies.versioning);
  const versionHeaders: Readonly<Record<string, string>> =
    version.version === undefined
      ? {}
      : { "X-Potemkin-Version": version.version, "X-API-Version": version.version };
  const controls: RuntimeControls = controlsFromHeaders(
    forwarded.headers,
    system.program.policies.controlDefaults,
  );
  const output = (
    result: {
      status: number;
      body: JsonValue;
      headers?: Readonly<Record<string, string>>;
      unmaskedBody?: JsonValue | null;
    },
    currentBoundary?: RuntimeBoundary,
    operationId?: string,
  ): ForwardedResponse => {
    const body =
      operationId !== undefined && result.status >= 400
        ? (system.program.dependencies.contract.shapeError?.(
            operationId,
            result.status,
            result.body,
          ) ?? result.body)
        : result.body;
    const shapedResult = {
      ...result,
      body,
      ...(result.unmaskedBody === undefined
        ? {}
        : {
            unmaskedBody:
              operationId !== undefined && result.status >= 400 ? body : result.unmaskedBody,
          }),
    };
    if (response !== undefined) response.locals.potemkinObservedBody = shapedResult.body;
    // Alternate representations are already final response documents. They
    // must not be replaced with the unmasked contract body plus root-level
    // patches: a mask such as `/internalNote` cannot be replayed against a
    // JSON:API document whose value lives under `/data/attributes`.
    const engineOwnsResponseShape =
      controls.responseFormat !== undefined || controls.paginationStyle !== undefined;
    const alternatePlan = engineOwnsResponseShape
      ? alternateResponsePatchPlan(
          shapedResult.unmaskedBody,
          shapedResult.body,
          controls,
          currentBoundary?.boundary ?? "Resource",
          forwarded.path,
        )
      : undefined;
    const staticPatches: JournalEntry[] = [
      ...(currentBoundary?.mask ?? []).map((field) => ({
        op: "remove" as const,
        path: `/${field}`,
        source: "mask" as const,
      })),
      ...((currentBoundary?.response?.hateoas ?? []).length > 0 &&
      isJsonObject(shapedResult.body) &&
      shapedResult.body["_links"] !== undefined
        ? [
            {
              op: "add" as const,
              path: "/_links",
              value: shapedResult.body["_links"] as JsonValue,
              source: "hateoas" as const,
            },
          ]
        : []),
    ];
    const standardPatches: JournalEntry[] | undefined =
      shapedResult.unmaskedBody === undefined || engineOwnsResponseShape
        ? undefined
        : (() => {
            const staticBody =
              staticPatches.length === 0 || !isJsonObject(shapedResult.unmaskedBody)
                ? shapedResult.unmaskedBody
                : applyPatches(
                    shapedResult.unmaskedBody,
                    staticPatches.map(journalEntryToPatch),
                    "overlay",
                    { autoVivify: true },
                  ).newState;
            const requestMaskPatches =
              controls.maskFields === undefined || !isJsonObject(staticBody)
                ? []
                : compileMaskValuePatches(staticBody, controls.maskFields);
            return [
              ...staticPatches,
              ...applyPatches(staticBody, requestMaskPatches, "mask", {
                autoVivify: false,
              }).journal,
            ];
          })();
    const patches = standardPatches ?? alternatePlan?.patches;
    const hasStaticResponseMutations = (patches?.length ?? 0) > 0;
    return runtimeForwardResponse({
      ...shapedResult,
      headers: { ...result.headers, ...versionHeaders },
      // Request-scoped response controls are already represented in
      // `result.body`. Preserve that shaped body when there is no static
      // boundary mutation for the forwarding interceptor to replay. Static
      // masks/links remain out-of-band so Specmatic can validate the base body
      // before applying them.
      body: isHead
        ? null
        : engineOwnsResponseShape
          ? (alternatePlan?.body ?? shapedResult.body)
          : hasStaticResponseMutations
            ? preserveForwardDecorations(
                shapedResult.unmaskedBody ?? shapedResult.body,
                shapedResult.body,
              )
            : shapedResult.body,
      unmaskedBody: isHead
        ? null
        : engineOwnsResponseShape
          ? undefined
          : hasStaticResponseMutations
            ? shapedResult.unmaskedBody
            : undefined,
      patches,
    });
  };
  if (rawMethod === "OPTIONS")
    return output({
      status: 204,
      headers: {
        "access-control-allow-origin": forwarded.headers.origin ?? "*",
        "access-control-allow-methods": CORS_ALLOW_METHODS,
        "access-control-allow-headers": CORS_ALLOW_HEADERS,
        vary: "Origin",
      },
      body: null,
    });
  const route = matchRoute(system.openapi, method, version.path);
  const rawBody = forwarded.body;
  const body = jsonObjectBody(rawBody);
  if (route === null)
    return output({
      status: 404,
      body: {
        error: "NO_ROUTE",
        code: "NO_ROUTE",
        message: `No route for ${method} ${version.path}`,
      },
      headers: {},
    });
  const boundary = boundaryForRoute(system, route.contractPath);
  const session = system.program.policies.auth?.session;
  const isSessionEndpoint =
    system.program.policies.auth?.mode === "session" &&
    ((method === "POST" && version.path === (session?.loginPath ?? "/sessions")) ||
      (method === "DELETE" && version.path === (session?.logoutPath ?? "/sessions/current")));
  if (boundary === undefined && isSessionEndpoint) {
    const command: Command = {
      commandId: commandId(system),
      boundary: "__session__",
      intent: "mutation",
      targetId: null,
      payload: body,
      queryParams: forwarded.query,
      httpMethod: method,
      path: version.path,
      origin: "inbound",
      depth: 0,
      ...(route.operation.operationId === undefined
        ? {}
        : { operationId: route.operation.operationId }),
    };
    if (response !== undefined) {
      response.locals.potemkinCommandId = command.commandId;
      response.locals.potemkinTraceId = parseControlHeaders(
        forwarded.headers,
      ).observability.traceId;
    }
    try {
      const result = await system.engine.execute({ command, headers: forwarded.headers, controls });
      return output(result, undefined, route.operation.operationId);
    } catch (error) {
      return output(errorDetails(error), undefined, route.operation.operationId);
    }
  }
  if (boundary === undefined)
    return output(
      {
        status: 501,
        body: {
          error: "NOT_IMPLEMENTED",
          code: "BOUNDARY_NOT_IMPLEMENTED",
          message: `No runtime boundary for ${route.contractPath}`,
        },
        headers: {},
      },
      undefined,
      route.operation.operationId,
    );
  const actor =
    actorOverride(forwarded.headers["x-potemkin-actor"]) ??
    (parseControlHeaders(forwarded.headers).identity.impersonate === undefined
      ? undefined
      : actorOverride(parseControlHeaders(forwarded.headers).identity.impersonate));
  const ifMatch = forwarded.headers["if-match"];
  const parsedIfMatch = parseEntityTagVersion(ifMatch);
  // Keep the malformed marker until the forwarded request is inside the
  // response envelope; the plugin must receive a typed 400 rather than treat
  // the gateway failure as an engine outage.
  const sequenceVersion =
    parsedIfMatch === undefined || Number.isNaN(parsedIfMatch) ? undefined : parsedIfMatch;
  const intent = intentFor(method, boundary, route);
  const commandFor = (payload: JsonObject): Command => ({
    commandId: commandId(system),
    boundary: boundary.boundary,
    intent,
    targetId: targetFor(boundary, route, forwarded.query, forwarded.headers, payload),
    payload,
    queryParams: forwarded.query,
    httpMethod: method,
    path: version.path,
    origin: "inbound",
    depth: 0,
    ...(route.operation.operationId === undefined
      ? {}
      : { operationId: route.operation.operationId }),
    ...(sequenceVersion === undefined || Number.isNaN(sequenceVersion) ? {} : { sequenceVersion }),
    ...(actor === undefined ? {} : { actor }),
  });
  const command = commandFor(body);
  if (response !== undefined) {
    response.locals.potemkinCommandId = command.commandId;
    response.locals.potemkinTraceId = parseControlHeaders(forwarded.headers).observability.traceId;
  }
  if (
    adminControlRequested(forwarded.headers) &&
    !adminControlAllowed(system, forwarded.headers, command, extensions.adminToken)
  ) {
    const authenticated = system.program.policies.auth?.authenticate?.({
      command,
      headers: forwarded.headers,
    });
    const status = authenticated === undefined ? 401 : 403;
    return output(
      {
        status,
        body: {
          code: "ADMIN_REQUIRED",
          message: "admin scope required for this X-Potemkin-* control",
        },
        headers: status === 401 ? { "www-authenticate": "Bearer" } : {},
      },
      boundary,
      route.operation.operationId,
    );
  }
  try {
    if (Number.isNaN(parsedIfMatch)) {
      throw new RuntimeExecutionError(400, "If-Match value is not a valid integer", {
        code: "INVALID_IF_MATCH",
        message: "If-Match value is not a valid integer (weak validators are not supported)",
      });
    }
    if (Array.isArray(rawBody) && rawBody.length === 0 && intent !== "query") {
      throw new RuntimeExecutionError(400, "Request array must contain at least one item", {
        code: "CONTRACT_VIOLATION",
        message: "Request array must contain at least one item",
      });
    }
    if (Array.isArray(rawBody) && intent !== "query") {
      const requests = rawBody.map((item, index) => {
        const payload = jsonObjectBody(item);
        const itemCommand = commandFor(payload);
        return {
          command: itemCommand,
          headers: forwarded.headers,
          controls,
          batchItem: { index, size: rawBody.length },
          ...(actor === undefined ? {} : { actor }),
        } as RuntimeRequest;
      });
      const results = await system.engine.executeBatch(requests, {
        transactional: controls.bulkTransactional === true,
        requestBody: rawBody,
      });
      const first = results[0];
      const operationId = requests[0]?.command.operationId;
      if (first !== undefined && operationId !== undefined) {
        system.program.dependencies.contract.validateBatchResponse?.(
          operationId,
          first.status,
          results.map((result) => result.body),
          requests[0],
        );
      }
      return output(
        {
          status: first?.status ?? (intent === "creation" ? 201 : 200),
          body: results.map((result) => result.body),
          headers: first?.headers ?? {},
          unmaskedBody: results.map((result) =>
            result.unmaskedBody === undefined ? result.body : result.unmaskedBody,
          ),
        },
        boundary,
        operationId,
      );
    }
    const result = await system.engine.execute({
      command,
      headers: forwarded.headers,
      controls,
      ...(actor === undefined ? {} : { actor }),
    });
    return output(result, boundary, route.operation.operationId);
  } catch (error) {
    const result = errorDetails(error);
    return output(result, boundary, route.operation.operationId);
  }
}

function registerRuntimeForwarding(
  app: Express,
  system: RuntimeSystem,
  extensions: RuntimeGatewayExtensions,
): void {
  app.post("/_engine/forward", async (request, response) => {
    try {
      const forwarded = validateForwardedRequest(request.body);
      const originalForwarded = structuredClone(forwarded);
      const result = await handleRuntimeForward(system, forwarded, response, extensions);
      // The outer HTTP request is only the plugin transport. Observability
      // must describe the nested request Specmatic intercepted and the full
      // envelope returned to Specmatic, otherwise the exchange loses the
      // caller's path/body and records only the simulated body.
      response.locals.potemkinTransportRequest =
        originalForwarded satisfies RuntimeTransportRequestInput;
      response.locals.potemkinTransportResponseBody = observedForwardResponse(
        result,
      ) as unknown as JsonValue;
      response.status(200).json(result);
    } catch (error) {
      // A malformed outer envelope cannot carry a meaningful nested HTTP
      // response. The established plugin contract therefore uses HTTP 400 for
      // this transport error; valid forwarded requests always use HTTP 200 and
      // carry the simulated status in the envelope.
      const result = errorDetails(error);
      response.status(400).json({
        error: "MALFORMED_FORWARDED_REQUEST",
        code:
          error instanceof Error &&
          "code" in error &&
          typeof (error as { code?: unknown }).code === "string"
            ? (error as { code: string }).code
            : "BOOT_ERR_MALFORMED_FORWARDED_REQUEST",
        message:
          isJsonObject(result.body) && typeof result.body.message === "string"
            ? result.body.message
            : "Forwarded request envelope is invalid",
      });
    }
  });
  app.get("/_engine/health", (_request, response) =>
    response.status(200).json({
      status: "UP",
      engine: "potemkin-stateful",
      version: extensions.version ?? "0.1.0",
      ready: true,
    }),
  );
  app.get("/_engine/ready", (_request, response) =>
    response
      .status(200)
      .json({ ready: true, state: "UP", routesDiscovered: system.program.byContractPath.size }),
  );
  app.get("/_engine/routes", (request, response) => {
    const projection = routesProjection(system, extensions);
    if (hasMatchingEtag(request, projection.etag)) {
      response.status(304).end();
      return;
    }
    response.setHeader("Cache-Control", `max-age=${projection.ttlSeconds}, public`);
    response.setHeader("ETag", `"${projection.etag}"`);
    const { etag: _etag, ...body } = projection;
    response.status(200).json(body);
  });
  app.get("/_engine/fixtures", (request, response) => {
    const projection = fixturesProjection(system, extensions);
    if (hasMatchingEtag(request, projection.etag)) {
      response.status(304).end();
      return;
    }
    response.setHeader("Cache-Control", `max-age=${routesTtlSeconds(extensions)}, public`);
    response.setHeader("ETag", `"${projection.etag}"`);
    const { etag: _etag, ...body } = projection;
    response.status(200).json(body);
  });
  app.get("/_engine/config", (_request, response) => {
    if (system.configuration === undefined) {
      response.status(404).json({
        error: "CONFIG_NOT_AVAILABLE",
        message: "No top-level Potemkin configuration was supplied to this runtime",
      });
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response
      .status(200)
      .json(
        runtimeConfigurationResponse(
          extensions.version ?? "0.1.0",
          system.configuration,
          system.configuration.plugin,
        ),
      );
  });
  app.get("/_engine/state/:boundary/:id", (request, response) => {
    const boundary = system.program.byBoundaryName.get(request.params.boundary);
    if (boundary === undefined) {
      response.status(404).json({ code: "BOUNDARY_NOT_FOUND", message: "Boundary not found" });
      return;
    }
    const snapshot = system.engine.snapshot();
    const state = snapshot.state.find(([id]) => id === request.params.id)?.[1];
    if (state === undefined) {
      response.status(404).json({ code: "ENTITY_ABSENCE", message: "Entity not found" });
      return;
    }
    const events = snapshot.events.filter(
      (event) => event.aggregateId === request.params.id && event.boundary === boundary.boundary,
    );
    const lastEvent = events.at(-1);
    response.status(200).json({
      ...state,
      _meta: {
        version: events.reduce((highest, event) => Math.max(highest, event.sequenceVersion), 0),
        lastEvent: lastEvent?.type ?? null,
        computedFields: (boundary.state?.computed ?? []).map((field) => field.name),
        patchJournal: [],
      },
    });
  });
}

/**
 * HTTP is deliberately a thin transport: it binds an OpenAPI request to a
 * RuntimeRequest and serializes RuntimeExecutionResult. It does not perform
 * YAML parsing, CEL evaluation, state projection, or side-effect orchestration.
 */
export function createRuntimeGateway(
  system: RuntimeSystem,
  extensions: RuntimeGatewayExtensions = {},
): Express {
  const app = express();
  app.use((_request, response, next) => {
    applyRuntimeSecurityHeaders(response, system.program.policies.securityHeaders);
    next();
  });
  // Install this before body parsing so parser failures, malformed JSON, and
  // other early transport errors still produce exactly one final observation.
  installRuntimeObservation(app, system);
  app.use(
    bodyParser.json({
      strict: false,
      limit: "10mb",
      type: ["application/json", "text/json", "application/*+json"],
      verify: captureParsedRequestBody,
    }),
  );
  app.use(bodyParser.urlencoded({ extended: false, verify: captureParsedRequestBody }));
  app.use((request, response, next) => {
    applyCors(request, response, extensions.allowedOrigins);
    next();
  });
  app.options("*", (request, response) => {
    applyCors(request, response, extensions.allowedOrigins);
    response.status(204).end();
  });
  registerRuntimeAdminRoutes(app, system, extensions);
  registerRuntimeForwarding(app, system, extensions);

  app.use(async (request: Request, response: Response, next: NextFunction) => {
    if (request.path.startsWith("/_admin")) {
      next();
      return;
    }
    const version = resolveVersion(request.path, system.program.policies.versioning);
    const effectiveMethod =
      request.method.toUpperCase() === "HEAD" ? "GET" : request.method.toUpperCase();
    const route = matchRoute(system.openapi, effectiveMethod, version.path);
    const headers = headersOf(request);
    const query = queryOf(request);
    const rawBody = bodyValue(request);
    const body = objectBody(rawBody);
    const controls = controlsOf(request, system.program.policies.controlDefaults);
    const actorHeader = headers["x-potemkin-actor"];
    const parsedControls = parseControlHeaders(
      request.headers as Record<string, string | string[] | undefined>,
    );
    const actor =
      actorOverride(actorHeader) ??
      (parsedControls.identity.impersonate === undefined
        ? undefined
        : actorOverride(parsedControls.identity.impersonate));
    const provisionalCommand: Command = {
      commandId: commandId(system),
      boundary: "__control__",
      intent: "query",
      targetId: null,
      payload: body,
      queryParams: query,
      httpMethod: effectiveMethod,
      path: version.path,
      origin: "inbound",
      depth: 0,
    };
    response.locals.potemkinCommandId = provisionalCommand.commandId;
    if (
      adminControlRequested(headers) &&
      !adminControlAllowed(system, headers, provisionalCommand, extensions.adminToken)
    ) {
      const authenticated = system.program.policies.auth?.authenticate?.({
        command: provisionalCommand,
        headers,
      });
      const status = authenticated === undefined ? 401 : 403;
      writeResponse(
        response,
        status,
        { code: "ADMIN_REQUIRED", message: "admin scope required for this X-Potemkin-* control" },
        status === 401 ? { "WWW-Authenticate": "Bearer" } : {},
        request.method === "HEAD",
      );
      return;
    }
    if (route === null) {
      const command: Command = { ...provisionalCommand, boundary: "__unknown__" };
      try {
        const result = await system.engine.execute({
          command,
          headers,
          controls,
          ...(actor === undefined ? {} : { actor }),
        });
        if (result.connectionClosed === true) {
          response.destroy();
          return;
        }
        writeResponse(
          response,
          result.status,
          result.body,
          { ...result.headers },
          request.method === "HEAD",
          typeof result.body === "string" && controls.bodyTruncateBytes !== undefined,
        );
      } catch (error) {
        const result = errorDetails(error);
        writeResponse(
          response,
          result.status,
          result.body,
          result.headers,
          request.method === "HEAD",
        );
      }
      return;
    }
    const boundary = boundaryForRoute(system, route.contractPath);
    if (boundary === undefined) {
      const session = system.program.policies.auth?.session;
      const isSessionEndpoint =
        system.program.policies.auth?.mode === "session" &&
        ((effectiveMethod === "POST" && version.path === (session?.loginPath ?? "/sessions")) ||
          (effectiveMethod === "DELETE" &&
            version.path === (session?.logoutPath ?? "/sessions/current")));
      if (isSessionEndpoint) {
        try {
          const command: Command = {
            ...provisionalCommand,
            boundary: "__session__",
            intent: "mutation",
            httpMethod: effectiveMethod,
            path: version.path,
            ...(route.operation.operationId === undefined
              ? {}
              : { operationId: route.operation.operationId }),
          };
          const result = await system.engine.execute({
            command,
            headers,
            controls,
            ...(actor === undefined ? {} : { actor }),
          });
          writeResponse(
            response,
            result.status,
            result.body,
            { ...result.headers },
            request.method === "HEAD",
          );
        } catch (error) {
          const result = shapeContractError(
            system,
            errorDetails(error),
            route.operation.operationId,
          );
          writeResponse(
            response,
            result.status,
            result.body,
            result.headers,
            request.method === "HEAD",
          );
        }
        return;
      }
      const fallbackBody = {
        code: "BOUNDARY_NOT_IMPLEMENTED",
        message: `No runtime boundary for ${route.contractPath}`,
      } satisfies JsonObject;
      const shapedBody =
        route.operation.operationId === undefined
          ? fallbackBody
          : (system.program.dependencies.contract.shapeError?.(
              route.operation.operationId,
              501,
              fallbackBody,
            ) ?? fallbackBody);
      response.status(501).json(shapedBody);
      return;
    }
    try {
      // Request validation belongs to RuntimeEngine. Keeping it there means
      // contract failures follow the same observation, correlation, and error
      // path as successful requests; the HTTP gateway only binds transport
      // values to a typed RuntimeRequest.
      const intent = intentFor(effectiveMethod, boundary, route);
      const targetId = targetFor(boundary, route, query, headers, body);
      const ifMatch = headers["if-match"];
      const parsedIfMatch = parseEntityTagVersion(ifMatch);
      if (parsedIfMatch !== undefined && !Number.isInteger(parsedIfMatch)) {
        throw new RuntimeExecutionError(400, "If-Match value is not a valid integer", {
          code: "INVALID_IF_MATCH",
          message: "If-Match value is not a valid integer (weak validators are not supported)",
        });
      }
      const sequenceVersion = parsedIfMatch;

      if (Array.isArray(rawBody) && rawBody.length === 0 && intent !== "query") {
        throw new RuntimeExecutionError(400, "Request array must contain at least one item", {
          code: "CONTRACT_VIOLATION",
          message: "Request array must contain at least one item",
        });
      }
      if (Array.isArray(rawBody) && intent !== "query") {
        const batchRequests: RuntimeRequest[] = rawBody.map((item, index) => {
          const itemBody = objectBody(item);
          const itemTarget = targetFor(boundary, route, query, headers, itemBody);
          const itemCommand: Command = {
            commandId: commandId(system),
            boundary: boundary.boundary,
            intent,
            targetId: itemTarget,
            payload: itemBody,
            queryParams: query,
            httpMethod: effectiveMethod,
            path: version.path,
            origin: "inbound",
            depth: 0,
            ...(route.operation.operationId === undefined
              ? {}
              : { operationId: route.operation.operationId }),
            ...(sequenceVersion === undefined || Number.isNaN(sequenceVersion)
              ? {}
              : { sequenceVersion }),
            ...(actor === undefined ? {} : { actor }),
          };
          return {
            command: itemCommand,
            headers,
            controls,
            batchItem: { index, size: rawBody.length },
            ...(actor === undefined ? {} : { actor }),
          };
        });
        if (batchRequests[0] !== undefined)
          response.locals.potemkinCommandId = batchRequests[0].command.commandId;
        const results = await system.engine.executeBatch(batchRequests, {
          transactional: controls.bulkTransactional === true,
          requestBody: rawBody,
        });
        if (results.some((item) => item.connectionClosed === true)) {
          response.destroy();
          return;
        }
        const status = results[0]?.status ?? (intent === "creation" ? 201 : 200);
        const resultBody = results.map((item) => item.body);
        const operationId = batchRequests[0]?.command.operationId;
        if (operationId !== undefined) {
          system.program.dependencies.contract.validateBatchResponse?.(
            operationId,
            status,
            resultBody,
            batchRequests[0],
          );
        }
        const resultHeaders = {
          ...results[0]?.headers,
          ...(version.version === undefined
            ? {}
            : { "X-Potemkin-Version": version.version, "X-API-Version": version.version }),
        };
        writeResponse(response, status, resultBody, resultHeaders, request.method === "HEAD");
        return;
      }
      const command: Command = {
        commandId: commandId(system),
        boundary: boundary.boundary,
        intent,
        targetId,
        payload: body,
        queryParams: query,
        httpMethod: effectiveMethod,
        path: version.path,
        origin: "inbound",
        depth: 0,
        ...(route.operation.operationId === undefined
          ? {}
          : { operationId: route.operation.operationId }),
        ...(sequenceVersion === undefined || Number.isNaN(sequenceVersion)
          ? {}
          : { sequenceVersion }),
        ...(actor === undefined ? {} : { actor }),
      };
      const runtimeRequest: RuntimeRequest = {
        command,
        headers,
        controls,
        ...(actor === undefined ? {} : { actor }),
      };
      response.locals.potemkinCommandId = command.commandId;
      const result = await system.engine.execute(runtimeRequest);
      if (result.connectionClosed === true) {
        response.destroy();
        return;
      }
      const outputHeaders = {
        ...result.headers,
        ...(version.version === undefined
          ? {}
          : { "X-Potemkin-Version": version.version, "X-API-Version": version.version }),
      };
      writeResponse(
        response,
        result.status,
        result.body,
        outputHeaders,
        request.method === "HEAD",
        typeof result.body === "string" && controls.bodyTruncateBytes !== undefined,
      );
    } catch (error) {
      const result = shapeContractError(system, errorDetails(error), route.operation.operationId);
      writeResponse(
        response,
        result.status,
        result.body,
        result.headers,
        request.method === "HEAD",
      );
    }
  });
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const result = errorDetails(error);
    writeResponse(response, result.status, result.body, result.headers, false);
  });
  return app;
}
