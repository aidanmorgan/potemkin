import {
  runtimeBehavior,
  runtimeBoundary,
  runtimeEvent,
  runtimeProgram,
  runtimeReducer,
} from '../../../src/model/builders.js';
import type {
  RuntimeEmission,
  RuntimeFault,
  RuntimeGuard,
  RuntimeReaction,
  RuntimeSecondaryCommand,
} from '../../../src/model/runtime.js';

const guard: RuntimeGuard = {
  name: 'admin',
  check: () => true,
  errorCode: 'ADMIN_REQUIRED',
  errorMessage: 'administrator required',
  errorStatus: 403,
};

const emission: RuntimeEmission = { when: () => true, event: 'OrderUpdated' };

const dispatch: RuntimeSecondaryCommand = {
  boundary: 'Payment',
  intent: 'mutation',
  operationId: 'charge',
  targetId: () => 'payment-1',
  payload: { amount: () => 10 },
  condition: () => true,
};

const fault: RuntimeFault = {
  name: 'outage',
  matches: () => true,
  response: { status: 503, body: { error: 'outage' } },
};

const reaction: RuntimeReaction = {
  on: 'OrderUpdated',
  boundary: 'Payment',
  emit: 'PaymentUpdated',
};

describe('functional runtime builder matrix', () => {
  it('constructs events and behaviors through every typed builder operation', () => {
    const event = runtimeEvent('OrderUpdated')
      .payload({ id: ({ payload }) => payload.id, nested: () => ({ ok: true }) })
      .schemaRef('#/components/schemas/OrderUpdated')
      .build();
    const behavior = runtimeBehavior('update-order')
      .operation('updateOrder')
      .when(() => true)
      .method('patch')
      .headers({ 'x-requested': 'yes' })
      .requires(guard)
      .scopes('orders:write', 'admin')
      .emit('OrderUpdated')
      .emitWhen(emission)
      .dispatch(dispatch)
      .postcondition(() => true)
      .link('self', () => true)
      .status(202)
      .build();

    expect(event).toMatchObject({
      type: 'OrderUpdated',
      schemaRef: '#/components/schemas/OrderUpdated',
    });
    expect(Object.isFrozen(event)).toBe(true);
    expect(behavior).toMatchObject({
      name: 'update-order',
      operationId: 'updateOrder',
      method: 'PATCH',
      headers: { 'x-requested': 'yes' },
      requiredScopes: ['orders:write', 'admin'],
      emit: undefined,
      emitWhen: [emission],
      dispatchCommands: [dispatch],
      linkName: 'self',
      responseStatus: 202,
    });
    expect(Object.isFrozen(behavior)).toBe(true);
  });

  it('preserves the emit/emitWhen exclusivity and optional link condition', () => {
    expect(runtimeBehavior('created').operation('create').emit('Created').build()).toMatchObject({
      emit: 'Created',
      emitWhen: undefined,
    });
    expect(
      runtimeBehavior('linked').operation('link').emit('Linked').link('self').build(),
    ).toMatchObject({ linkName: 'self' });
    expect(runtimeBehavior('dispatched').operation('dispatch').dispatch(dispatch).build()).toEqual(
      expect.objectContaining({ dispatchCommands: [dispatch] }),
    );
  });

  it('constructs reducer, boundary, and program definitions without source tags', () => {
    const reducer = runtimeReducer('OrderUpdated')
      .apply(() => [])
      .replaceState()
      .build();
    const replaceDisabled = runtimeReducer('OrderCreated').replaceState(false).build();
    const boundary = runtimeBoundary('Order', '/orders')
      .event(runtimeEvent('OrderUpdated').build())
      .behavior(runtimeBehavior('update').operation('updateOrder').emit('OrderUpdated').build())
      .reducer(reducer)
      .reducer(replaceDisabled)
      .seed({ id: 'order-1' }, { id: 'order-2' })
      .identity({ key: { from: 'path', name: 'id' } })
      .query({ pagination: 'envelope' })
      .response({ status: 200 })
      .fallbackOverride()
      .mask('secret', 'internal.note')
      .deprecated({ date: '2030-01-01' })
      .latency({ fixedMs: 5 })
      .auditFields()
      .strictSchema()
      .queryMapping({ active: () => true })
      .faults(fault)
      .reactions(reaction)
      .state({ internal: [{ name: 'secret', type: 'string' }] })
      .build();
    const program = runtimeProgram([boundary])
      .boundary(runtimeBoundary('Payment', '/payments').build())
      .policies({ idempotency: { enabled: true, ttlSeconds: 10, hashIncludesBody: true } })
      .build();

    expect(reducer).toEqual(expect.objectContaining({ on: 'OrderUpdated', replaceState: true }));
    expect(replaceDisabled).toEqual(expect.objectContaining({ replaceState: false }));
    expect(boundary).toMatchObject({
      boundary: 'Order',
      eventCatalog: [{ type: 'OrderUpdated' }],
      initialization: [{ id: 'order-1' }, { id: 'order-2' }],
      fallbackOverride: true,
      mask: ['secret', 'internal.note'],
      auditFields: true,
      strictSchema: true,
      faults: [fault],
      reactions: [reaction],
    });
    expect(program.boundaries).toHaveLength(2);
    expect(program.policies?.idempotency?.enabled).toBe(true);
    expect(Object.isFrozen(program)).toBe(true);
  });

  it('supports explicit false defaults for boolean builder options', () => {
    const boundary = runtimeBoundary('Order', '/orders')
      .fallbackOverride(false)
      .auditFields(false)
      .strictSchema(false)
      .build();

    expect(boundary).toMatchObject({
      fallbackOverride: false,
      auditFields: false,
      strictSchema: false,
    });
  });
});
