import type { DomainEvent, JsonObject, JsonValue } from "../types.js";
import { applyPatches, type Patch } from "../model/patches.js";
import type {
  RuntimeBoundary,
  RuntimeControls,
  RuntimeExecutionResult,
  RuntimePolicies,
  RuntimeRequest,
} from "../model/runtime.js";

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function firstQueryValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function isJsonObject(value: JsonValue | null | undefined): value is JsonObject {
  return (
    value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
  );
}

function isPaginationEnvelope(value: JsonValue | null | undefined): value is JsonObject & {
  items: JsonValue[];
  totalCount: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextCursor?: string;
} {
  return isJsonObject(value) && Array.isArray(value.items) && typeof value.totalCount === "number";
}

function queryString(
  query: Readonly<Record<string, string | readonly string[]>>,
  offset: number,
  limit: number,
): string {
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(query)) {
    if (key === "offset" || key === "limit" || key === "cursor") continue;
    for (const value of typeof raw === "string" ? [raw] : raw) params.append(key, value);
  }
  params.set("offset", String(offset));
  params.set("limit", String(limit));
  return params.toString();
}

function transformMaskedBody(
  body: JsonValue | null,
  paths: readonly string[],
  replacement: JsonValue | undefined,
): JsonValue | null {
  if (body === null || paths.length === 0) return body;
  const bareFields = new Set(paths.filter((path) => !path.startsWith("/")));
  const pointers = paths.filter((path) => path.startsWith("/"));
  const visit = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map((item) => visit(item));
    if (value === null || typeof value !== "object") return value;
    let current: JsonValue = clone(value as JsonObject);
    if (typeof current !== "object" || current === null || Array.isArray(current)) return current;
    const object = current as JsonObject;
    for (const field of bareFields) {
      if (!Object.prototype.hasOwnProperty.call(object, field)) continue;
      if (replacement === undefined) delete object[field];
      else object[field] = clone(replacement);
    }
    for (const path of pointers) {
      try {
        const patch: Patch =
          replacement === undefined
            ? { op: "remove", path }
            : { op: "replace", path, value: replacement };
        current = applyPatches(current, [patch], "mask", { autoVivify: false }).newState;
      } catch {
        // Masks are best-effort when a field is absent.
      }
    }
    if (current !== null && typeof current === "object" && !Array.isArray(current)) {
      for (const [key, child] of Object.entries(current as JsonObject)) {
        (current as JsonObject)[key] = visit(child);
      }
    }
    return current;
  };
  return visit(body);
}

