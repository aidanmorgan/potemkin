import {
  PotemkinConfigure,
  boundary,
  boundaryName,
  behaviorName,
  contractPath,
  defineBehavior,
  defineGlobal,
  event,
  eventType,
  factoryName,
  operationId,
  pathParameter,
  pathSegment,
  reducerRule,
  simulation,
  type EventContext,
} from 'potemkin/sdk';

export class AuditFieldsTypeScriptFactory {
  @PotemkinConfigure(factoryName('audit-fields-typescript'))
  static create() {
    const note = boundary(boundaryName('Note'), contractPath(pathSegment('notes')))
      .auditFields()
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
            id: String(emitted.payload['id']),
            title: String(emitted.payload['title']),
            body: String(emitted.payload['body']),
          }))
          .build(),
      )
      .build();
    const noteById = boundary(
      boundaryName('NoteById'),
      contractPath(pathSegment('notes'), pathParameter('id')),
    )
      .fallbackOverride(true)
      .auditFields()
      .identity({ key: { from: 'path', name: 'id' } })
      .build();
    return simulation()
      .boundary(note)
      .boundary(noteById)
      .global(defineGlobal({ auth: { mode: 'simple' } }))
      .build();
  }
}
