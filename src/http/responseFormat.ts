/**
 * Response-format + pagination-style transforms driven by the Tier-5
 * X-Potemkin-Response-Format and X-Potemkin-Pagination-Style control headers.
 *
 * These operate on the engine's already-serialised success body (the plain JSON
 * shape the contract produces) and re-shape it into an alternate representation:
 *
 *  - Response-Format:
 *      - `hal`     → HAL+JSON: collections become `{ _embedded: { items }, _links }`,
 *                    single entities gain a `_links.self`.
 *      - `jsonapi` → JSON:API: `{ data: { type, id, attributes } }` (single) or
 *                    `{ data: [ ... ] }` (collection).
 *      - `plain`   → no transform (the default contract shape).
 *
 *  - Pagination-Style (collections only):
 *      - `envelope`    → always wrap in `{ items, totalCount, offset, limit, hasMore }`.
 *      - `raw`         → always a bare array (unwrap any envelope).
 *      - `link-header` → bare array body PLUS a `Link:` header with rel="next"/"prev"
 *                        when more pages exist.
 *
 * Both transforms are pure: they take a body (and, for pagination, the current
 * request query) and return `{ body, headers }`. The gateway applies pagination
 * first (it understands the collection envelope), then response-format.
 */

import type { JsonValue, JsonObject } from '../contracts/value.js';
import type { ResponseFormat, PaginationStyle } from '../contracts/controlHeaders.js';

/** The pagination envelope shape produced by engine/query.ts for collections. */
interface PaginationEnvelope {
  readonly items: readonly JsonValue[];
  readonly totalCount: number;
  readonly offset: number;
  readonly limit: number;
  readonly hasMore: boolean;
}

function isPlainObject(body: JsonValue | null | undefined): body is JsonObject {
  return body !== null && typeof body === 'object' && !Array.isArray(body);
}

function isEnvelope(body: JsonValue | null | undefined): body is JsonObject & PaginationEnvelope {
  return (
    isPlainObject(body) && Array.isArray(body['items']) && typeof body['totalCount'] === 'number'
  );
}

/** Read a single string query value (first entry when repeated). */
function firstQuery(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Build a query string from `query`, overriding `offset` and `limit`, and dropping `cursor`.
 * Array-valued params emit one key=value pair per element. Keys and values are percent-encoded.
 * offset and limit are appended last so they appear at a predictable position in Link headers.
 */
function buildQueryString(
  query: Record<string, string | string[]>,
  offset: number,
  limit: number,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key === 'offset' || key === 'limit' || key === 'cursor') continue;
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      params.append(key, v);
    }
  }
  params.append('offset', String(offset));
  params.append('limit', String(limit));
  return params.toString();
}

export interface PaginationTransformResult {
  readonly body: JsonValue;
  readonly headers: Record<string, string>;
}

/**
 * Re-shape a collection response per the requested pagination style.
 * Non-collection bodies (single entities) pass through untouched.
 */
export function applyPaginationStyle(
  body: JsonValue | null | undefined,
  style: PaginationStyle,
  query: Record<string, string | string[]>,
  requestPath: string,
): PaginationTransformResult {
  const headers: Record<string, string> = {};

  // Normalise the collection into (items, meta) regardless of incoming shape.
  let items: JsonValue[] | null = null;
  let totalCount: number;
  let offset: number;
  let limit: number;

  if (isEnvelope(body)) {
    items = [...body.items];
    totalCount = body.totalCount;
    offset = body.offset;
    limit = body.limit;
  } else if (Array.isArray(body)) {
    items = [...body];
    totalCount = items.length;
    offset = 0;
    const limitQ = firstQuery(query['limit']);
    limit = limitQ !== undefined ? Math.max(0, parseInt(limitQ, 10) || 0) : items.length;
  } else {
    // Not a collection — nothing to do.
    return { body: body ?? null, headers };
  }

  const hasMore = offset + items.length < totalCount;

  if (style === 'envelope') {
    return {
      body: { items, totalCount, offset, limit, hasMore },
      headers,
    };
  }

  // Both 'raw' and 'link-header' return a bare array body.
  if (style === 'link-header') {
    const basePath = requestPath.split('?', 1)[0] ?? requestPath;
    const links: string[] = [];
    if (limit > 0) {
      if (hasMore) {
        const nextOffset = offset + items.length;
        links.push(`<${basePath}?${buildQueryString(query, nextOffset, limit)}>; rel="next"`);
      }
      if (offset > 0) {
        const prevOffset = Math.max(0, offset - limit);
        links.push(`<${basePath}?${buildQueryString(query, prevOffset, limit)}>; rel="prev"`);
      }
    }
    if (links.length > 0) headers['Link'] = links.join(', ');
    headers['X-Total-Count'] = String(totalCount);
  }

  return { body: items, headers };
}

/** Best-effort extraction of an entity id for JSON:API / HAL self links. */
function entityId(obj: JsonObject): string | undefined {
  const id = obj['id'];
  return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined;
}

/**
 * Transform a success body into the requested representation. `plain` is a no-op.
 * `resourceType` is used as the JSON:API `type` (typically the boundary name).
 */
export function applyResponseFormat(
  body: JsonValue | null | undefined,
  format: ResponseFormat,
  resourceType: string,
  requestPath: string,
): JsonValue {
  if (body === null || body === undefined) return body ?? null;
  if (format === 'plain') return body;

  const selfPath = requestPath.split('?', 1)[0] ?? requestPath;

  if (format === 'hal') {
    if (Array.isArray(body)) {
      return {
        _embedded: { items: body as JsonValue[] },
        _links: { self: { href: selfPath } },
      };
    }
    if (isEnvelope(body)) {
      return {
        _embedded: { items: body.items },
        _links: { self: { href: selfPath } },
        totalCount: body.totalCount,
        offset: body.offset,
        limit: body.limit,
        hasMore: body.hasMore,
      };
    }
    if (isPlainObject(body)) {
      // Merge a self link without clobbering any existing _links from HATEOAS.
      const existingLinks = isPlainObject(body['_links']) ? body['_links'] : {};
      return {
        ...body,
        _links: { self: { href: selfPath }, ...existingLinks },
      };
    }
    return body;
  }

  // format === 'jsonapi'
  const toResource = (obj: JsonValue): JsonObject => {
    if (!isPlainObject(obj)) return { type: resourceType, attributes: obj };
    const attributes = { ...obj };
    delete attributes['id'];
    const id = entityId(obj);
    return {
      type: resourceType,
      ...(id !== undefined ? { id } : {}),
      attributes,
    };
  };

  if (Array.isArray(body)) {
    return { data: body.map(toResource) };
  }
  if (isEnvelope(body)) {
    return {
      data: body.items.map(toResource),
      meta: {
        totalCount: body.totalCount,
        offset: body.offset,
        limit: body.limit,
        hasMore: body.hasMore,
      },
    };
  }
  return { data: toResource(body) };
}
