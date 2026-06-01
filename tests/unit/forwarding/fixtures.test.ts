/**
 * Unit tests for src/forwarding/fixtures.ts (deriveFixtures) and
 * the createFixturesHandler (ETag / 304 behaviour).
 *
 * Test coverage:
 *  - Happy path: baseline entities produce correct FixtureStubs.
 *  - Boundary with no GET-by-id path → no fixtures emitted for that boundary.
 *  - Baseline entity that violates the OpenAPI response schema → skipped with warning.
 *  - Checksum is stable across multiple calls with unchanged data.
 *  - Handler: If-None-Match matching checksum → 304.
 *  - Handler: Cache-Control + ETag headers on 200 response.
 */

import express from 'express';
import { createHash } from 'node:crypto';
import { deriveFixtures } from '../../../src/forwarding/fixtures.js';
import { createFixturesHandler } from '../../../src/forwarding/handler.js';
import type { BootedSystem } from '../../../src/engine/boot.js';
import type { FixturesResponse, FixtureStub } from '../../../src/forwarding/types.js';
import type { DomainEvent, JsonObject } from '../../../src/types.js';
import {
  withPersistentServer,
  type PersistentAgent,
} from '../../_support/persistentAgent.js';
import { registerFileTeardown } from '../../_support/testTeardown.js';

// ---------------------------------------------------------------------------
// Helpers — minimal stub builders
// ---------------------------------------------------------------------------

function makeBaselineEvent(
  boundary: string,
  aggregateId: string,
): DomainEvent {
  return {
    eventId: `evt-${aggregateId}`,
    type: 'BaselineEntityCreatedEvent',
    boundary,
    aggregateId,
    payload: {},
    timestamp: '1970-01-01T00:00:00.000Z',
    sequenceVersion: 1,
    causedBy: null,
  };
}

/**
 * Build a minimal BootedSystem stub for deriveFixtures unit tests.
 *
 * openapi.paths must contain a collection path and, optionally, a by-id path.
 * graph.get(id) returns the entity for known ids, null otherwise.
 */
function makeStubSystem(opts: {
  boundaryName: string;
  collectionPath: string;
  byIdPath?: string;        // e.g. '/customers/{id}' — include to enable fixture
  entities: Record<string, Record<string, unknown>>;
  baselineIds: string[];
  /** Optional raw schema for the by-id GET 200 response. Default: none (no validation). */
  responseSchema?: Record<string, unknown>;
}): BootedSystem {
  // Build OpenAPI paths
  const paths: Record<string, unknown> = {
    [opts.collectionPath]: {
      get: { operationId: `list-${opts.boundaryName}` },
      post: { operationId: `create-${opts.boundaryName}` },
    },
  };

  if (opts.byIdPath) {
    const responseSchemas: Record<string, unknown> = {};
    if (opts.responseSchema) {
      responseSchemas['200'] = opts.responseSchema;
    }
    paths[opts.byIdPath] = {
      get: {
        operationId: `get-${opts.boundaryName}`,
        ...(Object.keys(responseSchemas).length > 0 ? { responseSchemas } : {}),
      },
    };
  }

  const frozenBaseline: readonly DomainEvent[] = Object.freeze(
    opts.baselineIds.map((id) => makeBaselineEvent(opts.boundaryName, id)),
  );

  return {
    dsl: {
      boundaries: [
        {
          boundary: opts.boundaryName,
          contractPath: opts.collectionPath,
          fallbackOverride: true,
          behaviors: [],
          reducers: [],
          eventCatalog: [],
          initialization: opts.baselineIds.map((id) => ({ id, ...opts.entities[id] })),
        },
      ],
      byContractPath: {},
      byBoundaryName: {},
    },
    openapi: {
      raw: { components: { schemas: {} } },
      paths: paths as never,
    },
    graph: {
      get: (id: string) => (opts.entities[id] as JsonObject) ?? null,
      set: () => undefined,
      delete: () => undefined,
      keys: () => Object.freeze(Object.keys(opts.entities)),
      values: () => Object.freeze(Object.values(opts.entities) as JsonObject[]),
      entries: () => Object.freeze(Object.entries(opts.entities) as readonly (readonly [string, JsonObject])[]),
      purge: () => undefined,
      size: () => Object.keys(opts.entities).length,
    },
    frozenBaseline,
    cel: {
      evaluate: () => null,
    },
    // Cast remaining required fields that are not used by deriveFixtures
    events: undefined as never,
    validator: undefined as never,
    logger: undefined as never,
    tracer: undefined as never,
    metrics: undefined as never,
    schemaRegistry: undefined as never,
    requiresPrecondition: () => false,
    derivedProjections: undefined as never,
  } as unknown as BootedSystem;
}

