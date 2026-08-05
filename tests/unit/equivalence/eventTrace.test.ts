import { compareEquivalenceTrace } from '../../equivalence/comparator.js';
import { compareWeakEventTrace } from '../../equivalence/eventTrace.js';

describe('weak event-trace equivalence', () => {
  const policy = {
    eventNameMap: {
      PaymentIntentCreated: 'payment_intent.created',
      PaymentIntentConfirmed: 'payment_intent.confirmed',
    },
    independenceKey: (event: unknown) =>
      event !== null && typeof event === 'object' && !Array.isArray(event)
        ? ((event as Record<string, unknown>)['causalGroup'] as string | undefined)
        : undefined,
  };

  it('maps provider event names and coherent fresh identifiers', () => {
    const result = compareWeakEventTrace(
      [{ type: 'PaymentIntentCreated', aggregateId: 'pi_model', id: 'evt_model' }],
      [{ type: 'payment_intent.created', aggregateId: 'pi_real', id: 'evt_real' }],
      policy,
    );

    expect(result.conforms).toBe(true);
  });

  it('absorbs declared silent events and reorders independent aggregates', () => {
    const result = compareWeakEventTrace(
      [
        { type: 'PaymentIntentCreated', aggregateId: 'pi_model', causalGroup: 'payment-intent' },
        { type: 'PaymentIntentConfirmed', aggregateId: 'pi_model', causalGroup: 'payment-intent' },
        { type: 'internal.audit', aggregateId: 'audit-1', causalGroup: 'audit' },
      ],
      [
        { type: 'PaymentIntentConfirmed', aggregateId: 'pi_real', causalGroup: 'payment-intent' },
        { type: 'PaymentIntentCreated', aggregateId: 'pi_real', causalGroup: 'payment-intent' },
        { type: 'internal.audit', aggregateId: 'audit-1', causalGroup: 'audit', observable: false },
      ],
      { ...policy, tauEvents: ['internal.audit'] },
    );

    // The two PaymentIntent events share an independence class, so their
    // order remains observable and the deliberately reversed trace fails.
    expect(result.conforms).toBe(false);
    expect(result.divergences[0]?.code).toBe('EVENT_TRACE_ORDER_MISMATCH');
  });

  it('allows reordering of independent aggregate events', () => {
    const result = compareWeakEventTrace(
      [
        { type: 'PaymentIntentCreated', aggregateId: 'pi-model', causalGroup: 'one' },
        { type: 'PaymentIntentCreated', aggregateId: 'pi-other', causalGroup: 'two' },
      ],
      [
        { type: 'payment_intent.created', aggregateId: 'pi-real-other', causalGroup: 'two' },
        { type: 'payment_intent.created', aggregateId: 'pi-real', causalGroup: 'one' },
      ],
      policy,
    );

    expect(result.conforms).toBe(true);
  });

  it('fails missing and extra observable events', () => {
    const missing = compareWeakEventTrace(
      [{ type: 'PaymentIntentCreated', aggregateId: 'pi-model' }],
      [],
      policy,
    );
    const extra = compareWeakEventTrace(
      [],
      [{ type: 'payment_intent.created', aggregateId: 'pi-real' }],
      policy,
    );

    expect(missing.divergences[0]?.code).toBe('EVENT_TRACE_MISSING');
    expect(extra.divergences[0]?.code).toBe('EVENT_TRACE_EXTRA');
  });

  it('is stronger than projection-only comparison for dependent order', () => {
    const projection = compareEquivalenceTrace([
      {
        operation: 'confirm',
        request: { method: 'POST', path: '/confirm' },
        model: { status: 200, body: { status: 'succeeded' } },
        real: { status: 200, body: { status: 'succeeded' } },
      },
    ]);
    const trace = compareWeakEventTrace(
      [
        { type: 'PaymentIntentCreated', aggregateId: 'pi-model', causalGroup: 'payment-intent' },
        { type: 'PaymentIntentConfirmed', aggregateId: 'pi-model', causalGroup: 'payment-intent' },
      ],
      [
        { type: 'payment_intent.confirmed', aggregateId: 'pi-real', causalGroup: 'payment-intent' },
        { type: 'payment_intent.created', aggregateId: 'pi-real', causalGroup: 'payment-intent' },
      ],
      policy,
    );

    expect(projection.conforms).toBe(true);
    expect(trace.conforms).toBe(false);
  });

  it('rejects a contradictory identifier mapping', () => {
    const result = compareWeakEventTrace(
      [
        { type: 'PaymentIntentCreated', aggregateId: 'pi-one', causalGroup: 'payment-intent' },
        { type: 'PaymentIntentConfirmed', aggregateId: 'pi-one', causalGroup: 'payment-intent' },
      ],
      [
        {
          type: 'payment_intent.created',
          aggregateId: 'pi-real-one',
          causalGroup: 'payment-intent',
        },
        {
          type: 'payment_intent.confirmed',
          aggregateId: 'pi-real-two',
          causalGroup: 'payment-intent',
        },
      ],
      policy,
    );

    expect(result.divergences.some((item) => item.code === 'EVENT_TRACE_ID_CONTRADICTION')).toBe(
      true,
    );
  });
});
