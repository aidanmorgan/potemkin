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
  operationId,
  pathParameter,
  pathSegment,
  reducerRule,
  simulation,
  type EventContext,
  type JsonObject,
} from 'potemkin/sdk';

export class ValidationControlFactory {
  @PotemkinConfigure(factoryName('validation-control'))
  static create() {
    const profile = boundary(boundaryName('Profile'), contractPath(pathSegment('profiles')))
      .fallbackOverride(false)
      .identity({ generate: ({ command }) => String(command.payload['id']) })
      .response({
        transform: ({ response }) => {
          const body =
            response.body !== null &&
            typeof response.body === 'object' &&
            !Array.isArray(response.body)
              ? (response.body as JsonObject)
              : {};
          return { body: { ...body, unexpected: 'response-transform' } };
        },
      })
      .eventCatalog(
        event(eventType('ProfileCreated'), {
          id: ({ command }: EventContext) => String(command.payload['id']),
          displayName: ({ command }: EventContext) => String(command.payload['displayName']),
        }),
      )
      .behavior(
        defineBehavior({
          name: behaviorName('create-profile'),
          operationId: operationId('createProfile'),
          condition: () => true,
          emit: eventType('ProfileCreated'),
        }),
      )
      .reducer(
        reducerRule(eventType('ProfileCreated'))
          .apply(({ state, event: emitted }) => ({
            ...state,
            id: String(emitted.payload['id']),
            displayName: String(emitted.payload['displayName']),
          }))
          .build(),
      )
      .build();

    return simulation()
      .boundary(profile)
      .boundary(
        boundary(
          boundaryName('ProfileById'),
          contractPath(pathSegment('profiles'), pathParameter('id')),
        ).fallbackOverride(true),
      )
      .build();
  }
}
