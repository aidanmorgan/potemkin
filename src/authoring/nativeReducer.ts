import type { JsonObject } from '../contracts/value.js';
import type { EventType } from '../domain/references.js';
import type { ReducerDefinition, TypedReducerContext } from './types.js';

/** TypeScript state transition context with the application shapes retained. */
export type NativeReducerContext<
  EventPayload extends object,
  State extends object,
> = TypedReducerContext<EventPayload, State>;

export type NativeReducer<
  EventPayload extends object = JsonObject,
  State extends object = JsonObject,
> = ReducerDefinition<EventPayload, State>;

export interface NativeReducerBuilder<
  EventPayload extends object = JsonObject,
  State extends object = JsonObject,
> {
  apply(
    transition: (input: Readonly<NativeReducerContext<EventPayload, State>>) => State,
  ): NativeReducerBuilder<EventPayload, State>;
  build(): NativeReducer<EventPayload, State>;
}

/**
 * Define a reducer as a normal immutable TypeScript state transition.
 *
 * ```ts
 * reducerRule<Created, Order>("OrderCreated")
 *   .apply(({ state, event }) => ({
 *     ...state,
 *     customer: { ...state.customer, id: event.payload.customerId },
 *     lines: [...state.lines, ...event.payload.lines],
 *   }))
 *   .build();
 * ```
 *
 * The authored function has no JSON Pointer or operation vocabulary. The
 * runtime receives the complete next state and continues to enforce its
 * normal JSON state validation and transaction boundaries.
 */
export function reducerRule<
  EventPayload extends object = JsonObject,
  State extends object = JsonObject,
>(on: EventType): NativeReducerBuilder<EventPayload, State> {
  const build = (
    value: Partial<NativeReducer<EventPayload, State>> & Pick<NativeReducer, 'on'>,
  ): NativeReducerBuilder<EventPayload, State> => ({
    apply: (transition) =>
      build({
        ...value,
        reduce: transition,
      }),
    build: () => Object.freeze({ ...value }) as NativeReducer<EventPayload, State>,
  });
  return build({ on });
}
