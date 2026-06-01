import { resetSystem } from '../../../src/engine/reset';
import { createEventStore } from '../../../src/eventstore/store';
import { createStateGraph } from '../../../src/stategraph/graph';
import { createIdempotencyStore } from '../../../src/idempotency/store';
import { createSessionStore } from '../../../src/identity/sessionStore';
import { createCelEvaluator } from '../../../src/cel/evaluator';
import { createLogger } from '../../../src/observability/logger';
import type { BootedSystem } from '../../../src/engine/boot';
import type { DomainEvent } from '../../../src/types';
import { makeBoundary } from '../_helpers';
import { trace } from '@opentelemetry/api';
import type pino from 'pino';

const QUIET: pino.Level = 'fatal';

function makeBootedSystem(
  frozenBaseline: DomainEvent[] = [],
  boundaries: any[] = [],
): BootedSystem {
  const events = createEventStore();
  const graph = createStateGraph();
  const cel = createCelEvaluator();
  const logger = createLogger({ name: 'test', level: QUIET });
  const tracer = trace.getTracer('test');

  const dsl = {
    boundaries,
    byBoundaryName: Object.fromEntries(boundaries.map((b: any) => [b.boundary, b])),
    byContractPath: {},
  };

  return {
    events,
    graph,
    cel,
    dsl,
    frozenBaseline,
    logger,
    tracer,
    schemaRegistry: undefined as any,
    idempotencyStore: createIdempotencyStore(),
    sessionStore: createSessionStore({ sweepIntervalMs: 0 }),
  } as unknown as BootedSystem;
}

describe('engine/reset', () => {
  it('purges the event store', () => {
    const sys = makeBootedSystem();
    sys.events.append([{
      eventId: 'e1',
      boundary: 'B',
      aggregateId: 'agg-1',
      type: 'System.GenericUpdateEvent',
      payload: {},
      timestamp: '2024-01-01T00:00:00.000Z',
      sequenceVersion: 1,
      causedBy: 'cmd-1',
    }]);
    resetSystem(sys);
    expect(sys.events.size()).toBe(0);
  });

  it('purges the state graph', () => {
    const sys = makeBootedSystem();
    sys.graph.set('agg-1', { id: 'agg-1' });
    resetSystem(sys);
    expect(sys.graph.size()).toBe(0);
  });

  it('restores baseline events to event store', () => {
    const baseline: DomainEvent[] = [{
      eventId: 'base-e1',
      boundary: 'TestBoundary',
      aggregateId: 'agg-1',
      type: 'System.GenericUpdateEvent',
      payload: { status: 'baseline' },
      timestamp: '2024-01-01T00:00:00.000Z',
      sequenceVersion: 1,
      causedBy: null,
    }];
    const boundary = makeBoundary({ boundary: 'TestBoundary' });
    const sys = makeBootedSystem(baseline, [boundary]);
    resetSystem(sys);
    expect(sys.events.size()).toBe(1);
  });

  it('re-projects baseline events onto state graph', () => {
    const baseline: DomainEvent[] = [{
      eventId: 'base-e1',
      boundary: 'TestBoundary',
      aggregateId: 'agg-1',
      type: 'System.GenericUpdateEvent',
      payload: { status: 'reset-ok' },
      timestamp: '2024-01-01T00:00:00.000Z',
      sequenceVersion: 1,
      causedBy: null,
    }];
    const boundary = makeBoundary({ boundary: 'TestBoundary' });
    const sys = makeBootedSystem(baseline, [boundary]);
    resetSystem(sys);
    expect(sys.graph.get('agg-1')?.status).toBe('reset-ok');
  });

  it('does not throw for empty baseline', () => {
    const sys = makeBootedSystem();
    expect(() => resetSystem(sys)).not.toThrow();
  });

  it('is idempotent: double reset produces same state', () => {
    const baseline: DomainEvent[] = [{
      eventId: 'base-e1',
      boundary: 'TestBoundary',
      aggregateId: 'agg-1',
      type: 'System.GenericUpdateEvent',
      payload: { x: 42 },
      timestamp: '2024-01-01T00:00:00.000Z',
      sequenceVersion: 1,
      causedBy: null,
    }];
    const boundary = makeBoundary({ boundary: 'TestBoundary' });
    const sys = makeBootedSystem(baseline, [boundary]);
    resetSystem(sys);
    resetSystem(sys);
    expect(sys.graph.get('agg-1')?.x).toBe(42);
    expect(sys.events.size()).toBe(1);
  });

  it('throws when baseline event references unknown boundary', () => {
    const baseline: DomainEvent[] = [{
      eventId: 'base-e1',
      boundary: 'UnknownBoundary',
      aggregateId: 'agg-1',
      type: 'System.GenericUpdateEvent',
      payload: {},
      timestamp: '2024-01-01T00:00:00.000Z',
      sequenceVersion: 1,
      causedBy: null,
    }];
    const sys = makeBootedSystem(baseline, []); // no boundaries
    expect(() => resetSystem(sys)).toThrow();
  });

  it('clears sessions from the session store on reset', () => {
    const sys = makeBootedSystem();
    const session = sys.sessionStore.create({ id: 'user-1', scopes: [] }, 60_000);
    expect(sys.sessionStore.get(session.id)).not.toBeNull();
    resetSystem(sys);
    expect(sys.sessionStore.get(session.id)).toBeNull();
    expect(sys.sessionStore.size()).toBe(0);
  });
});
