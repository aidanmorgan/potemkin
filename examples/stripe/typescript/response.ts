import {
  PotemkinConfigure,
  defineHelper,
  factoryName,
  simulation,
  type JsonObject,
  type JsonValue,
} from "potemkin/sdk";

function stripeResponse(context: JsonObject): JsonValue {
  const operationId = typeof context["operationId"] === "string" ? context["operationId"] : "";
  const command = asObject(context["command"]);
  const response = asObject(context["response"]);
  const body = response["body"] ?? null;
  const visibleBody = stripInternalState(body);
  const objectName = objectNameFrom(visibleBody);

  if (operationId.startsWith("Delete") && objectName !== undefined) {
    const source = asObject(visibleBody);
    return {
      status: 200,
      body: { id: source["id"] ?? null, object: objectName, deleted: true },
    };
  }

  if (Array.isArray(visibleBody)) {
    return {
      body: {
        object: "list",
        url: typeof command["path"] === "string" ? command["path"] : "",
        has_more: false,
        data: visibleBody,
      },
    };
  }

  if (operationId.startsWith("Post") && !String(command["boundary"] ?? "").includes("By_")) {
    return { status: 200 };
  }

  return {};
}

function asObject(value: JsonValue | undefined): JsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function stripInternalState(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((item) => stripInternalState(item));
  if (value === null || typeof value !== "object") return value;
  const visible = { ...value };
  delete visible["_deleted"];
  delete visible["_deletedAt"];
  return visible;
}

function objectNameFrom(value: JsonValue): string | undefined {
  if (!Array.isArray(value)) {
    const object = asObject(value)["object"];
    return typeof object === "string" ? object : undefined;
  }
  const first = value[0];
  return first !== undefined ? objectNameFrom(first) : undefined;
}

const responseHelper = defineHelper<[JsonObject], JsonValue>("stripeResponse", stripeResponse);

export class StripeResponseConfiguration {
  @PotemkinConfigure(factoryName("stripe-response"))
  static create() {
    return simulation().helper(responseHelper).build();
  }
}
