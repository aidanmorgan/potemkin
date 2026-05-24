/**
 * fault-simulation.integration.test.ts
 *
 * Integration test: pass a faultSignal directly on the Command; assert:
 *  - UoW returns the canned response.
 *  - faultsSimulatedTotal metric is incremented.
 */

import { bootSystem, type BootedSystem } from '../../src/engine/boot.js';
import { executeUnitOfWork } from '../../src/engine/uow.js';
import { resetSystem } from '../../src/engine/reset.js';
import { loadCrmFixture } from '../fixtures/index.js';
import { createEngineMetrics } from '../../src/observability/metrics.js';
import { createInMemoryOtel, collectMetricDataPoints } from './_helpers/otel.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';

describe('fault-simulation.integration: faultSignal on Command bypasses execution', () => {
  let sys: BootedSystem;

  beforeEach(async () => {
    const fixture = await loadCrmFixture();
    sys = await bootSystem(fixture);
  });

  afterEach(() => {
    resetSystem(sys);
  });

  it('returns the canned status and body from the faultSignal', async () => {
    const faultSignal = JSON.stringify({ status: 503, body: { error: 'SERVICE_UNAVAILABLE' } });

    const result = await executeUnitOfWork({
      command: {
        commandId: nextUuidv7(),
        boundary: 'Lead',
        intent: 'creation',
        targetId: nextUuidv7(),
        payload: {
          companyName: 'Ghost Corp',
          contactName: 'Ghost User',
          phone: '+61 2 9000 0000',
          email: 'ghost@ghost.com',
          source: 'COLD_LIST',
        },
        queryParams: {},
        httpMethod: 'POST',
        path: '/leads',
        origin: 'inbound',
        depth: 0,
        faultSignal,
      },
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      schemaRegistry: sys.schemaRegistry,
    });

    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: 'SERVICE_UNAVAILABLE' });
  });

  it('returns zero committed events when fault is simulated', async () => {
    const faultSignal = JSON.stringify({ status: 500, body: { error: 'FORCED' } });

    const result = await executeUnitOfWork({
      command: {
        commandId: nextUuidv7(),
        boundary: 'Lead',
        intent: 'creation',
        targetId: nextUuidv7(),
        payload: {
          companyName: 'Ghost Corp',
          contactName: 'Ghost User',
          phone: '+61 2 9000 0000',
          email: 'ghost@ghost.com',
          source: 'COLD_LIST',
        },
        queryParams: {},
        httpMethod: 'POST',
        path: '/leads',
        origin: 'inbound',
        depth: 0,
        faultSignal,
      },
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      schemaRegistry: sys.schemaRegistry,
    });

    expect(result.events).toHaveLength(0);
  });

  it('does not mutate the state graph when fault is simulated', async () => {
    const graphSizeBefore = sys.graph.size();
    const faultSignal = JSON.stringify({ status: 503, body: {} });

    await executeUnitOfWork({
      command: {
        commandId: nextUuidv7(),
        boundary: 'Lead',
        intent: 'creation',
        targetId: nextUuidv7(),
        payload: {
          companyName: 'Ghost Corp',
          contactName: 'Ghost User',
          phone: '+61 2 9000 0000',
          email: 'ghost@ghost.com',
          source: 'COLD_LIST',
        },
        queryParams: {},
        httpMethod: 'POST',
        path: '/leads',
        origin: 'inbound',
        depth: 0,
        faultSignal,
      },
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      schemaRegistry: sys.schemaRegistry,
    });

    expect(sys.graph.size()).toBe(graphSizeBefore);
  });

  it('does not append events to the event store when fault is simulated', async () => {
    const sizeBefore = sys.events.size();
    const faultSignal = JSON.stringify({ status: 503, body: {} });

    await executeUnitOfWork({
      command: {
        commandId: nextUuidv7(),
        boundary: 'Lead',
        intent: 'creation',
        targetId: nextUuidv7(),
        payload: {
          companyName: 'Ghost Corp',
          contactName: 'Ghost User',
          phone: '+61 2 9000 0000',
          email: 'ghost@ghost.com',
          source: 'COLD_LIST',
        },
        queryParams: {},
        httpMethod: 'POST',
        path: '/leads',
        origin: 'inbound',
        depth: 0,
        faultSignal,
      },
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      schemaRegistry: sys.schemaRegistry,
    });

    expect(sys.events.size()).toBe(sizeBefore);
  });

  it('increments faultsSimulatedTotal metric when fault is triggered', async () => {
    const otel = createInMemoryOtel();
    const metrics = createEngineMetrics(otel.meterProvider.getMeter('test'));

    const faultSignal = JSON.stringify({ status: 503, body: {} });

    await executeUnitOfWork({
      command: {
        commandId: nextUuidv7(),
        boundary: 'Lead',
        intent: 'creation',
        targetId: nextUuidv7(),
        payload: {
          companyName: 'Ghost Corp',
          contactName: 'Ghost User',
          phone: '+61 2 9000 0000',
          email: 'ghost@ghost.com',
          source: 'COLD_LIST',
        },
        queryParams: {},
        httpMethod: 'POST',
        path: '/leads',
        origin: 'inbound',
        depth: 0,
        faultSignal,
      },
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      schemaRegistry: sys.schemaRegistry,
      metrics,
    });

    await otel.meterProvider.forceFlush();
    const values = await collectMetricDataPoints(otel.metricExporter, 'engine.faults_simulated.total');

    // The counter should have been incremented at least once
    expect(values.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1);

    await otel.teardown();
  });

  it('forwards canned headers from the faultSignal', async () => {
    const faultSignal = JSON.stringify({
      status: 503,
      body: {},
      headers: { 'x-fault-reason': 'planned-maintenance' },
    });

    const result = await executeUnitOfWork({
      command: {
        commandId: nextUuidv7(),
        boundary: 'Lead',
        intent: 'creation',
        targetId: nextUuidv7(),
        payload: {
          companyName: 'Ghost Corp',
          contactName: 'Ghost User',
          phone: '+61 2 9000 0000',
          email: 'ghost@ghost.com',
          source: 'COLD_LIST',
        },
        queryParams: {},
        httpMethod: 'POST',
        path: '/leads',
        origin: 'inbound',
        depth: 0,
        faultSignal,
      },
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      schemaRegistry: sys.schemaRegistry,
    });

    expect(result.headers?.['x-fault-reason']).toBe('planned-maintenance');
  });
});
