import * as path from "node:path";
import { loadOpenApi } from "../../src/contract/loader.js";
import { bootYamlRuntime } from "../../src/parser/runtime.js";
import { createDefaultRuntimeHost } from "../../src/runtime/host.js";

const STRICT_DSL = `
boundary: OrderItem
contract_path: /order-items
identity:
  creation:
    generate: $uuidv7()
event_catalog:
  - type: OrderItemCreated
    payload_template:
      id: command.targetId
      quantity: command.payload.quantity
      unitPrice: command.payload.unitPrice
state:
  computed:
    - name: lineTotal
      formula: "state.quantity * state.unitPrice"
      depends_on: [unitPrice]
behaviors:
  - name: createOrderItem
    match: { operationId: createOrderItem, condition: "true" }
    emit: OrderItemCreated
reducers:
  - on: OrderItemCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /quantity, value: "\${event.payload.quantity}" }
      - { op: replace, path: /unitPrice, value: "\${event.payload.unitPrice}" }
`;

it("rejects an incomplete strict YAML dependency declaration before traffic", async () => {
  const openapi = await loadOpenApi(
    path.resolve(
      __dirname,
      "..",
      "fixtures",
      "strict-schema",
      "openapi",
      "strict-schema-demo.yaml",
    ),
  );
  await expect(
    bootYamlRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      yamlProgram: { modules: [{ name: "strict.yaml", yaml: STRICT_DSL }] },
    }),
  ).rejects.toMatchObject({ code: "BOOT_ERR_COMPUTED_FIELD_INCOMPLETE_DEPS" });
});
