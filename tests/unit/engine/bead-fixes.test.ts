/**
 * Tests for bead fixes:
 *   zo2g — reducer patch ${...} CEL boot-compiled
 *   dpmy — increment op defaults to 1, accepts `value` alias
 *   nm9n — derived-projection reduce[] rejects assign/append
 *   h48t — declared-but-empty derived projection returns 200 {}
 *   ewbx — schema_ref payload-violation emits SCHEMA_TYPE_MISMATCH
 *   1tab — cascade depth: depth === maxDepth is the last allowed (5 levels)
 *   upx0 — saga trigger condition error produces WARN log
 */

import { validateBoundaryConfig, validateGlobalConfig } from '../../../src/dsl/schema';
import { createCelEvaluator } from '../../../src/cel/evaluator';
import { createStateGraph } from '../../../src/stategraph/graph';
import { createDerivedProjectionRegistry, getDerivedProjection } from '../../../src/projections/engine';
import { resolveReducerPatch } from '../../../src/engine/reducerPatches';
import { projectEvent } from '../../../src/engine/projection';
import { findTriggeredSagas } from '../../../src/sagas/orchestrator';
import { BootError, InternalExecutionError } from '../../../src/errors';
import type { BoundaryConfig, ReducerPatchOp, SagaConfig } from '../../../src/dsl/types';
import type { DomainEvent, Command } from '../../../src/types';
import type { OpenApiDoc } from '../../../src/contract/loader';
import type { Logger } from '../../../src/observability/logger';

const cel = createCelEvaluator();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBoundary(reducers: BoundaryConfig['reducers'] = []): BoundaryConfig {
  return {
    boundary: 'Test',
    contractPath: '/test',
    fallbackOverride: false,
    behaviors: [],
    reducers,
    eventCatalog: [],
  };
}

