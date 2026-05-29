/**
 * CRM E2E test helpers — provides graph/event inspection via admin endpoints
 * so e2e tests can verify internal state through the full Specmatic stack.
 *
 * These replace direct sys.graph.get() / sys.events.byAggregate() calls
 * used in integration tests with HTTP queries to /_admin/ endpoints.
 */

import type { E2eApp } from './e2e-test-app';

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
  const res = await fetch(`${engineUrl}/_engine/forward`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, path, headers, query, body }),
  });
  return res.json() as Promise<ForwardedResponse>;
}

export async function adminReset(engineUrl: string): Promise<void> {
  await fetch(`${engineUrl}/_admin/reset`, { method: 'POST' });
}

export function javaAvailable(): boolean {
  try {
    require('child_process').execSync('java -version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
