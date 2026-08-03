import {
  PotemkinConfigure,
  boundary,
  behavior,
  behaviorName,
  defineGlobal,
  event,
  factoryName,
  reducerRule,
  simulation,
  scopeName,
  type FactoryContext,
} from "potemkin/sdk";

const sessionAuth = defineGlobal({
  auth: {
    mode: "session",
    session: {
      cookieName: "parity_sid",
      ttlSeconds: 3600,
      csrfHeader: "x-parity-csrf",
      loginPath: "/sessions",
      logoutPath: "/sessions/current",
    },
  },
  idempotency: { enabled: true, ttlSeconds: 60, hashIncludesBody: true },
});

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
      name: behaviorName("list-records"),
      operationId: "listRecords",
      condition: () => true,
    }),
    behavior({
      name: behaviorName("create-record"),
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

const recordById = boundary("RecordById", "/records/{id}")
  .fallbackOverride(true)
  .identity({ key: { from: "path", name: "id" } });

export class SessionParityFactory {
  @PotemkinConfigure(factoryName("session-parity"))
  static create(_context: FactoryContext) {
    return simulation().boundary(record).boundary(recordById).global(sessionAuth).build();
  }
}
