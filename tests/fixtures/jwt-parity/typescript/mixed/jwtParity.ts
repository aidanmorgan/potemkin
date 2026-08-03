import {
  PotemkinConfigure,
  behavior,
  behaviorName,
  boundary,
  boundaryName,
  contractPath,
  defineBehavior,
  event,
  eventType,
  factoryName,
  operationId,
  reducerRule,
  simulation,
  scopeName,
  pathSegment,
  type EventContext,
  type FactoryContext,
} from "potemkin/sdk";

const record = boundary(boundaryName("JwtRecord"), contractPath(pathSegment("jwt-records")))
  .fallbackOverride(false)
  .identity({ generate: ({ command }) => String(command.payload["id"]) })
  .eventCatalog(
    event(eventType("JwtRecordCreated"), {
      id: ({ command }: EventContext) => String(command.payload["id"]),
      value: ({ command }: EventContext) => String(command.payload["value"]),
      status: "CREATED",
    }),
  )
  .behavior(
    defineBehavior({
      name: behaviorName("create-jwt-record"),
      operationId: operationId("createJwtRecord"),
      condition: () => true,
      requiredScopes: [scopeName("writer")],
      emit: eventType("JwtRecordCreated"),
    }),
  )
  .reducer(
    reducerRule(eventType("JwtRecordCreated"))
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