// ---------------------------------------------------------------------------
// Test suite — deriveFixtures
// ---------------------------------------------------------------------------

describe('deriveFixtures', () => {
  const CUSTOMER_ID_1 = '00000000-0000-7000-8000-000000000001';
  const CUSTOMER_ID_2 = '00000000-0000-7000-8000-000000000002';

  // ── Happy path ─────────────────────────────────────────────────────────────

  it('returns one FixtureStub per baseline entity when a GET-by-id path exists', () => {
    const sys = makeStubSystem({
      boundaryName: 'Customer',
      collectionPath: '/customers',
      byIdPath: '/customers/{id}',
      entities: {
        [CUSTOMER_ID_1]: { id: CUSTOMER_ID_1, name: 'Acme Coffee', riskBand: 'LOW' },
        [CUSTOMER_ID_2]: { id: CUSTOMER_ID_2, name: 'Beta Builders', riskBand: 'MED' },
      },
      baselineIds: [CUSTOMER_ID_1, CUSTOMER_ID_2],
    });

    const stubs = deriveFixtures(sys);

    expect(stubs).toHaveLength(2);
    const paths = stubs.map((s) => s.httpRequest.path).sort();
    expect(paths).toEqual([
      `/customers/${CUSTOMER_ID_1}`,
      `/customers/${CUSTOMER_ID_2}`,
    ].sort());
  });

  it('sets method to GET on all stubs', () => {
    const sys = makeStubSystem({
      boundaryName: 'Customer',
      collectionPath: '/customers',
      byIdPath: '/customers/{id}',
      entities: { [CUSTOMER_ID_1]: { id: CUSTOMER_ID_1, name: 'Acme' } },
      baselineIds: [CUSTOMER_ID_1],
    });

    const stubs = deriveFixtures(sys);
    expect(stubs[0]!.httpRequest.method).toBe('GET');
  });

  it('stub body matches the entity in the state graph', () => {
    const entity = { id: CUSTOMER_ID_1, name: 'Acme Coffee', riskBand: 'LOW' };
    const sys = makeStubSystem({
      boundaryName: 'Customer',
      collectionPath: '/customers',
      byIdPath: '/customers/{id}',
      entities: { [CUSTOMER_ID_1]: entity },
      baselineIds: [CUSTOMER_ID_1],
    });

    const stubs = deriveFixtures(sys);
    expect(stubs[0]!.httpResponse.body).toEqual(entity);
  });

  it('stub source fields reflect boundary, aggregateId, and contractPath', () => {
    const sys = makeStubSystem({
      boundaryName: 'Customer',
      collectionPath: '/customers',
      byIdPath: '/customers/{id}',
      entities: { [CUSTOMER_ID_1]: { id: CUSTOMER_ID_1 } },
      baselineIds: [CUSTOMER_ID_1],
    });

    const stubs = deriveFixtures(sys);
    expect(stubs[0]!.source).toEqual({
      boundary: 'Customer',
      aggregateId: CUSTOMER_ID_1,
      contractPath: '/customers/{id}',
    });
  });

  // ── No GET-by-id path ──────────────────────────────────────────────────────

  it('returns no fixtures when the boundary has no GET-by-id path template', () => {
    const sys = makeStubSystem({
      boundaryName: 'Customer',
      collectionPath: '/customers',
      // byIdPath intentionally omitted
      entities: { [CUSTOMER_ID_1]: { id: CUSTOMER_ID_1 } },
      baselineIds: [CUSTOMER_ID_1],
    });

    const stubs = deriveFixtures(sys);
    expect(stubs).toHaveLength(0);
  });

  it('returns no fixtures when the by-id path exists but has no GET operation', () => {
    // Manually build a system where /customers/{id} has only POST (no GET)
    const sys = makeStubSystem({
      boundaryName: 'Customer',
      collectionPath: '/customers',
      // No byIdPath — we'll patch the openapi below
      entities: { [CUSTOMER_ID_1]: { id: CUSTOMER_ID_1 } },
      baselineIds: [CUSTOMER_ID_1],
    });

    // Patch openapi.paths to have /customers/{id} but only a POST operation
    const paths = sys.openapi.paths as Record<string, unknown>;
    paths['/customers/{id}'] = { post: { operationId: 'create-by-id' } };

    const stubs = deriveFixtures(sys);
    expect(stubs).toHaveLength(0);
  });

  // ── Schema validation — skip on failure ───────────────────────────────────

  it('skips entities that fail the OpenAPI response schema and emits no fixture for them', () => {
    const sys = makeStubSystem({
      boundaryName: 'Customer',
      collectionPath: '/customers',
      byIdPath: '/customers/{id}',
      entities: {
        [CUSTOMER_ID_1]: { id: CUSTOMER_ID_1, name: 'Acme Coffee', riskBand: 'LOW' },
        // Missing required 'name' field — will fail schema validation
        [CUSTOMER_ID_2]: { id: CUSTOMER_ID_2 } as Record<string, unknown>,
      },
      baselineIds: [CUSTOMER_ID_1, CUSTOMER_ID_2],
      responseSchema: {
        type: 'object',
        required: ['id', 'name', 'riskBand'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          riskBand: { type: 'string' },
        },
      },
    });

    const stubs = deriveFixtures(sys);
    // Only CUSTOMER_ID_1 should pass; CUSTOMER_ID_2 should be skipped
    expect(stubs).toHaveLength(1);
    expect(stubs[0]!.source.aggregateId).toBe(CUSTOMER_ID_1);
  });

  // ── Empty baseline ─────────────────────────────────────────────────────────

  it('returns an empty array when there are no baseline events', () => {
    const sys = makeStubSystem({
      boundaryName: 'Customer',
      collectionPath: '/customers',
      byIdPath: '/customers/{id}',
      entities: {},
      baselineIds: [],
    });

    const stubs = deriveFixtures(sys);
    expect(stubs).toHaveLength(0);
  });

  // ── Non-baseline events are excluded ──────────────────────────────────────

  it('does not emit fixtures for non-baseline events', () => {
    // Build a system whose frozenBaseline includes both a baseline event for CUSTOMER_ID_1
    // and a non-baseline event for CUSTOMER_ID_2.  Only CUSTOMER_ID_1 should produce a stub.
    const mixedBaseline: readonly DomainEvent[] = Object.freeze([
      makeBaselineEvent('Customer', CUSTOMER_ID_1),
      {
        eventId: 'evt-post-boot',
        type: 'CustomerRegistered',    // NOT a BaselineEntityCreatedEvent
        boundary: 'Customer',
        aggregateId: CUSTOMER_ID_2,
        payload: { id: CUSTOMER_ID_2 },
        timestamp: '2024-01-01T00:00:00.000Z',
        sequenceVersion: 1,
        causedBy: null,
      },
    ]);

    const sys = makeStubSystem({
      boundaryName: 'Customer',
      collectionPath: '/customers',
      byIdPath: '/customers/{id}',
      entities: {
        [CUSTOMER_ID_1]: { id: CUSTOMER_ID_1, name: 'Acme' },
        [CUSTOMER_ID_2]: { id: CUSTOMER_ID_2, name: 'Beta' },
      },
      baselineIds: [CUSTOMER_ID_1],
    });

    // Replace frozenBaseline with our mixed array (object is not sealed at top level)
    Object.assign(sys, { frozenBaseline: mixedBaseline });

    const stubs = deriveFixtures(sys);
    // Only CUSTOMER_ID_1 should appear; CUSTOMER_ID_2 was not a baseline event
    expect(stubs).toHaveLength(1);
    expect(stubs[0]!.source.aggregateId).toBe(CUSTOMER_ID_1);
  });
});

