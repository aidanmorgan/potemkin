import {
  PotemkinConfigure,
  behaviorName,
  componentName,
  contractPath,
  defineBehavior,
  defineComponent,
  event,
  eventType,
  factoryName,
  include,
  operationId,
  pathSegment,
  reducerRule,
  simulation,
  use,
  boundaryName,
  type EventContext,
} from 'potemkin/sdk';

const auditFragment = defineComponent(componentName('WidgetAuditFragment'), () => ({
  eventCatalog: [event(eventType('WidgetAudited'), { marker: 'included' })],
  behaviors: [],
  reducers: [],
}));

const widgetComponent = defineComponent(componentName('WidgetComponent'), () => ({
  include: [include(auditFragment)],
  identity: { generate: ({ helpers }) => helpers.uuid() },
  eventCatalog: [
    event(eventType('WidgetCreated'), {
      id: ({ command }: EventContext) => String(command.targetId),
      name: ({ command }: EventContext) => String(command.payload['name']),
      source: 'typescript-component',
    }),
  ],
  behaviors: [
    defineBehavior({
      name: behaviorName('createWidget'),
      operationId: operationId('createWidget'),
      condition: () => true,
      emit: eventType('WidgetCreated'),
    }),
  ],
  reducers: [
    reducerRule(eventType('WidgetCreated'))
      .apply(({ state, event: emitted }) => ({
        ...state,
        id: String(emitted.payload['id']),
        name: String(emitted.payload['name']),
        source: String(emitted.payload['source']),
      }))
      .build(),
  ],
}));

export class TypeScriptCompositionFactory {
  @PotemkinConfigure(factoryName('typescript-composition'))
  static create() {
    return simulation()
      .component(auditFragment)
      .component(widgetComponent)
      .use(use(widgetComponent, boundaryName('Widget'), contractPath(pathSegment('widgets'))))
      .build();
  }
}
