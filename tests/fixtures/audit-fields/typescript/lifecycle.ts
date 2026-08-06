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
  type EventContext,
} from 'potemkin/sdk';

function record(_phase: string): void {
  /* lifecycle hook intentionally has no external side effect */
}

export class LifecycleTypeScriptFactory {
  @PotemkinConfigure(factoryName('lifecycle-typescript'))
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
          lifecycle: {
            boot: () => record('boot'),
            request: () => record('request'),
            reset: () => record('reset'),
            shutdown: () => record('shutdown'),
          },
        }),
      )
      .build();
  }
}
