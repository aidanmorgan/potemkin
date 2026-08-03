import {
  PotemkinConfigure,
  behavior,
  behaviorName,
  boundary,
  boundaryName,
  contractPath,
  defineBehavior,
  defineGlobal,
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

const jwtAuth = defineGlobal({
  auth: {
    mode: "jwt",
    jwt: {
      secret: "potemkin-jwt-parity-secret",
      algorithm: "HS256",
      issuer: "potemkin-jwt-parity",
      audience: "potemkin-jwt-api",
      subjectClaim: "sub",
      scopesClaim: "scopes",
    },
  },
  idempotency: { enabled: true, ttlSeconds: 60, hashIncludesBody: true },
});

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

export class JwtParityFactory {
  @PotemkinConfigure(factoryName("jwt-parity"))
  static create(_context: FactoryContext) {
    return simulation().boundary(record).global(jwtAuth).build();
  }
}
