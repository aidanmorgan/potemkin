import {
  PotemkinConfigure,
  behavior,
  boundary,
  event,
  factoryName,
  reducerRule,
  simulation,
  type FactoryContext,
} from "potemkin/sdk";

const record = boundary("JwtRecord", "/jwt-records")
  .fallbackOverride(false)
  .identity({ generate: ({ command }) => String(command.payload["id"]) })
  .eventCatalog(
    event("JwtRecordCreated", {
      id: ({ command }) => String(command.payload["id"]),
      value: ({ command }) => String(command.payload["value"]),
      status: "CREATED",
    }),
  )
  .behavior(
    behavior({
      name: "create-jwt-record",
      operationId: "createJwtRecord",
      condition: () => true,
      requiredScopes: ["writer"],
      emit: "JwtRecordCreated",
    }),
  )
  .reducer(
    reducerRule("JwtRecordCreated")
      .apply(({ state, event: emitted }) => ({
        ...state,
        id: String(emitted.payload["id"]),
        value: String(emitted.payload["value"]),
        status: String(emitted.payload["status"]),
      }))
      .build(),
  );

export class JwtParityMixedFactory {
  @PotemkinConfigure(factoryName("jwt-parity-mixed"))
  static create(_context: FactoryContext) {
    return simulation().boundary(record).build();
  }
}
