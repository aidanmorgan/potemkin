import {
  PotemkinConfigure,
  behavior,
  boundary,
  defineGlobal,
  event,
  factoryName,
  reducerRule,
  simulation,
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

export class JwtParityFactory {
  @PotemkinConfigure(factoryName("jwt-parity"))
  static create(_context: FactoryContext) {
    return simulation().boundary(record).global(jwtAuth).build();
  }
}
