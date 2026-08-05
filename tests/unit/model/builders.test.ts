import {
  runtimeBehavior,
  runtimeBoundary,
  runtimeEvent,
  runtimeProgram,
  runtimeReducer,
} from '../../../src/model/builders.js';
import { createRuntimeDataGenerator } from '../../../src/model/data.js';
import type { RuntimeHelpers } from '../../../src/model/runtime.js';
import { RuntimeModelError } from '../../../src/model/errors.js';

describe('functional TypeScript runtime builders', () => {
  it('builds an executable definition without YAML-shaped fields', async () => {
    const boundary = runtimeBoundary('Order', '/orders')
      .event(
        runtimeEvent('OrderCreated')
          .payload({ id: ({ payload }) => payload.id })
          .build(),
      )
      .behavior(runtimeBehavior('create').operation('createOrder').emit('OrderCreated').build())
      .reducer(
        runtimeReducer('OrderCreated')
          .apply(({ event }) => [{ op: 'replace', path: '/id', value: event.payload.id }])
          .build(),
      )
      .build();
    const helpers: RuntimeHelpers = {
      now: () => '2026-01-01T00:00:00.000Z',
      uuid: () => 'order-1',
      random: () => 0,
      data: createRuntimeDataGenerator(() => 0),
      clone: <T>(value: T) => structuredClone(value),
    };
    const program = runtimeProgram()
      .boundary(boundary)
      .compile({
        helpers,
        clock: {
          nowMs: () => 1_735_689_600_000,
          offsetMs: () => 0,
          advance: () => 0,
          reset: () => undefined,
        },
        contract: { operationIdFor: () => 'createOrder' },
      });
    expect(program.boundaries[0]).toBe(boundary);
    expect(boundary).not.toHaveProperty('event_catalog');
    expect(Object.isFrozen(boundary)).toBe(true);
  });

  it('reports invalid runtime builder state through a typed model error', () => {
    expect(() => runtimeBehavior('incomplete').build()).toThrow(RuntimeModelError);
    expect(() => runtimeBehavior('incomplete').build()).toThrow(
      expect.objectContaining({ code: 'RUNTIME_BUILDER_INVALID' }),
    );
  });

  it('serializes typed model errors with and without details', () => {
    expect(new RuntimeModelError('RUNTIME_BUILDER_INVALID', 'invalid').toJSON()).toEqual({
      name: 'RuntimeModelError',
      code: 'RUNTIME_BUILDER_INVALID',
      message: 'invalid',
    });
    expect(
      new RuntimeModelError('RUNTIME_BUILDER_INVALID', 'invalid', { field: 'name' }).toJSON(),
    ).toEqual({
      name: 'RuntimeModelError',
      code: 'RUNTIME_BUILDER_INVALID',
      message: 'invalid',
      details: { field: 'name' },
    });
  });

  it('rejects malformed latency at the source-neutral model boundary', () => {
    const invalid = runtimeBoundary('Broken', '/broken').latency({ minMs: 20, maxMs: 10 }).build();

    expect(() =>
      runtimeProgram()
        .boundary(invalid)
        .compile({
          helpers: {
            now: () => '2026-01-01T00:00:00.000Z',
            uuid: () => 'broken',
            random: () => 0,
            data: createRuntimeDataGenerator(() => 0),
            clone: <T>(value: T) => structuredClone(value),
          },
          clock: {
            nowMs: () => 0,
            offsetMs: () => 0,
            advance: () => 0,
            reset: () => undefined,
          },
          contract: { operationIdFor: () => undefined },
        }),
    ).toThrow(expect.objectContaining({ code: 'RUNTIME_LATENCY_INVALID' }));
  });
});
