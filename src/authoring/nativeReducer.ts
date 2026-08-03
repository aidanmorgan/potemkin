import type { RuntimeReducer, RuntimeReducerContext } from "../model/runtime.js";
import type { JsonObject } from "../types.js";
import type { EventType } from "./references.js";

/** TypeScript state transition context with the application shapes retained. */
export type NativeReducerContext<EventPayload extends object, State extends object> = Omit<
  RuntimeReducerContext,
  "event" | "payload" | "state"
> & {
  readonly state: Readonly<State>;
  readonly payload: Readonly<EventPayload>;
  readonly event: Omit<RuntimeReducerContext["event"], "payload"> & {
    readonly payload: Readonly<EventPayload>;
  };
};

export type NativeReducer<
  EventPayload extends object = JsonObject,
  State extends object = JsonObject,
> = Omit<RuntimeReducer, "apply" | "replaceState" | "reduce"> & {
  readonly on: EventType;
  readonly reduce: (input: Readonly<NativeReducerContext<EventPayload, State>>) => Readonly<State>;
};

export interface NativeReducerBuilder<
  EventPayload extends object = JsonObject,
  State extends object = JsonObject,
> {
  apply(
    transition: (input: Readonly<NativeReducerContext<EventPayload, State>>) => Readonly<State>,
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
    value: Partial<NativeReducer<EventPayload, State>> & Pick<RuntimeReducer, "on">,
  ): NativeReducerBuilder<EventPayload, State> => ({
    apply: (transition) =>
      build({
        ...value,
        reduce: transition as unknown as NativeReducer<EventPayload, State>["reduce"],
      }),
    build: () => Object.freeze({ ...value }) as NativeReducer<EventPayload, State>,
  });
  return build({ on });
}
