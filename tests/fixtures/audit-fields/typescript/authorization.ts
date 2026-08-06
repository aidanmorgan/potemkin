import {
  PotemkinConfigure,
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
  pathSegment,
  reducerRule,
  simulation,
  scopeName,
  type EventContext,
} from 'potemkin/sdk';

export class AuthorizationTypeScriptFactory {
  @PotemkinConfigure(factoryName('authorization-typescript'))
  static create() {
    const note = boundary(boundaryName('Note'), contractPath(pathSegment('notes')))
      .identity({ generate: ({ helpers }) => helpers.uuid() })
      .eventCatalog(
        event(eventType('NoteCreated'), {
          id: ({ command }: EventContext) => String(command.targetId),
          title: ({ command }: EventContext) => String(command.payload['title']),
          body: ({ command }: EventContext) => String(command.payload['body']),
        }),
      )
      .behavior(
        defineBehavior({
          name: behaviorName('createNote'),
          operationId: operationId('createNote'),
          condition: () => true,
          requiredScopes: [scopeName('writer')],
          emit: eventType('NoteCreated'),
        }),
      )
      .reducer(
        reducerRule(eventType('NoteCreated'))
          .apply(({ state, event: emitted }) => ({
            ...state,
            id: emitted.payload['id'],
            title: emitted.payload['title'],
            body: emitted.payload['body'],
          }))
          .build(),
      )
      .build();
    return simulation()
      .boundary(note)
      .global(
        defineGlobal({
          auth: { mode: 'simple', authorize: (_input, scopes) => scopes.includes('writer') },
        }),
      )
      .build();
  }
}
