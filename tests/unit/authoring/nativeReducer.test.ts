import { reducerRule } from '../../../src/authoring/nativeReducer.js';
import { eventType } from '../../../src/domain/references.js';
import type { RuntimeHelpers } from '../../../src/model/runtime.js';

interface OrderCreated {
  order: {
    id: string;
    lines: Array<{ sku: string; quantity: number }>;
  };
  approved: boolean;
}

interface OrderState {
  order: {
    id: string;
    lines: Array<{ sku: string; quantity: number }>;
    audit: { actor: string | null; tags: string[] };
  };
  approved: boolean;
  counters: number[];
}

const helpers = {} as RuntimeHelpers;

describe('native TypeScript reducers', () => {
  it('exposes deeply readonly state and event projections', () => {
    type Created = { readonly item: { readonly tags: string[] } };
    type State = { item: { tags: string[] } };

    const reducer = reducerRule<Created, State>(eventType('ItemCreated')).apply(
      ({ state, event }) => {
        // @ts-expect-error Reducers cannot mutate nested state owned by the runtime.
        state.item.tags.push('forbidden');
        // @ts-expect-error Reducers cannot mutate nested event payloads.
        event.payload.item.tags.push('forbidden');

        return {
          item: {
            tags: [...state.item.tags, ...event.payload.item.tags],
          },
        };
      },
    );

    expect(reducer).toBeDefined();
  });

  it('return arbitrary-depth objects, arrays, and primitive values', () => {
    const reducer = reducerRule<OrderCreated, OrderState>(eventType('OrderCreated'))
      .apply(({ state, event }) => ({
        ...state,
        order: {
          ...state.order,
          id: event.payload.order.id,
          lines: [...state.order.lines, ...event.payload.order.lines],
          audit: {
            ...state.order.audit,
            actor: 'system',
            tags: [...state.order.audit.tags, 'created'],
          },
        },
        approved: event.payload.approved,
        counters: [...state.counters, event.payload.order.lines.length],
      }))
      .build();

    expect('apply' in reducer).toBe(false);
    expect(reducer.reduce).toBeDefined();
    const next = reducer.reduce!({
      boundary: 'Order',
      state: {
        order: { id: 'old', lines: [], audit: { actor: null, tags: [] } },
        approved: false,
        counters: [0],
      },
      event: {
        eventId: 'event-1',
        boundary: 'Order',
        aggregateId: 'order-1',
        type: 'OrderCreated',
        payload: {
          order: { id: 'order-1', lines: [{ sku: 'A', quantity: 2 }] },
          approved: true,
        },
        timestamp: '2026-01-01T00:00:00.000Z',
        sequenceVersion: 1,
        causedBy: null,
      },
      payload: {
        order: { id: 'order-1', lines: [{ sku: 'A', quantity: 2 }] },
        approved: true,
      },
      helpers,
    });

    expect(next).toEqual({
      order: {
        id: 'order-1',
        lines: [{ sku: 'A', quantity: 2 }],
        audit: { actor: 'system', tags: ['created'] },
      },
      approved: true,
      counters: [0, 1],
    });
  });
});
