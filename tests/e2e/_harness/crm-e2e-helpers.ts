/**
 * CRM E2E test helpers — provides graph/event inspection via admin endpoints
 * so e2e tests can verify internal state through the full Specmatic stack.
 *
 * These replace direct sys.graph.get() / sys.events.byAggregate() calls
 * used in integration tests with HTTP queries to /_admin/ endpoints.
 */


import { execSync } from 'node:child_process';

export interface JsonObject { [key: string]: unknown }
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

export interface ForwardedResponse {
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

export async function getEventsByAggregate(engineUrl: string, aggregateId: string): Promise<DomainEvent[]> {
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

export async function fwd(
  engineUrl: string,
  method: string,
  path: string,
  body: unknown = null,
  headers: Record<string, string> = {},
  query: Record<string, string> = {},
): Promise<ForwardedResponse> {
  // Contract: the Kotlin plugin lowercases all header keys before POSTing a
  // ForwardedRequest to the engine. The harness must honour the same contract so
  // engine-direct tests exercise the real lowercased-key path (e.g. If-Match →
  // if-match for optimistic-concurrency conflict detection).
  const res = await fetch(`${engineUrl}/_engine/forward`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, path, headers: lowercaseKeys(headers), query, body }),
  });
  return res.json() as Promise<ForwardedResponse>;
}

/** Lowercase every key in a header map, matching the plugin's forwarding contract. */
function lowercaseKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = v;
  }
  return out;
}

export async function adminReset(engineUrl: string): Promise<void> {
  await fetch(`${engineUrl}/_admin/reset`, { method: 'POST' });
}

export function javaAvailable(): boolean {
  try {
    execSync('java -version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
