import {
  PotemkinConfigure,
  behaviorName,
  boundary,
  boundaryName,
  contractPath,
  defineBehavior,
  event,
  eventType,
  factoryName,
  linkRelation,
  operationId,
  pathSegment,
  reducerRule,
  simulation,
} from 'potemkin/sdk';
import type { EventContext } from 'potemkin/sdk';

export class TypeScriptHateoasFactory {
  @PotemkinConfigure(factoryName('typescript-hateoas'))
  static create() {
    const order = boundary(boundaryName('Order'), contractPath(pathSegment('orders')))
      .identity({ generate: ({ command }) => String(command.payload['id']) })
      .response({
        hateoas: [
          { rel: linkRelation('self'), href: '/orders' },
          { rel: linkRelation('action'), href: '/orders', condition: () => true },
          { rel: linkRelation('hidden'), href: '/orders/hidden', condition: () => false },
        ],
      })
      .eventCatalog(
        event(eventType('OrderCreated'), {
          id: ({ command }: EventContext) => String(command.payload['id']),
          name: ({ command }: EventContext) => String(command.payload['name']),
          quantity: ({ command }: EventContext) => Number(command.payload['quantity']),
          status: 'CREATED',
        }),
      )
      .behavior(
        defineBehavior({
          name: behaviorName('create-order'),
          operationId: operationId('createOrder'),
          condition: () => true,
          emit: eventType('OrderCreated'),
          linkName: linkRelation('create'),
          linkCondition: () => true,
        }),
      )
      .reducer(
        reducerRule(eventType('OrderCreated'))
          .apply(({ state, event: emitted }) => ({ ...state, ...emitted.payload }))
          .build(),
      );
    return simulation().boundary(order).build();
  }
}
