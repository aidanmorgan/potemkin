import type { JsonObject } from '../contracts/value.js';
import type { EventType } from '../domain/references.js';
import { TypeScriptAuthoringError } from './errors.js';
import type { ReducerDefinition, TypedReducerContext } from './types.js';

/** TypeScript state transition context with the application shapes retained. */
export type NativeReducerContext<
  EventPayload extends object,
  State extends object,
> = TypedReducerContext<EventPayload, State>;

export type NativeReducer<
  EventPayload extends object = JsonObject,
  State extends object = JsonObject,
  EventName extends string = string,
> = ReducerDefinition<EventPayload, State, EventName>;

export interface NativeReducerBuilder<
  EventPayload extends object = JsonObject,
  State extends object = JsonObject,
  EventName extends string = string,
> {
  apply(
    transition: (input: Readonly<NativeReducerContext<EventPayload, State>>) => State,
  ): NativeReducerBuilder<EventPayload, State, EventName>;
  build(): NativeReducer<EventPayload, State, EventName>;
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
  const EventName extends string = string,
>(on: EventType<EventName>): NativeReducerBuilder<EventPayload, State, EventName> {
  const build = (
    value: Partial<NativeReducer<EventPayload, State, EventName>> &
      Pick<NativeReducer<EventPayload, State, EventName>, 'on'>,
  ): NativeReducerBuilder<EventPayload, State, EventName> => ({
    apply: (transition) =>
      build({
        ...value,
        reduce: transition,
      }),
    build: () => {
      if (value.reduce === undefined) {
        throw new TypeScriptAuthoringError(
          'TS_BUILDER_INVALID',
          `Reducer for event "${on}" requires an apply transition`,
        );
      }
      return Object.freeze({ ...value, reduce: value.reduce });
    },
  });
  return build({ on });
}
