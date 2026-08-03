import {
  cloneValue,
  createMemoryEventStore,
  createMemoryIdempotencyStore,
  createMemoryStateStore,
} from "../../../src/core/storage.js";
import type { ExecutionResult, JsonObject } from "../../../src/types.js";

describe("core storage implementations", () => {
  it("clones event and state values at the port boundary", () => {
    const events = createMemoryEventStore();
    const state = createMemoryStateStore();
    const payload = { nested: { value: 1 } } as unknown as JsonObject;
    const event = {
      eventId: "event-1",
      boundary: "orders",
      aggregateId: "order-1",
      type: "Created",
      payload,
      timestamp: "2026-01-01T00:00:00.000Z",
      sequenceVersion: 1,
      causedBy: null,
      intent: "creation" as const,
    };
    events.append([event]);
    state.set("order-1", payload);

    const readEvent = events.events()[0]!;
    const readState = state.get("order-1")!;
    (readEvent.payload.nested as JsonObject).value = 99;
    (readState.nested as JsonObject).value = 88;

    expect((events.events()[0]!.payload.nested as JsonObject).value).toBe(1);
    expect((state.get("order-1")!.nested as JsonObject).value).toBe(1);
    expect(cloneValue(payload)).toEqual(payload);
  });

  it("keeps request-local expiry reads from evicting shared idempotency entries", () => {
    let now = 1_000;
    const store = createMemoryIdempotencyStore(() => now);
    const result: ExecutionResult = { status: 201, body: { id: "order-1" }, events: [] };
    store.set("key", result, 1);

    expect(store.get("key", 2_001)).toBeUndefined();
    now = 1_500;
    expect(store.get("key")).toEqual(result);
    now = 2_001;
    expect(store.get("key")).toBeUndefined();
  });
});
