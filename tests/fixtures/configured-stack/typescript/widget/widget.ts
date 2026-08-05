import {
  behaviorName,
  boundary,
  boundaryName,
  contractPath,
  defineBehavior,
  event,
  eventType,
  factoryName,
  pathParameter,
  pathSegment,
  operationId,
  reducerRule,
  simulation,
  PotemkinConfigure,
  type EventContext,
} from 'potemkin/sdk';
import { sourceLabel } from '../shared/source-label';

interface WidgetState {
  id: string;
  name: string;
  source: string;
}

interface WidgetCreated {
  id: string;
  name: string;
  source: string;
}

export class ConfiguredWidget {
  @PotemkinConfigure(factoryName('configured-widget'))
  static create() {
    const widget = boundary(boundaryName('Widget'), contractPath(pathSegment('widgets')))
      .identity({ generate: ({ helpers }) => helpers.uuid() })
      .eventCatalog(
        event(eventType('WidgetCreated'), {
          id: ({ command }: EventContext) => String(command.targetId ?? ''),
          name: ({ command }: EventContext) => String(command.payload.name ?? ''),
          source: () => sourceLabel('typescript'),
        }),
      )
      .behavior(
        defineBehavior({
          name: behaviorName('createWidget'),
          operationId: operationId('createWidget'),
          condition: () => true,
          emit: eventType('WidgetCreated'),
        }),
      )
      .reducer(
        reducerRule<WidgetCreated, WidgetState>(eventType('WidgetCreated'))
          .apply(({ state, event: emitted }) => ({
            ...state,
            id: emitted.payload.id,
            name: emitted.payload.name,
            source: emitted.payload.source,
          }))
          .build(),
      )
      .build();

    return simulation()
      .boundary(widget)
      .boundary(
        boundary(
          boundaryName('WidgetById'),
          contractPath(pathSegment('widgets'), pathParameter('id')),
        ).fallbackOverride(true),
      )
      .helper(sourceLabel)
      .build();
  }
}
