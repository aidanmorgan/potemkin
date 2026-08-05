/**
 * CRM E2E test helpers — provides graph/event inspection via admin endpoints
 * so e2e tests can verify internal state through the full Specmatic stack.
 *
 * These replace direct sys.graph.get() / sys.events.byAggregate() calls
 * used in integration tests with HTTP queries to /_admin/ endpoints.
 */

export interface JsonObject {
  [key: string]: unknown;
}
export interface DomainEvent {
  eventId: string;
  boundary: string;
  aggregateId: string;
  type: string;
  payload: JsonObject;
  timestamp: string;
  sequenceVersion: number;
  causedBy: string | null;
}

export interface PublicResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export async function getGraphNode(engineUrl: string, id: string): Promise<JsonObject | null> {
  const res = await fetch(`${engineUrl}/_admin/state`);
  const body = (await res.json()) as { entities: Record<string, JsonObject> };
  return body.entities[id] ?? null;
}

export async function getAllEntities(engineUrl: string): Promise<Record<string, JsonObject>> {
  const res = await fetch(`${engineUrl}/_admin/state`);
  const body = (await res.json()) as { entities: Record<string, JsonObject> };
  return body.entities;
}

export async function getEventsByAggregate(
  engineUrl: string,
  aggregateId: string,
): Promise<DomainEvent[]> {
  const res = await fetch(`${engineUrl}/_admin/events?aggregateId=${aggregateId}`);
  const body = (await res.json()) as { events: DomainEvent[] };
  return body.events;
}

export async function getAllEvents(engineUrl: string): Promise<DomainEvent[]> {
  const res = await fetch(`${engineUrl}/_admin/events`);
  const body = (await res.json()) as { events: DomainEvent[] };
  return body.events;
}

export async function getEntityCount(engineUrl: string): Promise<number> {
  const res = await fetch(`${engineUrl}/_admin/health`);
  const body = (await res.json()) as { entityCount: number };
  return body.entityCount;
}

export async function getEventCount(engineUrl: string): Promise<number> {
  const res = await fetch(`${engineUrl}/_admin/health`);
  const body = (await res.json()) as { eventCount: number };
  return body.eventCount;
}

export async function requestThroughSpecmatic(
  stubUrl: string,
  method: string,
  path: string,
  body: unknown = null,
  headers: Record<string, string> = {},
  query: Record<string, string> = {},
): Promise<PublicResponse> {
  const target = new URL(path, `${stubUrl.replace(/\/$/, '')}/`);
  for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);

  // Specmatic may close its pooled keep-alive socket while the plugin is
  // replacing dynamic expectations during a configuration reload. Explicitly
  // close each E2E request so a subsequent request cannot reuse a socket that
  // the JVM has already retired at that lifecycle boundary.
  const requestHeaders: Record<string, string> = { connection: 'close', ...headers };
  if (body !== null && body !== undefined) requestHeaders['content-type'] ??= 'application/json';

  // Public request path: Specmatic validates the request, the plugin decides
  // whether the route is stateful, and only then does it call Potemkin.
  const res = await fetch(target, {
    method,
    headers: requestHeaders,
    ...(body === null || body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let responseBody: unknown = null;
  if (text.length > 0) {
    try {
      responseBody = JSON.parse(text) as unknown;
    } catch {
      responseBody = text;
    }
  }
  return {
    status: res.status,
    body: responseBody,
    headers: Object.fromEntries(res.headers.entries()),
  };
}

export async function adminReset(engineUrl: string): Promise<void> {
  await fetch(`${engineUrl}/_admin/reset`, { method: 'POST' });
}
