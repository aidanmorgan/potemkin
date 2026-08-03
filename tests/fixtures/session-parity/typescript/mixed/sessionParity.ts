import {
  PotemkinConfigure,
  boundary,
  behavior,
  event,
  factoryName,
  reducerRule,
  simulation,
  scopeName,
  type FactoryContext,
} from "potemkin/sdk";

const record = boundary("Record", "/records")
  .fallbackOverride(false)
  .identity({
    generate: ({ command }) => String(command.payload["id"]),
  })
  .eventCatalog(
    event("RecordCreated", {
      id: ({ command }) => String(command.payload["id"]),
      value: ({ command }) => String(command.payload["value"]),
      status: "CREATED",
    }),
  )
  .behavior(
    behavior({
      name: "list-records",
      operationId: "listRecords",
      condition: () => true,
    }),
    behavior({
      name: "create-record",
      operationId: "createRecord",
      condition: () => true,
      requiredScopes: [scopeName("writer")],
      emit: "RecordCreated",
    }),
  )
  .reducer(
    reducerRule("RecordCreated")
      .apply(({ state, event: emitted }) => ({
        ...state,
        id: String(emitted.payload["id"]),
        value: String(emitted.payload["value"]),
        status: String(emitted.payload["status"]),
      }))
      .build(),
  );

export class SessionParityMixedFactory {
  @PotemkinConfigure(factoryName("session-parity-mixed"))
  static create(_context: FactoryContext) {
    return simulation().boundary(record).build();
  }
}
