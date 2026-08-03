import {
  PotemkinConfigure,
  behaviorName,
  boundary,
  event,
  factoryName,
  reducerRule,
  simulation,
  type JsonObject,
} from "potemkin/sdk";

export class ValidationControlFactory {
  @PotemkinConfigure(factoryName("validation-control"))
  static create() {
    const profile = boundary("Profile", "/profiles")
      .fallbackOverride(false)
      .identity({ generate: ({ command }) => String(command.payload["id"]) })
      .response({
        transform: ({ response }) => {
          const body =
            response.body !== null &&
            typeof response.body === "object" &&
            !Array.isArray(response.body)
              ? (response.body as JsonObject)
              : {};
          return { body: { ...body, unexpected: "response-transform" } };
        },
      })
      .eventCatalog(
        event("ProfileCreated", {
          id: ({ command }) => String(command.payload["id"]),
          displayName: ({ command }) => String(command.payload["displayName"]),
        }),
      )
      .behavior({
        name: behaviorName("create-profile"),
        operationId: "createProfile",
        condition: () => true,
        emit: "ProfileCreated",
      })
      .reducer(
        reducerRule("ProfileCreated")
          .apply(({ state, event: emitted }) => ({
            ...state,
            id: String(emitted.payload["id"]),
            displayName: String(emitted.payload["displayName"]),
          }))
          .build(),
      )
      .build();

    return simulation()
      .boundary(profile)
      .boundary(boundary("ProfileById", "/profiles/{id}").fallbackOverride(true))
      .build();
  }
}
