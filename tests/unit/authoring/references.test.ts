import {
  behaviorName,
  boundaryName,
  componentName,
  contractPath,
  eventReference,
  eventType,
  faultName,
  field,
  fieldPath,
  factoryName,
  helperName,
  operationId,
  pathParameter,
  pathSegment,
  resourceName,
  sagaName,
  sagaStepName,
  schemaReference,
  scopeName,
  linkRelation,
  TypeScriptReferenceError,
} from "../../../src/authoring/references.js";
import { sdk } from "../../../src/sdk/index.js";

describe("TypeScript semantic references", () => {
  it("builds canonical identifiers and paths from typed constructors", () => {
    expect(boundaryName("Orders")).toBe("Orders");
    expect(behaviorName("create-order")).toBe("create-order");
    expect(componentName("OrderComponents")).toBe("OrderComponents");
    expect(helperName("formatOrder")).toBe("formatOrder");
    expect(factoryName("order-scenario")).toBe("order-scenario");
    expect(scopeName("orders:write")).toBe("orders:write");
    expect(linkRelation("self")).toBe("self");
    expect(resourceName("Order")).toBe("Order");
    expect(operationId("createOrder")).toBe("createOrder");
    expect(eventType("OrderCreated")).toBe("OrderCreated");
    expect(eventReference(boundaryName("Orders"), eventType("OrderCreated"))).toBe(
      "Orders:OrderCreated",
    );
    expect(faultName("unavailable")).toBe("unavailable");
    expect(sagaName("order-flow")).toBe("order-flow");
    expect(sagaStepName("reserve")).toBe("reserve");
    expect(schemaReference("#/components/schemas/Order")).toBe("#/components/schemas/Order");
    expect(contractPath(pathSegment("orders"), pathParameter("id"))).toBe("/orders/{id}");
    expect(fieldPath(field("customer"), field("email"))).toBe("/customer/email");
  });

  it("rejects malformed semantic references before compilation", () => {
    expect(() => boundaryName(" ")).toThrow(
      expect.objectContaining({ code: "TS_REFERENCE_INVALID" }),
    );
    expect(() => operationId(" ")).toThrow(TypeScriptReferenceError);
    expect(() => pathSegment("orders/items")).toThrow(TypeScriptReferenceError);
    expect(() => fieldPath()).toThrow(TypeScriptReferenceError);
  });

  it("publishes the constructors through the supported SDK object", () => {
    expect(sdk.boundaryName("Orders")).toBe("Orders");
    expect(sdk.behaviorName("create-order")).toBe("create-order");
    expect(sdk.componentName("OrderComponents")).toBe("OrderComponents");
    expect(sdk.helperName("formatOrder")).toBe("formatOrder");
    expect(sdk.factoryName("order-scenario")).toBe("order-scenario");
    expect(sdk.scopeName("orders:write")).toBe("orders:write");
    expect(sdk.linkRelation("self")).toBe("self");
    expect(sdk.resourceName("Order")).toBe("Order");
    expect(sdk.contractPath(sdk.pathSegment("orders"))).toBe("/orders");
    expect(sdk.eventType("OrderCreated")).toBe("OrderCreated");
    expect(sdk.eventReference(sdk.boundaryName("Orders"), sdk.eventType("OrderCreated"))).toBe(
      "Orders:OrderCreated",
    );
    expect(sdk.faultName("unavailable")).toBe("unavailable");
    expect(sdk.sagaName("order-flow")).toBe("order-flow");
    expect(sdk.sagaStepName("reserve")).toBe("reserve");
    expect(sdk.expression("event", () => "value")({})).toBe("value");
  });
});
