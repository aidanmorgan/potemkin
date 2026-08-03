import { boundary, event, reducerRule, simulation } from "potemkin/sdk";
import { PotemkinConfigure, factoryName, type FactoryContext } from "potemkin/sdk";
import { sourceLabel } from "../shared/source-label";

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

export class ConfiguredWidgetFactory {
  @PotemkinConfigure(factoryName("configured-widget"))
  static create(_context: FactoryContext) {
    return simulation()
      .boundary(
        boundary("Widget", "/widgets")
          .identity({ generate: ({ helpers }) => helpers.uuid() })
          .eventCatalog(
            event("WidgetCreated", {
              id: ({ command }) => String(command.targetId ?? ""),
              name: ({ command }) => String(command.payload.name ?? ""),
              source: () => sourceLabel("typescript"),
            }),
          )
          .behavior({
            name: "createWidget",
            operationId: "createWidget",
            condition: () => true,
            emit: "WidgetCreated",
          })
          .reducer(
            reducerRule<WidgetCreated, WidgetState>("WidgetCreated")
              .apply(({ state, event: emitted }) => ({
                ...state,
                id: emitted.payload.id,
                name: emitted.payload.name,
                source: emitted.payload.source,
              }))
              .build(),
          )
          .build(),
      )
      .boundary(boundary("WidgetById", "/widgets/{id}").fallbackOverride(true))
      .helper(sourceLabel)
      .build();
  }
}
