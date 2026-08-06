import {
  PotemkinConfigure,
  defineResource,
  event,
  eventType,
  factoryName,
  operationId,
  reducerRule,
  resourceName,
  schemaReference,
  simulation,
} from 'potemkin/sdk';

const noteResource = defineResource({
  resource: resourceName('Note'),
  schema: schemaReference('Note'),
  identity: { generate: ({ helpers }) => helpers.uuid() },
  eventCatalog: [
    event(eventType('NoteCreated'), {
      id: ({ command }) => String(command.targetId),
      title: ({ command }) => String(command.payload['title']),
      body: ({ command }) => String(command.payload['body']),
    }),
  ],
  reducers: [
    reducerRule(eventType('NoteCreated'))
      .apply(({ state, event: emitted }) => ({
        ...state,
        id: String(emitted.payload['id']),
        title: String(emitted.payload['title']),
        body: String(emitted.payload['body']),
      }))
      .build(),
  ],
  operations: [
    { operationId: operationId('createNote'), emit: eventType('NoteCreated') },
    { operationId: operationId('getNote'), query: true },
  ],
});

export class TypeScriptNoteResourceFactory {
  @PotemkinConfigure(factoryName('note-resource-typescript'))
  static create() {
    return simulation().resource(noteResource).build();
  }
}
