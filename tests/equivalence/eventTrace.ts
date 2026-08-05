import type { JsonValue } from '../../src/contracts/value.js';

export interface EventNameMap {
  readonly [canonicalName: string]: string;
}

export interface EventTracePolicy {
  /** Maps an authoring/provider event name to the canonical comparison name. */
  readonly eventNameMap?: EventNameMap;
  /** Canonical names which are internal tau steps and may be absorbed. */
  readonly tauEvents?: readonly string[];
  /** Returns the independence class; different defined classes may reorder. */
  readonly independenceKey?: (event: JsonValue) => string | undefined;
  /** JSON paths relative to each event that providers are free to vary. */
  readonly volatilePaths?: readonly string[];
}

export type EventTraceDivergenceCode =
  | 'EVENT_TRACE_MISSING'
  | 'EVENT_TRACE_EXTRA'
  | 'EVENT_TRACE_NAME_MISMATCH'
  | 'EVENT_TRACE_ORDER_MISMATCH'
  | 'EVENT_TRACE_BODY_MISMATCH'
  | 'EVENT_TRACE_ID_CONTRADICTION';

export interface EventTraceDivergence {
  readonly code: EventTraceDivergenceCode;
  readonly index: number;
  readonly path: string;
  readonly message: string;
  readonly expected?: JsonValue | string;
  readonly actual?: JsonValue | string;
}

export interface EventTraceComparison {
  readonly conforms: boolean;
  readonly divergences: readonly EventTraceDivergence[];
}

interface NormalizedEvent {
  readonly name: string;
  readonly value: JsonValue;
  readonly independenceKey: string | undefined;
}

interface IdentifierBijection {
  readonly leftToRight: Map<string, string>;
  readonly rightToLeft: Map<string, string>;
}

/**
 * Compare two observable traces using the optional event-trace relation.
 *
 * Tau events are removed, then contiguous events from distinct independence
 * classes are canonically ordered. All remaining observable events must match
 * in order and payload; identifiers are compared through one coherent
 * bijection, so a reused provider id cannot silently map to two model ids.
 */
export function compareWeakEventTrace(
  expected: readonly JsonValue[],
  actual: readonly JsonValue[],
  policy: EventTracePolicy = {},
): EventTraceComparison {
  const expectedEvents = reorderIndependent(normalizeEvents(expected, policy), policy);
  const actualEvents = reorderIndependent(normalizeEvents(actual, policy), policy);
  const mapping: IdentifierBijection = { leftToRight: new Map(), rightToLeft: new Map() };
  const divergences: EventTraceDivergence[] = [];
  const length = Math.max(expectedEvents.length, actualEvents.length);

  for (let index = 0; index < length; index += 1) {
    const left = expectedEvents[index];
    const right = actualEvents[index];
    if (left === undefined) {
      divergences.push({
        code: 'EVENT_TRACE_EXTRA',
        index,
        path: `$[${index}]`,
        actual: right!.value,
        message: `Actual trace contains an extra observable event ${right!.name}`,
      });
      continue;
    }
    if (right === undefined) {
      divergences.push({
        code: 'EVENT_TRACE_MISSING',
        index,
        path: `$[${index}]`,
        expected: left.value,
        message: `Actual trace is missing observable event ${left.name}`,
      });
      continue;
    }
    if (left.name !== right.name) {
      const code = sameIndependenceClass(left, right)
        ? 'EVENT_TRACE_ORDER_MISMATCH'
        : 'EVENT_TRACE_NAME_MISMATCH';
      divergences.push({
        code,
        index,
        path: `$[${index}].name`,
        expected: left.name,
        actual: right.name,
        message:
          code === 'EVENT_TRACE_ORDER_MISMATCH'
            ? `Dependent event order differs at index ${index}`
            : `Expected event ${left.name}, received ${right.name}`,
      });
      continue;
    }
    compareValue(left.value, right.value, `$[${index}]`, mapping, policy, divergences, index);
  }

  return { conforms: divergences.length === 0, divergences: Object.freeze(divergences) };
}

function normalizeEvents(
  events: readonly JsonValue[],
  policy: EventTracePolicy,
): readonly NormalizedEvent[] {
  const tau = new Set(policy.tauEvents ?? []);
  return events.flatMap((value) => {
    const name = canonicalName(eventName(value), policy.eventNameMap ?? {});
    if (tau.has(name) || isSilent(value)) return [];
    return [
      {
        name,
        value: replaceEventName(value, name),
        independenceKey: policy.independenceKey?.(value),
      },
    ];
  });
}

