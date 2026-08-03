import {
  behaviorName,
  boundary,
  boundaryName,
  contractPath,
  defineBehavior,
  defineGlobal,
  event,
  eventReference,
  eventType,
  reducerRule,
  operationId,
  pathParameter,
  pathSegment,
  projectionName,
  reactionName,
  sagaName,
  sagaStepName,
  webhookName,
  type EventContext,
} from "potemkin/sdk";

interface RecordState {
  id: string;
  name: string;
  source: string;
}

interface RecordCreated {
  id: string;
  name: string;
  source: string;
}

export function recordBatchBoundary() {
  return boundary(
    boundaryName("RecordBatch"),
    contractPath(pathSegment("records"), pathSegment("bulk")),
  )
    .identity({ generate: ({ command }) => String(command.payload.id ?? "") })
    .eventCatalog(
      event(eventType("RecordCreated"), {
        id: ({ command }: EventContext) => String(command.payload.id ?? ""),
        name: ({ command }: EventContext) => String(command.payload.name ?? ""),
        source: () => "typescript",
      }),
    )
    .behavior(
      defineBehavior({
        name: behaviorName("createRecordBatch"),
        operationId: operationId("createRecordBatch"),
        condition: () => true,
        emit: eventType("RecordCreated"),
        dispatchCommands: [
          {
            boundary: boundaryName("BulkReceipt"),
            intent: "creation",
            operationId: operationId("createBulkReceipt"),
            targetId: ({ command }) => `${command.targetId ?? ""}-receipt`,
            payload: {
              recordId: ({ command }) => command.targetId ?? "",
              kind: "dispatch",
            },
          },
        ],
      }),
    )
    .reducer(
      reducerRule<RecordCreated, RecordState>(eventType("RecordCreated"))
        .apply(({ state, event: emitted }) => ({
          ...state,
          id: emitted.payload.id,
          name: emitted.payload.name,
          source: emitted.payload.source,
        }))
        .build(),
    )
    .build();
}

export function recordByIdBoundary() {
  return boundary(
    boundaryName("RecordById"),
    contractPath(pathSegment("records"), pathSegment("bulk"), pathParameter("id")),
  )
    .fallbackOverride(true)
    .build();
}

interface BulkReceiptState {
  id: string;
  recordId: string;
  kind: string;
}

interface BulkReceiptCreated {
  id: string;
  recordId: string;
  kind: string;
}

export function receiptBoundary() {
  return boundary(
    boundaryName("BulkReceipt"),
    contractPath(pathSegment("bulk-receipts"), pathParameter("id")),
  )
    .identity({ generate: ({ command }) => String(command.targetId ?? "") })
    .eventCatalog(
      event(eventType("BulkReceiptCreated"), {
        id: ({ command }: EventContext) => String(command.targetId ?? ""),
        recordId: ({ command }: EventContext) => String(command.payload.recordId ?? ""),
        kind: ({ command }: EventContext) => String(command.payload.kind ?? ""),
      }),
    )
    .behavior(
      defineBehavior({
        name: behaviorName("createBulkReceipt"),
        operationId: operationId("createBulkReceipt"),
        condition: () => true,
        emit: eventType("BulkReceiptCreated"),
      }),
    )
    .reducer(
      reducerRule<BulkReceiptCreated, BulkReceiptState>(eventType("BulkReceiptCreated"))
        .apply(({ state, event: emitted }) => ({
          ...state,
          id: emitted.payload.id,
          recordId: emitted.payload.recordId,
          kind: emitted.payload.kind,
        }))
        .build(),
    )
    .build();
}

interface BulkAuditState {
  id: string;
  recordId: string;
  action: string;
}

interface BulkAuditRecorded {
  id: string;
  recordId: string;
  action: string;
}

export function auditBoundary() {
  return boundary(
    boundaryName("BulkAudit"),
    contractPath(pathSegment("bulk-audits"), pathParameter("id")),
  )
    .identity({ generate: ({ helpers }) => helpers.uuid() })
    .eventCatalog(
      event(eventType("BulkAuditRecorded"), {
        id: ({ command }: EventContext) => String(command.targetId ?? ""),
        recordId: ({ command }: EventContext) => String(command.payload.recordId ?? ""),
        action: "created",
      }),
    )
    .reducer(
      reducerRule<BulkAuditRecorded, BulkAuditState>(eventType("BulkAuditRecorded"))
        .apply(({ state, event: emitted }) => ({
          ...state,
          id: emitted.payload.id,
          recordId: emitted.payload.recordId,
          action: emitted.payload.action,
        }))
        .build(),
    )
    .build();
}

export function bulkGlobal() {
  return defineGlobal({
    sagas: [
      {
        name: sagaName("record-created-saga-receipt"),
        trigger: {
          boundary: boundaryName("RecordBatch"),
          intent: "creation",
          condition: () => true,
        },
        steps: [
          {
            name: sagaStepName("create-saga-receipt"),
            boundary: boundaryName("BulkReceipt"),
            intent: "creation",
            operationId: operationId("createBulkReceipt"),
            targetId: ({ event }) => `${event?.aggregateId ?? ""}-saga-receipt`,
            payload: {
              recordId: ({ event }) => event?.aggregateId ?? "",
              kind: "saga",
            },
          },
        ],
      },
    ],
    derivedProjections: [
      {
        name: projectionName("BulkSummary"),
        key: ({ event }) => event?.aggregateId ?? "",
        subscribe: [eventReference(boundaryName("RecordBatch"), eventType("RecordCreated"))],
        reduce: [
          reducerRule(eventType("RecordCreated"))
            .apply(({ state, event }) => ({
              ...state,
              name: String(event.payload.name),
              created: true,
            }))
            .build(),
        ],
      },
    ],
    reactions: [
      {
        name: reactionName("audit-record-creation"),
        on: eventReference(boundaryName("RecordBatch"), eventType("RecordCreated")),
        intent: "creation",
        boundary: boundaryName("BulkAudit"),
        emit: eventType("BulkAuditRecorded"),
        payload: {
          recordId: ({ event }) => event?.aggregateId ?? "",
        },
      },
    ],
    webhooks: [
      {
        name: webhookName("record-created-hook"),
        trigger: ({ event }) => event?.type === "RecordCreated",
        url: "http://127.0.0.1:19879/bulk-hook",
        payload: {
          recordId: ({ event }) => event?.aggregateId ?? "",
          event: ({ event }) => event?.type ?? "",
          name: ({ payload }) => String(payload["name"]),
        },
        retry: { maxAttempts: 1, delayMs: 1 },
      },
    ],
  });
}