function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function sameJsonValue(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Compile request-scoped value masks into transport patches.
 *
 * The direct runtime applies a bare field name to every object in the response
 * and a JSON Pointer relative to every object it visits. The Specmatic
 * forwarding transport starts from the contract-shaped, unmasked document, so
 * it needs equivalent absolute patches in order to apply the same operation
 * after contract validation.
 */
export function compileMaskValuePatches(
  body: JsonValue | null,
  paths: readonly string[],
  replacement: JsonValue = "[MASKED]",
): Patch[] {
  if (body === null || paths.length === 0) return [];
  const bareFields = new Set(paths.filter((path) => !path.startsWith("/")));
  const pointerSegments = paths
    .filter((path) => path.startsWith("/"))
    .map((path) =>
      path
        .slice(1)
        .split("/")
        .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~")),
    )
    .filter((segments) => segments.length > 0 && segments[0] !== "");
  const patches: Patch[] = [];

  const read = (
    value: JsonValue,
    segments: readonly string[],
  ): { exists: true; value: JsonValue } | { exists: false } => {
    let current: JsonValue = value;
    for (const segment of segments) {
      if (Array.isArray(current)) {
        const index = Number(segment);
        if (!Number.isInteger(index) || index < 0 || index >= current.length)
          return { exists: false };
        current = current[index]!;
      } else if (isJsonObject(current) && Object.prototype.hasOwnProperty.call(current, segment)) {
        current = current[segment]!;
      } else {
        return { exists: false };
      }
    }
    return { exists: true, value: current };
  };

  const visit = (value: JsonValue, prefix: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${prefix}/${index}`));
      return;
    }
    if (!isJsonObject(value)) return;

    for (const field of bareFields) {
      const current = value[field];
      if (current !== undefined && !sameJsonValue(current, replacement)) {
        patches.push({
          op: "replace",
          path: `${prefix}/${escapePointerSegment(field)}`,
          value: replacement,
        });
      }
    }
    for (const segments of pointerSegments) {
      const target = read(value, segments);
      if (!target.exists || sameJsonValue(target.value, replacement)) continue;
      patches.push({
        op: "replace",
        path: `${prefix}/${segments.map(escapePointerSegment).join("/")}`,
        value: replacement,
      });
    }
    for (const [key, child] of Object.entries(value)) {
      visit(child, `${prefix}/${escapePointerSegment(key)}`);
    }
  };

  visit(body, "");
  return patches;
}

export function maskBody(body: JsonValue | null, paths: readonly string[]): JsonValue | null {
  return transformMaskedBody(body, paths, undefined);
}

export function maskValues(body: JsonValue | null, paths: readonly string[]): JsonValue | null {
  return transformMaskedBody(body, paths, "[MASKED]");
}

export function truncateSerializedBody(body: JsonValue | null, maxBytes: number): JsonValue | null {
  if (body === null || !Number.isFinite(maxBytes) || maxBytes < 0) return body;
  const encoded = new TextEncoder().encode(JSON.stringify(body));
  const limit = Math.floor(maxBytes);
  if (encoded.byteLength <= limit) return body;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = limit; end >= 0; end -= 1) {
    try {
      return decoder.decode(encoded.slice(0, end));
    } catch {
      /* back up to a code-point boundary */
    }
  }
  return "";
}

export function applyPaginationControl(
  body: JsonValue | null,
  style: NonNullable<RuntimeControls["paginationStyle"]>,
  request: RuntimeRequest,
): { body: JsonValue | null; headers: Record<string, string> } {
  const page = isPaginationEnvelope(body) ? body : undefined;
  const items = page === undefined ? (Array.isArray(body) ? body : undefined) : page.items;
  if (items === undefined) return { body, headers: {} };
  const totalCount = page?.totalCount ?? items.length;
  const offset =
    page?.offset ?? (Number(firstQueryValue(request.command.queryParams.offset) ?? 0) || 0);
  const limit =
    page?.limit ??
    (Number(firstQueryValue(request.command.queryParams.limit) ?? items.length) || items.length);
  const hasMore = page?.hasMore ?? offset + items.length < totalCount;
  if (style === "envelope") {
    return {
      body: {
        items,
        totalCount,
        offset,
        limit,
        hasMore,
        ...(page?.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      },
      headers: {},
    };
  }
  if (style === "link-header") {
    const links: string[] = [];
    if (hasMore && limit > 0) {
      const cursor = page?.nextCursor;
      const query =
        cursor === undefined
          ? queryString(request.command.queryParams, offset + items.length, limit)
          : new URLSearchParams({
              ...Object.fromEntries(
                Object.entries(request.command.queryParams).map(([key, value]) => [
                  key,
                  typeof value === "string" ? value : (value[0] ?? ""),
                ]),
              ),
              cursor,
            }).toString();
      links.push(`<${request.command.path}?${query}>; rel="next"`);
    }
    if (offset > 0 && limit > 0)
      links.push(
        `<${request.command.path}?${queryString(request.command.queryParams, Math.max(0, offset - limit), limit)}>; rel="prev"`,
      );
    return {
      body: items,
      headers: {
        "X-Total-Count": String(totalCount),
        ...(links.length === 0 ? {} : { Link: links.join(", ") }),
      },
    };
  }
  return { body: items, headers: {} };
}

interface ResponseFormatStrategy {
  format(body: JsonValue | null, resourceType: string, path: string): JsonValue | null;
}

const responseFormatStrategies: Readonly<
  Record<NonNullable<RuntimeControls["responseFormat"]>, ResponseFormatStrategy>
> = {
  plain: { format: (body) => body },
  hal: {
    format: (body, _resourceType, path) => {
      if (body === null) return null;
      const self = path.split("?")[0] ?? path;
      if (Array.isArray(body))
        return { _embedded: { items: body }, _links: { self: { href: self } } } as JsonObject;
      if (isPaginationEnvelope(body))
        return {
          _embedded: { items: body.items },
          _links: { self: { href: self } },
          totalCount: body.totalCount,
          offset: body.offset,
          limit: body.limit,
          hasMore: body.hasMore,
          ...(body.nextCursor === undefined ? {} : { nextCursor: body.nextCursor }),
        } as JsonObject;
      if (isJsonObject(body)) {
        const existing = isJsonObject(body._links) ? body._links : {};
        return { ...body, _links: { self: { href: self }, ...existing } } as JsonObject;
      }
      return body;
    },
  },
  jsonapi: {
    format: (body, resourceType) => {
      if (body === null) return null;
      const resource = (value: JsonValue): JsonValue => {
        if (!isJsonObject(value)) return { type: resourceType, attributes: value };
        const { id, ...attributes } = value;
        return {
          type: resourceType,
          ...(typeof id === "string" || typeof id === "number" ? { id: String(id) } : {}),
          attributes,
        };
      };
      if (Array.isArray(body)) return { data: body.map(resource) } as JsonObject;
      if (isPaginationEnvelope(body))
        return {
          data: body.items.map(resource),
          meta: {
            totalCount: body.totalCount,
            offset: body.offset,
            limit: body.limit,
            hasMore: body.hasMore,
          },
        } as JsonObject;
      return { data: resource(body) } as JsonObject;
    },
  },
};

/** Strategy dispatch keeps alternate representations out of the engine's transaction logic. */
export function applyResponseFormat(
  body: JsonValue | null,
  format: NonNullable<RuntimeControls["responseFormat"]>,
  resourceType: string,
  path: string,
): JsonValue | null {
  return responseFormatStrategies[format].format(body, resourceType, path);
}

export function applyDebugEnvelope(
  body: JsonValue | null,
  request: RuntimeRequest,
  boundary: RuntimeBoundary,
  events: readonly DomainEvent[],
): JsonValue | null {
  const controls = request.controls;
  if (controls?.includeEvents !== true && controls?.echo !== true) return body;
  const base: JsonObject = isJsonObject(body) ? { ...body } : { value: body };
  const masks = [...(boundary.mask ?? []), ...(boundary.response?.mask ?? [])];
  if (controls?.includeEvents === true) {
    base._events = events.map((event) => ({
      eventId: event.eventId,
      type: event.type,
      aggregateId: event.aggregateId,
      sequenceVersion: event.sequenceVersion,
      timestamp: event.timestamp,
      payload: maskBody(event.payload, masks) ?? {},
      causedBy: event.causedBy,
    }));
  }
  if (controls?.echo === true) {
    base._debug = {
      boundary: boundary.boundary,
      intent: request.command.intent,
      targetId: request.command.targetId,
      dryRun: controls.dryRun === true,
      method: request.command.httpMethod,
      path: request.command.path,
    };
  }
  return base;
}

export function addSecurityHeaders(
  response: { headers: Record<string, string> },
  security: RuntimePolicies["securityHeaders"],
): void {
  if (security?.enabled === false) return;
  if (security?.nosniff)
    response.headers = { ...response.headers, "X-Content-Type-Options": "nosniff" };
  if (security?.frameDeny) response.headers = { ...response.headers, "X-Frame-Options": "DENY" };
  if (security?.hsts)
    response.headers = {
      ...response.headers,
      "Strict-Transport-Security": `max-age=31536000${security.includeSubDomains === false ? "" : "; includeSubDomains"}`,
    };
  if (security?.referrerPolicy)
    response.headers = { ...response.headers, "Referrer-Policy": security.referrerPolicy };
  if (security?.customHeaders)
    response.headers = { ...response.headers, ...security.customHeaders };
}

/** Apply common response decoration at the transport-neutral runtime boundary. */
export function decorateStandaloneResponse(
  response: RuntimeExecutionResult,
  request: RuntimeRequest,
  security: RuntimePolicies["securityHeaders"],
): RuntimeExecutionResult {
  const carrier = { headers: { ...response.headers } };
  addSecurityHeaders(carrier, security);
  if (request.controls?.dryRun === true) carrier.headers["X-Potemkin-Dry-Run"] = "true";
  if (request.controls?.traceId !== undefined)
    carrier.headers["X-Potemkin-Trace-Id"] = request.controls.traceId;
  if (request.controls?.spanName !== undefined)
    carrier.headers["X-Potemkin-Span-Name"] = request.controls.spanName;
  let body =
    request.controls?.maskFields === undefined
      ? response.body
      : maskValues(response.body, request.controls.maskFields);
  if (
    request.controls?.bodyTruncateBytes !== undefined &&
    request.controls.bodyTruncateBytes >= 0
  ) {
    body = truncateSerializedBody(body, request.controls.bodyTruncateBytes);
  }
  return { ...response, body, headers: carrier.headers };
}
