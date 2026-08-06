import {
  PotemkinConfigure,
  behaviorName,
  boundary,
  boundaryName,
  contractPath,
  defineBehavior,
  event,
  eventType,
  field,
  fieldPath,
  factoryName,
  operationId,
  pathParameter,
  pathSegment,
  reducerRule,
  simulation,
  stateFieldName,
  type EventContext,
} from 'potemkin/sdk';

export class StrictSchemaTypeScriptFactory {
  @PotemkinConfigure(factoryName('strict-schema-typescript'))
  static create() {
    const item = boundary(boundaryName('OrderItem'), contractPath(pathSegment('order-items')))
      .fallbackOverride(false)
      .strictSchema(false)
      .mask(fieldPath(field('internalCode')))
      .identity({ generate: ({ helpers }) => helpers.uuid() })
      .state({
        computed: [
          {
            name: stateFieldName('lineTotal'),
            formula: ({ state }) => Number(state['quantity']) * Number(state['unitPrice']),
            dependsOn: [stateFieldName('unitPrice')],
          },
        ],
        internal: [{ name: stateFieldName('internalCode'), type: 'string' }],
        validate: (state) => {
          if (Number(state['quantity']) < 0) throw new Error('quantity must be non-negative');
        },
      })
      .eventCatalog(
        event(eventType('OrderItemCreated'), {
          id: ({ command }: EventContext) => String(command.targetId),
          description: ({ command }: EventContext) => String(command.payload['description']),
          quantity: ({ command }: EventContext) => Number(command.payload['quantity']),
          unitPrice: ({ command }: EventContext) => Number(command.payload['unitPrice']),
          internalCode: 'private',
        }),
      )
      .behavior(
        defineBehavior({
          name: behaviorName('createOrderItem'),
          operationId: operationId('createOrderItem'),
          condition: () => true,
          emit: eventType('OrderItemCreated'),
        }),
      )
      .reducer(
        reducerRule(eventType('OrderItemCreated'))
          .apply(({ state, event: emitted }) => ({
            ...state,
            id: String(emitted.payload['id']),
            description: String(emitted.payload['description']),
            quantity: Number(emitted.payload['quantity']),
            unitPrice: Number(emitted.payload['unitPrice']),
            internalCode: 'private',
          }))
          .build(),
      )
      .build();
    const byId = boundary(
      boundaryName('OrderItemById'),
      contractPath(pathSegment('order-items'), pathParameter('id')),
    )
      .fallbackOverride(true)
      .identity({ key: { from: 'path', name: 'id' } })
      .build();
    return simulation().boundary(item).boundary(byId).build();
  }
}