function reorderIndependent(
  events: readonly NormalizedEvent[],
  policy: EventTracePolicy,
): readonly NormalizedEvent[] {
  if (policy.independenceKey === undefined) return events;
  const result: NormalizedEvent[] = [];
  let index = 0;
  while (index < events.length) {
    const block: NormalizedEvent[] = [events[index]!];
    let next = index + 1;
    while (next < events.length) {
      const candidate = events[next]!;
      if (
        candidate.independenceKey === undefined ||
        block.some(
          (event) =>
            event.independenceKey === undefined ||
            event.independenceKey === candidate.independenceKey,
        )
      )
        break;
      block.push(candidate);
      next += 1;
    }
    result.push(...block.sort(compareIndependentEvents));
    index = next;
  }
  return result;
}

function compareIndependentEvents(left: NormalizedEvent, right: NormalizedEvent): number {
  return (
    left.name.localeCompare(right.name) ||
    (left.independenceKey ?? '').localeCompare(right.independenceKey ?? '')
  );
}

function sameIndependenceClass(left: NormalizedEvent, right: NormalizedEvent): boolean {
  return (
    left.independenceKey !== undefined &&
    right.independenceKey !== undefined &&
    left.independenceKey === right.independenceKey
  );
}

function compareValue(
  expected: JsonValue,
  actual: JsonValue,
  path: string,
  mapping: IdentifierBijection,
  policy: EventTracePolicy,
  divergences: EventTraceDivergence[],
  index: number,
): void {
  if (policy.volatilePaths?.some((candidate) => candidate === path)) return;
  if (typeof expected === 'string' && typeof actual === 'string' && looksLikeIdentifierPath(path)) {
    if (!bindIdentifier(mapping, expected, actual)) {
      divergences.push({
        code: 'EVENT_TRACE_ID_CONTRADICTION',
        index,
        path,
        expected,
        actual,
        message: `Identifier mapping contradicts the event trace at ${path}`,
      });
    }
    return;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      divergences.push({
        code: 'EVENT_TRACE_BODY_MISMATCH',
        index,
        path,
        expected,
        actual,
        message: `Event arrays differ at ${path}`,
      });
      return;
    }
    expected.forEach((value, childIndex) =>
      compareValue(
        value,
        actual[childIndex]!,
        `${path}[${childIndex}]`,
        mapping,
        policy,
        divergences,
        index,
      ),
    );
    return;
  }
  if (isRecord(expected) && isRecord(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of keys) {
      const left = expected[key];
      const right = actual[key];
      if (left === undefined || right === undefined) {
        divergences.push({
          code: 'EVENT_TRACE_BODY_MISMATCH',
          index,
          path: `${path}.${key}`,
          expected: left,
          actual: right,
          message: `Event field ${path}.${key} is missing on one side`,
        });
        continue;
      }
      compareValue(left, right, `${path}.${key}`, mapping, policy, divergences, index);
    }
    return;
  }
  if (!Object.is(expected, actual)) {
    divergences.push({
      code: 'EVENT_TRACE_BODY_MISMATCH',
      index,
      path,
      expected,
      actual,
      message: `Event payload differs at ${path}`,
    });
  }
}

function eventName(value: JsonValue): string {
  if (isRecord(value)) {
    for (const key of ['type', 'name', 'eventType']) {
      if (typeof value[key] === 'string') return value[key];
    }
  }
  return '<anonymous>';
}

function canonicalName(value: string, map: EventNameMap): string {
  if (map[value] !== undefined) return value;
  return Object.entries(map).find(([, mapped]) => mapped === value)?.[0] ?? value;
}

function replaceEventName(value: JsonValue, name: string): JsonValue {
  if (!isRecord(value)) return value;
  const key = ['type', 'name', 'eventType'].find((candidate) => candidate in value);
  return key === undefined ? value : { ...value, [key]: name };
}

function isSilent(value: JsonValue): boolean {
  return isRecord(value) && value['observable'] === false;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return (
    value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
  );
}

function looksLikeIdentifierPath(path: string): boolean {
  return /(?:^|\.)(?:id|.*Id|aggregateId|latest_charge|client_secret)$/.test(path);
}

function bindIdentifier(mapping: IdentifierBijection, expected: string, actual: string): boolean {
  const existingActual = mapping.leftToRight.get(expected);
  const existingExpected = mapping.rightToLeft.get(actual);
  if (existingActual !== undefined && existingActual !== actual) return false;
  if (existingExpected !== undefined && existingExpected !== expected) return false;
  mapping.leftToRight.set(expected, actual);
  mapping.rightToLeft.set(actual, expected);
  return true;
}
