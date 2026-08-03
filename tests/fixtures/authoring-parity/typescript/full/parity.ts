import {
  PotemkinConfigure,
  boundary,
  boundaryName,
  behaviorName,
  behavior,
  contractPath,
  defineBehavior,
  defineGlobal,
  defineHelper,
  event,
  eventReference,
  eventType,
  field,
  fieldPath,
  faultName,
  guardName,
  sagaName,
  sagaStepName,
  webhookName,
  factoryName,
  helperName,
  linkRelation,
  operationId,
  pathParameter,
  pathSegment,
  reducerRule,
  simulation,
  schemaReference,
  scopeName,
  type EventContext,
  type FactoryContext,
} from "potemkin/sdk";

/**
 * A typed helper deliberately shared with the mixed YAML path. The helper is
 * identity-preserving so the mixed runtime has the same observable behaviour
 * while proving that YAML can call a TypeScript registration.
 */
const parityName = defineHelper(helperName("parityName"), (value: string): string => value);

export class AuthoringParityFactory {
  @PotemkinConfigure(factoryName("authoring-parity"))
  static create(_context: FactoryContext) {
    const order = boundary(boundaryName("Order"), contractPath(pathSegment("orders")))
      .fallbackOverride(false)
      .identity({
        generate: ({ command }) => String(command.payload["id"]),
      })
      .response({ hateoas: [{ rel: linkRelation("self"), href: "/orders" }] })
      .mask(fieldPath(field("internalNote")))
      .eventCatalog(
        event(eventType("OrderCreatedFirst"), {
          id: ({ command }: EventContext) => String(command.payload["id"]),
          name: ({ command }: EventContext) => parityName(String(command.payload["name"])),
          quantity: ({ command }: EventContext) => Number(command.payload["quantity"]),
          internalNote: ({ command }: EventContext) => String(command.payload["internalNote"]),
          status: "FIRST",
        }),
        event(eventType("OrderCreated"), {
          id: ({ command }: EventContext) => String(command.payload["id"]),
          name: ({ command }: EventContext) => parityName(String(command.payload["name"])),
          quantity: ({ command }: EventContext) => Number(command.payload["quantity"]),
          internalNote: ({ command }: EventContext) => String(command.payload["internalNote"]),
          status: "CREATED",
        }),
      )
      .behavior(
        behavior(behaviorName("create-order-first"))
          .operation(operationId("createOrder"))
          .headers({ "x-parity-behavior-order": "first" })
          .condition(() => true)
          .emit(eventType("OrderCreatedFirst"))
          .status(202)
          .build(),
      )
      .behavior(
        defineBehavior({
          name: behaviorName("create-order"),
          operationId: operationId("createOrder"),
          condition: () => true,
          emit: eventType("OrderCreated"),
          dispatchCommands: [
            {
              boundary: boundaryName("Receipt"),
              intent: "creation",
              operationId: operationId("createReceipt"),
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
        reducerRule(eventType("OrderCreatedFirst"))
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
        reducerRule(eventType("OrderCreated"))
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

    const orderById = boundary(
      boundaryName("OrderById"),
      contractPath(pathSegment("orders"), pathParameter("id")),
    )
      .fallbackOverride(true)
      .schema(schemaReference("Order"))
      .identity({ key: { from: "path", name: "id" } })
      .response({
        hateoas: [{ rel: linkRelation("self"), href: "/orders/{id}" }],
        deprecated: {
          date: "2026-01-01T00:00:00Z",
          sunset: "2027-01-01T00:00:00Z",
          replacement: "/v2/orders",
        },
      })
      .mask(fieldPath(field("internalNote")))
      .eventCatalog(
        event(eventType("OrderRenamed"), {
          id: ({ event: emitted, command }: EventContext) =>
            emitted?.aggregateId ?? String(command.targetId),
          name: ({ command }: EventContext) => String(command.payload["name"]),
        }),
      )
      .behavior(
        behavior(behaviorName("rename-order-dispatch-only"))
          .operation(operationId("renameOrder"))
          .headers({ "x-parity-dispatch-only": "on" })
          .condition(() => true)
          .dispatch({
            boundary: boundaryName("Receipt"),
            intent: "creation",
            operationId: operationId("createReceipt"),
            targetId: ({ command }) => `${command.targetId ?? ""}-dispatch-only-receipt`,
            payload: {
              orderId: ({ command }) => command.targetId ?? "",
              amount: 1,
            },
          })
          .build(),
      )
      .behavior(
        defineBehavior({
          name: behaviorName("rename-order"),
          operationId: operationId("renameOrder"),
          condition: () => true,
          emit: eventType("OrderRenamed"),
        }),
      )
      .reducer(
        reducerRule(eventType("OrderRenamed"))
          .apply(({ state, event: emitted }) => ({
            ...state,
            name: String(emitted.payload["name"]),
          }))
          .build(),
      );

    const receipt = boundary(
      boundaryName("Receipt"),
      contractPath(pathSegment("receipts"), pathParameter("id")),
    )
      .fallbackOverride(false)
      .identity({
        generate: ({ command }) => String(command.targetId),
      })
      .eventCatalog(
        event(eventType("ReceiptCreated"), {
          id: ({ command }: EventContext) => String(command.targetId),
          orderId: ({ command }: EventContext) => String(command.payload["orderId"]),
          amount: ({ command }: EventContext) => Number(command.payload["amount"]),
        }),
      )
      .behavior(
        defineBehavior({
          name: behaviorName("create-receipt"),
          operationId: operationId("createReceipt"),
          condition: () => true,
          emit: eventType("ReceiptCreated"),
        }),
      )
      .reducer(
        reducerRule(eventType("ReceiptCreated"))
          .apply(({ state, event: emitted }) => ({
            ...state,
            id: String(emitted.payload["id"]),
            orderId: String(emitted.payload["orderId"]),
            amount: Number(emitted.payload["amount"]),
          }))
          .build(),
      );

    const audit = boundary(
      boundaryName("Audit"),
      contractPath(pathSegment("audits"), pathParameter("id")),
    )
      .fallbackOverride(false)
      .identity({
        generate: ({ helpers }) => helpers.uuid(),
      })
      .eventCatalog(
        event(eventType("AuditRecorded"), {
          id: ({ helpers }: EventContext) => helpers.uuid(),
          orderId: ({ command }: EventContext) => String(command.payload["orderId"] ?? ""),
          action: "created",
        }),
      )
      .reducer(
        reducerRule(eventType("AuditRecorded"))
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
              name: faultName("parity-fault"),
              headers: { "x-parity-fault": "on" },
              matches: ({ headers }) => headers["x-parity-fault"] === "on",
              response: {
                status: 503,
                body: { error: "PARITY_FAULT", message: "deliberate parity fixture fault" },
                headers: { "Retry-After": "5" },
              },
            },
            {
              name: faultName("maintenance-response"),
              selectors: { forceResponse: "maintenance" },
              matches: () => true,
              response: {
                status: 502,
                body: { error: "MAINTENANCE_RESPONSE", message: "selected maintenance response" },
              },
            },
            {
              name: faultName("scenario-response"),
              selectors: { scenario: "slow_db" },
              matches: () => true,
              response: {
                status: 504,
                body: { error: "SCENARIO_RESPONSE", message: "selected scenario response" },
              },
            },
            {
              name: faultName("feature-response"),
              selectors: { featureFlag: "parity-beta" },
              matches: () => true,
              response: {
                status: 418,
                body: { error: "FEATURE_RESPONSE", message: "selected feature response" },
              },
            },
            {
              name: faultName("probability-response"),
              probability: 1,
              headers: { "x-parity-probability": "on" },
              matches: ({ headers }) => headers["x-parity-probability"] === "on",
              response: {
                status: 503,
                body: { error: "PROBABILITY_RESPONSE", message: "selected probability response" },
              },
            },
            {
              name: faultName("probability-off"),
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
              name: faultName("intermediate-probability"),
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
              name: faultName("operation-method-fault"),
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
              name: faultName("guarded-scoped-fault"),
              headers: { "x-parity-guarded": "on" },
              requiredScopes: [scopeName("writer")],
              requires: [
                {
                  name: guardName("parity-required-header"),
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
              name: faultName("boundary-intent-condition-fault"),
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
              name: faultName("ordered-first"),
              headers: { "x-parity-order": "same" },
              matches: ({ headers }) => headers["x-parity-order"] === "same",
              response: { status: 503, body: { error: "ORDERED_FIRST" } },
            },
            {
              name: faultName("ordered-second"),
              headers: { "x-parity-order": "same" },
              matches: ({ headers }) => headers["x-parity-order"] === "same",
              response: { status: 418, body: { error: "ORDERED_SECOND" } },
            },
            {
              name: faultName("wildcard-selector"),
              headers: { "x-parity-wildcard": "*" },
              matches: ({ headers }) => headers["x-parity-wildcard"] !== undefined,
              response: { status: 502, body: { error: "WILDCARD_SELECTOR" } },
            },
          ],
          sagas: [
            {
              name: sagaName("order-created-saga-receipt"),
              trigger: {
                boundary: boundaryName("Order"),
                intent: "creation",
                condition: () => true,
              },
              steps: [
                {
                  name: sagaStepName("create-saga-receipt"),
                  boundary: boundaryName("Receipt"),
                  intent: "creation",
                  operationId: operationId("createReceipt"),
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
              subscribe: [
                eventReference(boundaryName("Order"), eventType("OrderCreated")),
                eventReference(boundaryName("OrderById"), eventType("OrderRenamed")),
              ],
              reduce: [
                reducerRule(eventType("OrderCreated"))
                  .apply(({ state, event: emitted }) => ({
                    ...state,
                    name: String(emitted.payload["name"]),
                    renameCount: 0,
                  }))
                  .build(),
                reducerRule(eventType("OrderRenamed"))
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
              on: eventReference(boundaryName("Order"), eventType("OrderCreated")),
              intent: "creation",
              boundary: boundaryName("Audit"),
              emit: eventType("AuditRecorded"),
              payload: {
                orderId: ({ event: emitted }) => emitted?.aggregateId ?? "",
              },
            },
          ],
          webhooks: [
            {
              name: webhookName("order-created-hook"),
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
