import { behaviorName, boundary, event, reducerRule, simulation } from "potemkin/sdk";
import { PotemkinConfigure, factoryName } from "potemkin/sdk";
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

export class ConfiguredWidget {
  @PotemkinConfigure(factoryName("configured-widget"))
  static create() {
    const widget = boundary("Widget", "/widgets")
      .identity({ generate: ({ helpers }) => helpers.uuid() })
      .eventCatalog(
        event("WidgetCreated", {
          id: ({ command }) => String(command.targetId ?? ""),
          name: ({ command }) => String(command.payload.name ?? ""),
          source: () => sourceLabel("typescript"),
        }),
      )
      .behavior({
        name: behaviorName("createWidget"),
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
      .build();

    return simulation()
      .boundary(widget)
      .boundary(boundary("WidgetById", "/widgets/{id}").fallbackOverride(true))
      .helper(sourceLabel)
      .build();
  }
}