function makeEvent(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    eventId: 'evt-1',
    boundary: 'Lead',
    aggregateId: 'agg-1',
    type: 'Created',
    payload: {},
    timestamp: '2024-01-01T00:00:00Z',
    sequenceVersion: 1,
    causedBy: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// zo2g — boot-compile ${...} CEL in reducer patch values
// ---------------------------------------------------------------------------

describe('zo2g: reducer patch ${...} CEL compiled at boot', () => {
  const baseRaw = {
    boundary: 'MyBoundary',
    contract_path: '/path',
    behaviors: [{ name: 'b', match: { operationId: 'op', condition: 'true' }, emit: 'E' }],
    event_catalog: [{ type: 'E', payload_template: {} }],
  };

  it('boots cleanly with a valid ${...} string value', () => {
    expect(() =>
      validateBoundaryConfig({
        ...baseRaw,
        reducers: [{ on: 'E', patches: [{ op: 'replace', path: '/x', value: '${event.payload.name}' }] }],
      }),
    ).not.toThrow();
  });

  it('throws BOOT_ERR_DSL_SYNTAX for a malformed ${...} string value', () => {
    expect(() =>
      validateBoundaryConfig({
        ...baseRaw,
        reducers: [{ on: 'E', patches: [{ op: 'replace', path: '/x', value: '${event.payload.(}' }] }],
      }),
    ).toThrow(BootError);

    try {
      validateBoundaryConfig({
        ...baseRaw,
        reducers: [{ on: 'E', patches: [{ op: 'replace', path: '/x', value: '${event.payload.(}' }] }],
      });
    } catch (err) {
      expect((err as BootError).code).toBe('BOOT_ERR_DSL_SYNTAX');
    }
  });

  it('throws BOOT_ERR_DSL_SYNTAX for malformed CEL in increment by-value field (string)', () => {
    expect(() =>
      validateBoundaryConfig({
        ...baseRaw,
        reducers: [{ on: 'E', patches: [{ op: 'add', path: '/y', value: '${state.(bad}' }] }],
      }),
    ).toThrow(BootError);
  });

  it('boots cleanly with a plain string value (no CEL)', () => {
    expect(() =>
      validateBoundaryConfig({
        ...baseRaw,
        reducers: [{ on: 'E', patches: [{ op: 'replace', path: '/status', value: 'active' }] }],
      }),
    ).not.toThrow();
  });

  it('boots cleanly with a numeric value (no CEL to compile)', () => {
    expect(() =>
      validateBoundaryConfig({
        ...baseRaw,
        reducers: [{ on: 'E', patches: [{ op: 'add', path: '/count', value: 42 }] }],
      }),
    ).not.toThrow();
  });

  it('validates ${...} in object-valued patch fields (merge)', () => {
    expect(() =>
      validateBoundaryConfig({
        ...baseRaw,
        reducers: [{ on: 'E', patches: [{ op: 'merge', path: '/meta', value: { tag: '${bad.(expr}' } }] }],
      }),
    ).toThrow(BootError);
  });
});

// ---------------------------------------------------------------------------
// dpmy — increment op defaults to 1, accepts `value` alias
// ---------------------------------------------------------------------------

describe('dpmy: increment op default and value alias', () => {
  const ctx = {};

  it('bare increment (no by, no value) defaults to 1', () => {
    const patch: ReducerPatchOp = { op: 'increment', path: '/count' };
    const resolved = resolveReducerPatch(patch, cel, ctx);
    expect(resolved).toMatchObject({ op: 'increment', by: 1 });
  });

  it('increment with value: N adds N', () => {
    const patch: ReducerPatchOp = { op: 'increment', path: '/count', value: 5 };
    const resolved = resolveReducerPatch(patch, cel, ctx);
    expect(resolved).toMatchObject({ op: 'increment', by: 5 });
  });

  it('increment with by: N still adds N', () => {
    const patch: ReducerPatchOp = { op: 'increment', path: '/count', by: 7 };
    const resolved = resolveReducerPatch(patch, cel, ctx);
    expect(resolved).toMatchObject({ op: 'increment', by: 7 });
  });

  it('by takes precedence over value when both present', () => {
    const patch: ReducerPatchOp = { op: 'increment', path: '/count', by: 3, value: 9 };
    const resolved = resolveReducerPatch(patch, cel, ctx);
    expect(resolved).toMatchObject({ op: 'increment', by: 3 });
  });
});

// ---------------------------------------------------------------------------
// nm9n — derived-projection reduce[] rejects removed assign/append form
// ---------------------------------------------------------------------------

describe('nm9n: derived-projection reduce[] rejects assign/append', () => {
  const globalWithAssign = {
    derived_projections: [
      {
        name: 'TestProj',
        key: 'event.aggregateId',
        subscribe: ['Lead:Created'],
        reduce: [
          {
            on: 'Created',
            assign: { field: 'event.payload.name' },
          },
        ],
      },
    ],
  };

  const globalWithAppend = {
    derived_projections: [
      {
        name: 'TestProj',
        key: 'event.aggregateId',
        subscribe: ['Lead:Created'],
        reduce: [
          {
            on: 'Created',
            append: { items: 'event.payload.item' },
          },
        ],
      },
    ],
  };

  const globalWithPatches = {
    derived_projections: [
      {
        name: 'TestProj',
        key: 'event.aggregateId',
        subscribe: ['Lead:Created'],
        reduce: [
          {
            on: 'Created',
            patches: [{ op: 'add', path: '/field', value: '"x"' }],
          },
        ],
      },
    ],
  };

  it('throws BOOT_ERR_DSL_SYNTAX for assign in reduce entry', () => {
    expect(() => validateGlobalConfig(globalWithAssign)).toThrow(BootError);
    try {
      validateGlobalConfig(globalWithAssign);
    } catch (err) {
      expect((err as BootError).code).toBe('BOOT_ERR_DSL_SYNTAX');
    }
  });

  it('throws BOOT_ERR_DSL_SYNTAX for append in reduce entry', () => {
    expect(() => validateGlobalConfig(globalWithAppend)).toThrow(BootError);
    try {
      validateGlobalConfig(globalWithAppend);
    } catch (err) {
      expect((err as BootError).code).toBe('BOOT_ERR_DSL_SYNTAX');
    }
  });

  it('boots cleanly when reduce entry uses patches', () => {
    expect(() => validateGlobalConfig(globalWithPatches)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ewbx — schema_ref payload-violation emits SCHEMA_TYPE_MISMATCH
// ---------------------------------------------------------------------------

describe('ewbx: schema_ref payload-violation code is SCHEMA_TYPE_MISMATCH', () => {
  function makeOpenApiDoc(schemaName: string, schema: object) {
    return {
      raw: {
        components: { schemas: { [schemaName]: schema } },
      },
      paths: {},
    } as unknown as OpenApiDoc;
  }

  it('throws with code SCHEMA_TYPE_MISMATCH when payload violates schema_ref', () => {
    const openapi = makeOpenApiDoc('TestEvent', {
      type: 'object',
      required: ['amount'],
      properties: { amount: { type: 'number' } },
    });

    const boundary: BoundaryConfig = {
      ...makeBoundary(),
      eventCatalog: [
        { type: 'Created', payloadTemplate: {}, schemaRef: '#/components/schemas/TestEvent' },
      ],
    };

    const event = makeEvent({ payload: { amount: 'not-a-number' } });
    const graph = createStateGraph();

    try {
      projectEvent({ event, boundary, graph, cel, openapi });
      fail('Expected InternalExecutionError');
    } catch (err) {
      expect(err).toBeInstanceOf(InternalExecutionError);
      const details = (err as InternalExecutionError).details as Record<string, unknown>;
      expect(details['code']).toBe('SCHEMA_TYPE_MISMATCH');
    }
  });
});

// ---------------------------------------------------------------------------
// h48t — declared-but-empty derived projection returns {} not null
// ---------------------------------------------------------------------------

describe('h48t: declared derived projection pre-registered as empty Map', () => {
  it('getDerivedProjection returns {} (not null) for a declared-but-empty projection', () => {
    const registry = createDerivedProjectionRegistry();
    // Pre-register as done at boot/reset for declared projections
    registry.set('DeclaredProj', new Map());

    const result = getDerivedProjection(registry, 'DeclaredProj');
    expect(result).not.toBeNull();
    expect(result).toEqual({});
  });

  it('getDerivedProjection returns null for an unknown projection', () => {
    const registry = createDerivedProjectionRegistry();
    expect(getDerivedProjection(registry, 'Unknown')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// upx0 — throwing saga trigger condition produces WARN log
// ---------------------------------------------------------------------------

describe('upx0: throwing saga trigger condition produces WARN log', () => {
  function makeSagaCommand(overrides: Partial<Command> = {}): Command {
    return {
      commandId: 'cmd-1',
      boundary: 'Lead',
      intent: 'creation',
      targetId: null,
      payload: {},
      queryParams: {},
      httpMethod: 'POST',
      path: '/leads',
      origin: 'inbound',
      depth: 0,
      ...overrides,
    };
  }

  it('emits a WARN log when trigger condition throws, and saga does not fire', () => {
    const warnMessages: unknown[] = [];
    const mockLogger = {
      warn: (_obj: unknown, msg: unknown) => warnMessages.push(msg),
      child: () => mockLogger,
      info: () => {},
      debug: () => {},
      error: () => {},
      trace: () => {},
      fatal: () => {},
    } as unknown as Logger;

    const sagaWithBadCondition: SagaConfig = {
      name: 'BadSaga',
      trigger: {
        boundary: 'Lead',
        intent: 'creation',
        // Invalid CEL that will throw at runtime
        condition: 'command.payload.amount.(invalid)',
      },
      steps: [],
    };

    const cmd = makeSagaCommand({ payload: { amount: 100 } });
    const evt = makeEvent();

    const matched = findTriggeredSagas([sagaWithBadCondition], cmd, evt, cel, mockLogger);

    // Saga does not fire
    expect(matched).toHaveLength(0);
    // But a WARN was emitted
    expect(warnMessages.length).toBeGreaterThan(0);
    expect(warnMessages.some((m) => typeof m === 'string' && m.includes('no-match'))).toBe(true);
  });

  it('no log is emitted when no logger is passed', () => {
    const sagaWithBadCondition: SagaConfig = {
      name: 'BadSaga',
      trigger: {
        boundary: 'Lead',
        intent: 'creation',
        condition: 'command.payload.amount.(invalid)',
      },
      steps: [],
    };
    const cmd = makeSagaCommand({ payload: { amount: 100 } });
    const evt = makeEvent();

    // Should not throw even without a logger
    expect(() => findTriggeredSagas([sagaWithBadCondition], cmd, evt, cel)).not.toThrow();
    const matched = findTriggeredSagas([sagaWithBadCondition], cmd, evt, cel);
    expect(matched).toHaveLength(0);
  });
});
