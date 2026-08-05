import {
  PotemkinConfigure,
  boundary,
  behaviorName,
  defineBehavior,
  event,
  eventType,
  factoryName,
  operationId,
  boundaryName,
  contractPath,
  pathSegment,
  reducerRule,
  simulation,
  scopeName,
  type EventContext,
  type FactoryContext,
} from 'potemkin/sdk';

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

export class SessionParityMixedFactory {
  @PotemkinConfigure(factoryName('session-parity-mixed'))
  static create(_context: FactoryContext) {
    return simulation().boundary(record).build();
  }
}
