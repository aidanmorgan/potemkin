import {
  PotemkinConfigure,
  boundary,
  behavior,
  defineGlobal,
  defineHelper,
  event,
  reducerRule,
  simulation,
  type FactoryContext,
} from "potemkin/sdk";

/**
 * A typed helper deliberately shared with the mixed YAML path. The helper is
 * identity-preserving so the mixed runtime has the same observable behaviour
 * while proving that YAML can call a TypeScript registration.
 */
const parityName = defineHelper("parityName", (value: string): string => value);

export class AuthoringParityFactory {
  @PotemkinConfigure("authoring-parity")
  static create(_context: FactoryContext) {
    const order = boundary("Order", "/orders")
      .fallbackOverride(false)
      .identity({
        generate: ({ command }) => String(command.payload["id"]),
      })
      .response({ hateoas: [{ rel: "self", href: "/orders" }] })
      .mask("internalNote")
      .eventCatalog(
        event("OrderCreatedFirst", {
          id: ({ command }) => String(command.payload["id"]),
          name: ({ command }) => parityName(String(command.payload["name"])),
          quantity: ({ command }) => Number(command.payload["quantity"]),
          internalNote: ({ command }) => String(command.payload["internalNote"]),
          status: "FIRST",
        }),
        event("OrderCreated", {
          id: ({ command }) => String(command.payload["id"]),
          name: ({ command }) => parityName(String(command.payload["name"])),
          quantity: ({ command }) => Number(command.payload["quantity"]),
          internalNote: ({ command }) => String(command.payload["internalNote"]),
          status: "CREATED",
        }),
      )
      .behavior(
        behavior("create-order-first")
          .operation("createOrder")
          .headers({ "x-parity-behavior-order": "first" })
          .condition(() => true)
          .emit("OrderCreatedFirst")
          .status(202)
          .build(),
      )
      .behavior(
        behavior({
          name: "create-order",
          operationId: "createOrder",
          condition: () => true,
          emit: "OrderCreated",
          dispatchCommands: [
            {
              boundary: "Receipt",
              intent: "creation",
              operationId: "createReceipt",
              targetId: ({ command }) => `${command.targetId ?? ""}-receipt`,
              payload: {
                orderId: ({ command }) => command.targetId ?? "",
                amount: ({ command }) => Number(command.payload["quantity"]),
              },
            },
          ],
        }),
      )
      .reducer(
        reducerRule("OrderCreatedFirst")
          .apply(({ state, event: emitted }) => ({
            ...state,
            id: String(emitted.payload["id"]),
            name: String(emitted.payload["name"]),
            quantity: Number(emitted.payload["quantity"]),
            internalNote: String(emitted.payload["internalNote"]),
            status: String(emitted.payload["status"]),
          }))
          .build(),
      )
      .reducer(
        reducerRule("OrderCreated")
          .apply(({ state, event: emitted }) => ({
            ...state,
            id: String(emitted.payload["id"]),
            name: String(emitted.payload["name"]),
            quantity: Number(emitted.payload["quantity"]),
            internalNote: String(emitted.payload["internalNote"]),
            status: String(emitted.payload["status"]),
          }))
          .build(),
      );

    const orderById = boundary("OrderById", "/orders/{id}")
      .fallbackOverride(true)
      .schema("Order")
      .identity({ key: { from: "path", name: "id" } })
      .response({
        hateoas: [{ rel: "self", href: "/orders/{id}" }],
        deprecated: {
          date: "2026-01-01T00:00:00Z",
          sunset: "2027-01-01T00:00:00Z",
          replacement: "/v2/orders",
        },
      })
      .mask("internalNote")
      .eventCatalog(
        event("OrderRenamed", {
          id: ({ event: emitted, command }) => emitted?.aggregateId ?? String(command.targetId),
          name: ({ command }) => String(command.payload["name"]),
        }),
      )
      .behavior(
        behavior("rename-order-dispatch-only")
          .operation("renameOrder")
          .headers({ "x-parity-dispatch-only": "on" })
          .condition(() => true)
          .dispatch({
            boundary: "Receipt",
            intent: "creation",
            operationId: "createReceipt",
            targetId: ({ command }) => `${command.targetId ?? ""}-dispatch-only-receipt`,
            payload: {
              orderId: ({ command }) => command.targetId ?? "",
              amount: 1,
            },
          })
          .build(),
      )
      .behavior(
        behavior({
          name: "rename-order",
          operationId: "renameOrder",
          condition: () => true,
          emit: "OrderRenamed",
        }),
      )
      .reducer(
        reducerRule("OrderRenamed")
          .apply(({ state, event: emitted }) => ({
            ...state,
            name: String(emitted.payload["name"]),
          }))
          .build(),
      );

    const receipt = boundary("Receipt", "/receipts/{id}")
      .fallbackOverride(false)
      .identity({
        generate: ({ command }) => String(command.targetId),
      })
      .eventCatalog(
        event("ReceiptCreated", {
          id: ({ command }) => String(command.targetId),
          orderId: ({ command }) => String(command.payload["orderId"]),
          amount: ({ command }) => Number(command.payload["amount"]),
        }),
      )
      .behavior(
        behavior({
          name: "create-receipt",
          operationId: "createReceipt",
          condition: () => true,
          emit: "ReceiptCreated",
        }),
      )
      .reducer(
        reducerRule("ReceiptCreated")
          .apply(({ state, event: emitted }) => ({
            ...state,
            id: String(emitted.payload["id"]),
            orderId: String(emitted.payload["orderId"]),
            amount: Number(emitted.payload["amount"]),
          }))
          .build(),
      );

    const audit = boundary("Audit", "/audits/{id}")
      .fallbackOverride(false)
      .identity({
        generate: ({ helpers }) => helpers.uuid(),
      })
      .eventCatalog(
        event("AuditRecorded", {
          id: ({ helpers }) => helpers.uuid(),
          orderId: ({ command }) => String(command.payload["orderId"] ?? ""),
          action: "created",
        }),
      )
      .reducer(
        reducerRule("AuditRecorded")
          .apply(({ state, event: emitted }) => ({
            ...state,
            id: String(emitted.payload["id"]),
            orderId: String(emitted.payload["orderId"]),
            action: String(emitted.payload["action"]),
          }))
          .build(),
      );

    return simulation()
      .boundary(order)
      .boundary(orderById)
      .boundary(receipt)
      .boundary(audit)
      .helper(parityName)
      .global(
        defineGlobal({
          idempotency: { enabled: true, ttlSeconds: 60, hashIncludesBody: true },
          securityHeaders: {
            enabled: true,
            hsts: true,
            nosniff: true,
            frameDeny: true,
            referrerPolicy: "strict-origin-when-cross-origin",
            customHeaders: { "X-Parity-Fixture": "yaml-and-typescript" },
          },
          faults: [
            {
              name: "parity-fault",
              headers: { "x-parity-fault": "on" },
              matches: ({ headers }) => headers["x-parity-fault"] === "on",
              response: {
                status: 503,
                body: { error: "PARITY_FAULT", message: "deliberate parity fixture fault" },
                headers: { "Retry-After": "5" },
              },
            },
            {
              name: "maintenance-response",
              selectors: { forceResponse: "maintenance" },
              matches: () => true,
              response: {
                status: 502,
                body: { error: "MAINTENANCE_RESPONSE", message: "selected maintenance response" },
              },
            },
            {
              name: "scenario-response",
              selectors: { scenario: "slow_db" },
              matches: () => true,
              response: {
                status: 504,
                body: { error: "SCENARIO_RESPONSE", message: "selected scenario response" },
              },
            },
            {
              name: "feature-response",
              selectors: { featureFlag: "parity-beta" },
              matches: () => true,
              response: {
                status: 418,
                body: { error: "FEATURE_RESPONSE", message: "selected feature response" },
              },
            },
            {
              name: "probability-response",
              probability: 1,
              headers: { "x-parity-probability": "on" },
              matches: ({ headers }) => headers["x-parity-probability"] === "on",
              response: {
                status: 503,
                body: { error: "PROBABILITY_RESPONSE", message: "selected probability response" },
              },
            },
            {
              name: "probability-off",
              probability: 0,
              headers: { "x-parity-probability": "off" },
              matches: ({ headers }) => headers["x-parity-probability"] === "off",
              response: {
                status: 503,
                body: {
                  error: "PROBABILITY_OFF_SHOULD_NOT_FIRE",
                  message: "this response must not be selected",
                },
              },
            },
            {
              name: "intermediate-probability",
              probability: 0.5,
              headers: { "x-parity-probability-half": "on" },
              matches: ({ headers }) => headers["x-parity-probability-half"] === "on",
              response: {
                status: 503,
                body: {
                  error: "INTERMEDIATE_PROBABILITY_RESPONSE",
                  message: "selected intermediate probability response",
                },
              },
            },
            {
              name: "operation-method-fault",
              headers: { "x-parity-operation": "on" },
              matches: ({ command, headers }) =>
                command.operationId === "createOrder" &&
                command.httpMethod.toUpperCase() === "POST" &&
                headers["x-parity-operation"] === "on",
              response: {
                status: 503,
                body: {
                  error: "OPERATION_METHOD_RESPONSE",
                  message: "selected operation and method response",
                },
              },
            },
            {
              name: "guarded-scoped-fault",
              headers: { "x-parity-guarded": "on" },
              requiredScopes: ["writer"],
              requires: [
                {
                  name: "parity-required-header",
                  check: ({ request }) => request.headers["x-parity-required"] === "on",
                  errorCode: "PARITY_REQUIRED_HEADER",
                  errorMessage: "the parity required header must be enabled",
                },
              ],
              matches: ({ headers }) => headers["x-parity-guarded"] === "on",
              response: {
                status: 503,
                body: {
                  error: "GUARDED_SCOPED_RESPONSE",
                  message: "selected guarded and scoped response",
                },
              },
            },
            {
              name: "boundary-intent-condition-fault",
              headers: { "x-parity-boundary": "on" },
              matches: ({ command, headers }) =>
                command.boundary === "Order" &&
                command.intent === "creation" &&
                Number(command.payload["quantity"]) > 2 &&
                headers["x-parity-boundary"] === "on",
              response: {
                status: 503,
                body: {
                  error: "BOUNDARY_INTENT_RESPONSE",
                  message: "selected boundary intent condition response",
                },
              },
            },
            {
              name: "ordered-first",
              headers: { "x-parity-order": "same" },
              matches: ({ headers }) => headers["x-parity-order"] === "same",
              response: { status: 503, body: { error: "ORDERED_FIRST" } },
            },
            {
              name: "ordered-second",
              headers: { "x-parity-order": "same" },
              matches: ({ headers }) => headers["x-parity-order"] === "same",
              response: { status: 418, body: { error: "ORDERED_SECOND" } },
            },
            {
              name: "wildcard-selector",
              headers: { "x-parity-wildcard": "*" },
              matches: ({ headers }) => headers["x-parity-wildcard"] !== undefined,
              response: { status: 502, body: { error: "WILDCARD_SELECTOR" } },
            },
          ],
          sagas: [
            {
              name: "order-created-saga-receipt",
              trigger: {
                boundary: "Order",
                intent: "creation",
                condition: () => true,
              },
              steps: [
                {
                  name: "create-saga-receipt",
                  boundary: "Receipt",
                  intent: "creation",
                  operationId: "createReceipt",
                  targetId: ({ event: emitted }) => `${emitted?.aggregateId ?? ""}-saga-receipt`,
                  payload: {
                    orderId: ({ event: emitted }) => emitted?.aggregateId ?? "",
                    amount: ({ event: emitted }) => Number(emitted?.payload["quantity"] ?? 0),
                  },
                },
              ],
            },
          ],
          derivedProjections: [
            {
              name: "OrderSummary",
              key: ({ event: emitted }) => emitted?.aggregateId ?? "",
              subscribe: ["Order:OrderCreated", "OrderById:OrderRenamed"],
              reduce: [
                reducerRule("OrderCreated")
                  .apply(({ state, event: emitted }) => ({
                    ...state,
                    name: String(emitted.payload["name"]),
                    renameCount: 0,
                  }))
                  .build(),
                reducerRule("OrderRenamed")
                  .apply(({ state, event: emitted }) => ({
                    ...state,
                    name: String(emitted.payload["name"]),
                    renameCount: Number(state["renameCount"] ?? 0) + 1,
                  }))
                  .build(),
              ],
            },
          ],
          reactions: [
            {
              name: "audit-order-creation",
              on: "Order:OrderCreated",
              intent: "creation",
              boundary: "Audit",
              emit: "AuditRecorded",
              payload: {
                orderId: ({ event: emitted }) => emitted?.aggregateId ?? "",
              },
            },
          ],
          webhooks: [
            {
              name: "order-created-hook",
              trigger: ({ event: emitted }) => emitted?.type === "OrderCreated",
              url: "http://127.0.0.1:19878/order-hook",
              secret: "parity-webhook-secret",
              payload: {
                orderId: ({ event: emitted }) => emitted?.aggregateId ?? "",
                event: ({ event: emitted }) => emitted?.type ?? "",
                name: ({ payload }) => String(payload["name"]),
              },
              retry: { maxAttempts: 1, delayMs: 1 },
            },
          ],
        }),
      )
      .build();
  }
}
