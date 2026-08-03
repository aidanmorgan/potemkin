import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadOpenApiDocuments } from "../../../src/contract/loader";

describe("multiple OpenAPI document loading", () => {
  it("resolves multiple globs into one composite contract", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "potemkin-openapi-globs-"));
    try {
      await fs.writeFile(path.join(root, "widgets.yaml"), contract("/widgets", "listWidgets"));
      await fs.writeFile(path.join(root, "gadgets.yaml"), contract("/gadgets", "listGadgets"));

      const document = await loadOpenApiDocuments(["*.yaml"], root);

      expect(Object.keys(document.paths).sort()).toEqual(["/gadgets", "/widgets"]);
      expect(document.operationIdIndex?.get("GET /widgets")).toBe("listWidgets");
      expect(document.operationIdIndex?.get("GET /gadgets")).toBe("listGadgets");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

function contract(routePath: string, operationId: string): string {
  return `
    openapi: 3.0.0
    info: { title: test, version: '1' }
    paths:
      ${routePath}:
        get:
          operationId: ${operationId}
          responses:
            '200':
              description: ok
  `;
}
