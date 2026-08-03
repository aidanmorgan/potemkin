import {
  behaviorName,
  boundary,
  boundaryName,
  defineGlobal,
  event,
  eventReference,
  eventType,
  reducerRule,
  operationId,
  sagaName,
  sagaStepName,
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
  return boundary("RecordBatch", "/records/bulk")
    .identity({ generate: ({ command }) => String(command.payload.id ?? "") })
    .eventCatalog(
      event("RecordCreated", {
        id: ({ command }) => String(command.payload.id ?? ""),
        name: ({ command }) => String(command.payload.name ?? ""),
        source: () => "typescript",
      }),
    )
    .behavior({
      name: behaviorName("createRecordBatch"),
      operationId: "createRecordBatch",
      condition: () => true,
      emit: "RecordCreated",
      dispatchCommands: [
        {
          boundary: "BulkReceipt",
          intent: "creation",
          operationId: "createBulkReceipt",
          targetId: ({ command }) => `${command.targetId ?? ""}-receipt`,
          payload: {
            recordId: ({ command }) => command.targetId ?? "",
            kind: "dispatch",
          },
        },
      ],
    })
    .reducer(
      reducerRule<RecordCreated, RecordState>("RecordCreated")
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
  return boundary("RecordById", "/records/bulk/{id}").fallbackOverride(true).build();
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
  return boundary("BulkReceipt", "/bulk-receipts/{id}")
    .identity({ generate: ({ command }) => String(command.targetId ?? "") })
    .eventCatalog(
      event("BulkReceiptCreated", {
        id: ({ command }) => String(command.targetId ?? ""),
        recordId: ({ command }) => String(command.payload.recordId ?? ""),
        kind: ({ command }) => String(command.payload.kind ?? ""),
      }),
    )
    .behavior({
      name: behaviorName("createBulkReceipt"),
      operationId: "createBulkReceipt",
      condition: () => true,
      emit: "BulkReceiptCreated",
    })
    .reducer(
      reducerRule<BulkReceiptCreated, BulkReceiptState>("BulkReceiptCreated")
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
  return boundary("BulkAudit", "/bulk-audits/{id}")
    .identity({ generate: ({ helpers }) => helpers.uuid() })
    .eventCatalog(
      event("BulkAuditRecorded", {
        id: ({ command }) => String(command.targetId ?? ""),
        recordId: ({ command }) => String(command.payload.recordId ?? ""),
        action: "created",
      }),
    )
    .reducer(
      reducerRule<BulkAuditRecorded, BulkAuditState>("BulkAuditRecorded")
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
        name: "BulkSummary",
        key: ({ event }) => event?.aggregateId ?? "",
        subscribe: [eventReference(boundaryName("RecordBatch"), eventType("RecordCreated"))],
        reduce: [
          reducerRule("RecordCreated")
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
        name: "audit-record-creation",
        on: eventReference(boundaryName("RecordBatch"), eventType("RecordCreated")),
        intent: "creation",
        boundary: "BulkAudit",
        emit: "BulkAuditRecorded",
        payload: {
          recordId: ({ event }) => event?.aggregateId ?? "",
        },
      },
    ],
    webhooks: [
      {
        name: "record-created-hook",
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
