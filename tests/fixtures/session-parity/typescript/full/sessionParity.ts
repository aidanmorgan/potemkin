import {
  PotemkinConfigure,
  boundary,
  behaviorName,
  defineBehavior,
  defineGlobal,
  event,
  eventType,
  factoryName,
  operationId,
  contractPath,
  boundaryName,
  pathParameter,
  pathSegment,
  reducerRule,
  simulation,
  scopeName,
  type EventContext,
  type FactoryContext,
} from 'potemkin/sdk';

const sessionAuth = defineGlobal({
  auth: {
    mode: 'session',
    session: {
      cookieName: 'parity_sid',
      ttlSeconds: 3600,
      csrfHeader: 'x-parity-csrf',
      loginPath: '/sessions',
      logoutPath: '/sessions/current',
    },
  },
  idempotency: { enabled: true, ttlSeconds: 60, hashIncludesBody: true },
});

const record = boundary(boundaryName('Record'), contractPath(pathSegment('records')))
  .fallbackOverride(false)
  .identity({
    generate: ({ command }) => String(command.payload['id']),
  })
  .eventCatalog(
    event(eventType('RecordCreated'), {
      id: ({ command }: EventContext) => String(command.payload['id']),
      value: ({ command }: EventContext) => String(command.payload['value']),
      status: 'CREATED',
    }),
  )
  .behavior(
    defineBehavior({
      name: behaviorName('list-records'),
      operationId: operationId('listRecords'),
      condition: () => true,
    }),
    defineBehavior({
      name: behaviorName('create-record'),
      operationId: operationId('createRecord'),
      condition: () => true,
      requiredScopes: [scopeName('writer')],
      emit: eventType('RecordCreated'),
    }),
  )
  .reducer(
    reducerRule(eventType('RecordCreated'))
      .apply(({ state, event: emitted }) => ({
        ...state,
        id: String(emitted.payload['id']),
        value: String(emitted.payload['value']),
        status: String(emitted.payload['status']),
      }))
      .build(),
  );

const recordById = boundary(
  boundaryName('RecordById'),
  contractPath(pathSegment('records'), pathParameter('id')),
)
  .fallbackOverride(true)
  .identity({ key: { from: 'path', name: 'id' } });

export class SessionParityFactory {
  @PotemkinConfigure(factoryName('session-parity'))
  static create(_context: FactoryContext) {
    return simulation().boundary(record).boundary(recordById).global(sessionAuth).build();
  }
}
