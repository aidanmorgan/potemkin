import { behavior, event } from '../../../src/authoring/public.js';
import type { TypedEventContext, TypedMatchContext } from '../../../src/authoring/types.js';
import { behaviorName, eventType, operationId } from '../../../src/domain/references.js';

interface CreateCommand {
  customer: { risk: { score: number; flags: string[] } };
  lines: Array<{ sku: string; quantity: number }>;
}

interface CreatedEvent {
  customerId: string;
  totalLines: number;
}

describe('native TypeScript behavior authoring', () => {
  it('evaluates nested event and behavior functions without CEL expressions', () => {
    const created = event<CreatedEvent, CreateCommand>(eventType('OrderCreated'), {
      customerId: ({ payload }) => payload.customer.risk.flags[0] ?? 'unknown',
      totalLines: ({ payload }) => payload.lines.reduce((total, line) => total + line.quantity, 0),
    });
    const command = {
      customer: { risk: { score: 12, flags: ['manual-review'] } },
      lines: [
        { sku: 'A', quantity: 2 },
        { sku: 'B', quantity: 3 },
      ],
    } satisfies CreateCommand;
    const context = {
      payload: command,
    } as unknown as TypedEventContext<CreateCommand>;

    const customerId = created.payload.customerId;
    const totalLines = created.payload.totalLines;
    expect(typeof customerId).toBe('function');
    expect(typeof totalLines).toBe('function');
    if (typeof customerId !== 'function' || typeof totalLines !== 'function') return;
    expect(customerId(context)).toBe('manual-review');
    expect(totalLines(context)).toBe(5);

    const definition = behavior<CreateCommand>(behaviorName('createOrder'))
      .operation(operationId('createOrder'))
      .condition(
        ({ payload, state }) =>
          payload.customer.risk.score < 50 &&
          payload.lines.length > 0 &&
          state?.customer !== undefined,
      )
      .emit(eventType('OrderCreated'))
      .build();

    const match = {
      payload: command,
      state: { customer: { id: 'customer-1' } },
    } as unknown as TypedMatchContext<CreateCommand>;
    expect(definition.condition?.(match)).toBe(true);
  });
});