// ---------------------------------------------------------------------------
// Test suite — checksum stability
// ---------------------------------------------------------------------------

describe('deriveFixtures — checksum stability', () => {
  const ID = '00000000-0000-7000-8000-000000000001';

  it('produces a stable checksum across multiple calls', () => {
    const sys = makeStubSystem({
      boundaryName: 'Customer',
      collectionPath: '/customers',
      byIdPath: '/customers/{id}',
      entities: { [ID]: { id: ID, name: 'Acme' } },
      baselineIds: [ID],
    });

    const stubs1 = deriveFixtures(sys);
    const stubs2 = deriveFixtures(sys);

    // Compute checksum the same way the handler does
    function checksum(stubs: readonly FixtureStub[]) {
      const sorted = [...stubs].sort((a, b) =>
        a.httpRequest.path.localeCompare(b.httpRequest.path),
      );
      return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
    }

    expect(checksum(stubs1)).toBe(checksum(stubs2));
    expect(checksum(stubs1)).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Test suite — createFixturesHandler HTTP behaviour
// ---------------------------------------------------------------------------

async function makeHandlerAgent(sys: BootedSystem): Promise<PersistentAgent> {
  const app = express();
  app.get('/_engine/fixtures', createFixturesHandler(sys));
  const persistent = await withPersistentServer(app);
  registerFileTeardown(persistent.close);
  return persistent.agent;
}

describe('createFixturesHandler — GET /_engine/fixtures', () => {
  const CUSTOMER_ID = '00000000-0000-7000-8000-000000000001';

  let sys: BootedSystem;
  let agent: PersistentAgent;

  beforeEach(async () => {
    delete process.env['ENGINE_ROUTES_TTL_SECONDS'];
    sys = makeStubSystem({
      boundaryName: 'Customer',
      collectionPath: '/customers',
      byIdPath: '/customers/{id}',
      entities: { [CUSTOMER_ID]: { id: CUSTOMER_ID, name: 'Acme Coffee', riskBand: 'LOW' } },
      baselineIds: [CUSTOMER_ID],
    });
    agent = await makeHandlerAgent(sys);
  });

  afterEach(() => {
    delete process.env['ENGINE_ROUTES_TTL_SECONDS'];
  });

  // ── Basic response shape ───────────────────────────────────────────────────

  it('returns HTTP 200', async () => {
    await agent.get('/_engine/fixtures').expect(200);
  });

  it('returns engine field equal to "potemkin-stateful"', async () => {
    const res = await agent.get('/_engine/fixtures').expect(200);
    expect((res.body as FixturesResponse).engine).toBe('potemkin-stateful');
  });

  it('returns a non-empty version string', async () => {
    const res = await agent.get('/_engine/fixtures').expect(200);
    expect(typeof (res.body as FixturesResponse).version).toBe('string');
    expect((res.body as FixturesResponse).version.length).toBeGreaterThan(0);
  });

  it('returns a generatedAt ISO-8601 timestamp', async () => {
    const res = await agent.get('/_engine/fixtures').expect(200);
    const { generatedAt } = res.body as FixturesResponse;
    expect(new Date(generatedAt).toISOString()).toBe(generatedAt);
  });

  it('returns a checksum that is a 64-char hex string', async () => {
    const res = await agent.get('/_engine/fixtures').expect(200);
    expect((res.body as FixturesResponse).checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns an array of fixtures', async () => {
    const res = await agent.get('/_engine/fixtures').expect(200);
    expect(Array.isArray((res.body as FixturesResponse).fixtures)).toBe(true);
  });

  it('includes a fixture with the correct path for the seeded entity', async () => {
    const res = await agent.get('/_engine/fixtures').expect(200);
    const { fixtures } = res.body as FixturesResponse;
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]!.httpRequest.path).toBe(`/customers/${CUSTOMER_ID}`);
  });

  // ── Cache headers ──────────────────────────────────────────────────────────

  it('includes Cache-Control: max-age=30, public header by default', async () => {
    const res = await agent.get('/_engine/fixtures').expect(200);
    expect(res.headers['cache-control']).toBe('max-age=30, public');
  });

  it('includes ETag header equal to the checksum', async () => {
    const res = await agent.get('/_engine/fixtures').expect(200);
    const { checksum } = res.body as FixturesResponse;
    expect(res.headers['etag']).toBe(checksum);
  });

  // ── Conditional requests (If-None-Match) ──────────────────────────────────

  it('responds 304 when If-None-Match matches the current checksum', async () => {
    const first = await agent.get('/_engine/fixtures').expect(200);
    const checksum = (first.body as FixturesResponse).checksum;

    const res = await agent
      .get('/_engine/fixtures')
      .set('If-None-Match', checksum)
      .expect(304);

    expect(res.text).toBe('');
  });

  it('responds 200 with full body when If-None-Match does not match', async () => {
    const staleChecksum = 'a'.repeat(64);

    const res = await agent
      .get('/_engine/fixtures')
      .set('If-None-Match', staleChecksum)
      .expect(200);

    expect(Array.isArray((res.body as FixturesResponse).fixtures)).toBe(true);
  });

  // ── TTL respects ENGINE_ROUTES_TTL_SECONDS ────────────────────────────────

  it('honours ENGINE_ROUTES_TTL_SECONDS env var for Cache-Control TTL', async () => {
    process.env['ENGINE_ROUTES_TTL_SECONDS'] = '120';
    const agentWithOverride = await makeHandlerAgent(sys);

    const res = await agentWithOverride.get('/_engine/fixtures').expect(200);
    expect(res.headers['cache-control']).toBe('max-age=120, public');
  });
});
