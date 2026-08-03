import {
  boundaryName,
  contractPath,
  eventType,
  field,
  fieldPath,
  operationId,
  pathParameter,
  pathSegment,
  schemaReference,
  TypeScriptReferenceError,
} from "../../../src/authoring/references.js";
import { sdk } from "../../../src/sdk/index.js";

describe("TypeScript semantic references", () => {
  it("builds canonical identifiers and paths from typed constructors", () => {
    expect(boundaryName("Orders")).toBe("Orders");
    expect(operationId("createOrder")).toBe("createOrder");
    expect(eventType("OrderCreated")).toBe("OrderCreated");
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
    expect(sdk.contractPath(sdk.pathSegment("orders"))).toBe("/orders");
    expect(sdk.eventType("OrderCreated")).toBe("OrderCreated");
    expect(sdk.expression("event", () => "value")({})).toBe("value");
  });
});
