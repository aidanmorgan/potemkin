import type { RuntimeReducer, RuntimeReducerContext } from "../model/runtime.js";
import type { DeepReadonly, JsonObject } from "../types.js";
import type { EventType } from "./references.js";

/** TypeScript state transition context with the application shapes retained. */
export type NativeReducerContext<EventPayload extends object, State extends object> = Omit<
  RuntimeReducerContext,
  "event" | "payload" | "state"
> & {
  readonly state: DeepReadonly<State>;
  readonly payload: DeepReadonly<EventPayload>;
  readonly event: Omit<RuntimeReducerContext["event"], "payload"> & {
    readonly payload: DeepReadonly<EventPayload>;
  };
};

export type NativeReducer<
  EventPayload extends object = JsonObject,
  State extends object = JsonObject,
> = Omit<RuntimeReducer<State>, "apply" | "replaceState" | "reduce"> & {
  readonly on: EventType;
  /** Return the resultant state; the input projection is deeply readonly. */
  reduce(input: Readonly<NativeReducerContext<EventPayload, State>>): State;
};

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
