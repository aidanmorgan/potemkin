import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { OpenApiDoc } from "../../../src/contract/loader";
import { bootYamlRuntimeFromConfig } from "../../../src/parser/files";
import { createDefaultRuntimeHost } from "../../../src/runtime/host";

const openapi = {
  raw: {},
  paths: {
    "/widgets": { get: { operationId: "listWidgets" } },
  },
} as OpenApiDoc;

describe("configured runtime boot", () => {
  it("boots TypeScript endpoints selected by potemkin.yml", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "potemkin-configured-runtime-"));
    try {
      await fs.writeFile(path.join(root, "global.yaml"), "# global configuration is optional\n");
      await fs.writeFile(
        path.join(root, "model.ts"),
        `
        import { boundary, simulation } from 'potemkin/sdk';
        import { PotemkinConfigure } from 'potemkin/sdk';
        class Scenario {
          @PotemkinConfigure('widgets')
          static create() {
            return simulation().boundary(boundary('Widget', '/widgets').build()).build();
          }
        }
      `,
      );
      const configPath = path.join(root, "potemkin.yml");
      await fs.writeFile(
        configPath,
        `
        version: 1
        specmatic: ./specmatic.yaml
        modules: [global.yaml]
        typescript:
          scan:
            - include: [model.ts]
              exclude: ['**/*.test.ts']
      `,
      );

      const system = await bootYamlRuntimeFromConfig({
        host: createDefaultRuntimeHost(),
        openapi,
        potemkinConfigPath: configPath,
      });
      try {
        expect(system.program.byBoundaryName.has("Widget")).toBe(true);
        expect(system.configuration?.typescript?.scan[0]?.include).toEqual(["model.ts"]);
      } finally {
        await system.dispose();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("loads multiple OpenAPI globs declared by the single potemkin configuration", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "potemkin-configured-openapi-"));
    try {
      await fs.writeFile(path.join(root, "global.yaml"), "# global configuration is optional\n");
      await fs.mkdir(path.join(root, "openapi"));
      await fs.writeFile(path.join(root, "model.ts"), "// no TypeScript factories in this case\n");
      await fs.writeFile(
        path.join(root, "openapi", "widgets.yaml"),
        openapiDocument("/widgets", "listWidgets"),
      );
      await fs.writeFile(
        path.join(root, "openapi", "gadgets.yaml"),
        openapiDocument("/gadgets", "listGadgets"),
      );
      await fs.writeFile(path.join(root, "model.ts"), model("Widget"));
      const configPath = path.join(root, "potemkin.yml");
      await fs.writeFile(
        configPath,
        `
        version: 1
        specmatic: ./specmatic.yaml
        openapi: ["openapi/*.yaml"]
        modules: [global.yaml]
        typescript:
          scan:
            - include: [model.ts]
      `,
      );

      const system = await bootYamlRuntimeFromConfig({
        host: createDefaultRuntimeHost(),
        openapi,
        potemkinConfigPath: configPath,
      });
      try {
        expect(Object.keys(system.openapi.paths).sort()).toEqual(["/gadgets", "/widgets"]);
      } finally {
        await system.dispose();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses the configured Specmatic document when no explicit OpenAPI glob is present", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "potemkin-configured-specmatic-source-"));
    try {
      await fs.mkdir(path.join(root, "openapi"));
      await fs.writeFile(
        path.join(root, "openapi", "source.yaml"),
        openapiDocument("/from-specmatic", "listFromSpecmatic"),
      );
      await fs.writeFile(
        path.join(root, "specmatic.yaml"),
        `
        version: 3
        systemUnderTest:
          service:
            definitions:
              - source: { fileSystem: { directory: ./openapi } }
                specs:
                  - id: configured-source
                    path: source.yaml
      `,
      );
      await fs.writeFile(path.join(root, "global.yaml"), "# global configuration is optional\n");
      await fs.writeFile(path.join(root, "model.ts"), "// no TypeScript factories in this case\n");
      const configPath = path.join(root, "potemkin.yml");
      await fs.writeFile(
        configPath,
        `
        version: 1
        specmatic: ./specmatic.yaml
        modules: [global.yaml]
        typescript:
          scan:
            - include: [model.ts]
      `,
      );

      const system = await bootYamlRuntimeFromConfig({
        host: createDefaultRuntimeHost(),
        openapi,
        potemkinConfigPath: configPath,
      });
      try {
        expect(system.openapi.paths["/from-specmatic"]?.get?.operationId).toBe("listFromSpecmatic");
        expect(system.openapi.paths["/widgets"]).toBeUndefined();
      } finally {
        await system.dispose();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reloads a changed OpenAPI document selected by a configured glob", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "potemkin-configured-openapi-watch-"));
    try {
      await fs.writeFile(path.join(root, "global.yaml"), "# global configuration is optional\n");
      await fs.mkdir(path.join(root, "openapi"));
      const widgetsPath = path.join(root, "openapi", "widgets.yaml");
      const gadgetsPath = path.join(root, "openapi", "gadgets.yaml");
      await fs.writeFile(widgetsPath, openapiDocument("/widgets", "listWidgets"));
      await fs.writeFile(gadgetsPath, openapiDocument("/gadgets", "listGadgets"));
      const configPath = path.join(root, "potemkin.yml");
      await fs.writeFile(
        configPath,
        `
        version: 1
        specmatic: ./specmatic.yaml
        openapi: ["openapi/*.yaml"]
        modules: [global.yaml]
        typescript:
          scan:
            - include: [model.ts]
          watchIntervalMs: 20
      `,
      );

      const system = await bootYamlRuntimeFromConfig({
        host: createDefaultRuntimeHost(),
        openapi,
        potemkinConfigPath: configPath,
      });
      try {
        expect(system.openapi.paths["/gadgets"]?.get?.operationId).toBe("listGadgets");
        await fs.writeFile(gadgetsPath, openapiDocument("/gadgets", "listGadgetsV2"));
        await waitFor(() => system.openapi.paths["/gadgets"]?.get?.operationId === "listGadgetsV2");
        expect(system.openapi.paths["/widgets"]?.get?.operationId).toBe("listWidgets");
      } finally {
        await system.dispose();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reloads the canonical program when a selected TypeScript file changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "potemkin-configured-watch-"));
    try {
      await fs.writeFile(path.join(root, "global.yaml"), "# global configuration is optional\n");
      const modelPath = path.join(root, "model.ts");
      await fs.writeFile(modelPath, model("Widget"));
      const configPath = path.join(root, "potemkin.yml");
      await fs.writeFile(
        configPath,
        `
        version: 1
        specmatic: ./specmatic.yaml
        modules: [global.yaml]
        typescript:
          scan:
            - include: [model.ts]
          watchIntervalMs: 20
      `,
      );

      const system = await bootYamlRuntimeFromConfig({
        host: createDefaultRuntimeHost(),
        openapi,
        potemkinConfigPath: configPath,
      });
      try {
        expect(system.transitionModel?.machines.map((machine) => machine.aggregate)).toEqual([
          "Widget",
        ]);
        await fs.writeFile(modelPath, model("Gadget"));
        await waitFor(() => system.program.byBoundaryName.has("Gadget"));
        expect(system.program.byBoundaryName.has("Widget")).toBe(false);
        expect(system.transitionModel?.machines.map((machine) => machine.aggregate)).toEqual([
          "Widget",
        ]);

        await fs.writeFile(configPath, configYaml(2));
        await waitFor(() => system.configuration?.version === 2);
      } finally {
        await system.dispose();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reloads when a new TypeScript file enters a selected glob", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "potemkin-configured-watch-add-"));
    try {
      await fs.writeFile(path.join(root, "global.yaml"), "# global configuration is optional\n");
      await fs.writeFile(path.join(root, "model.ts"), model("Widget"));
      const configPath = path.join(root, "potemkin.yml");
      await fs.writeFile(
        configPath,
        `
        version: 1
        specmatic: ./specmatic.yaml
        modules: [global.yaml]
        typescript:
          scan:
            - include: ['*.ts']
          watchIntervalMs: 20
      `,
      );

      const system = await bootYamlRuntimeFromConfig({
        host: createDefaultRuntimeHost(),
        openapi,
        potemkinConfigPath: configPath,
      });
      try {
        await fs.writeFile(
          path.join(root, "gadget.ts"),
          model("Gadget").replace("/widgets", "/gadgets"),
        );
        await waitFor(() => system.program.byBoundaryName.has("Gadget"));
        expect(system.program.byBoundaryName.has("Widget")).toBe(true);
      } finally {
        await system.dispose();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

function model(name: string): string {
  return `
    import { boundary, simulation } from 'potemkin/sdk';
    import { PotemkinConfigure } from 'potemkin/sdk';
    class Scenario {
      @PotemkinConfigure('${name}')
      static create() {
        return simulation().boundary(boundary('${name}', '/widgets').build()).build();
      }
    }
  `;
}

function openapiDocument(routePath: string, operationId: string): string {
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

function configYaml(version: number): string {
  return `
    version: ${version}
    specmatic: ./specmatic.yaml
    modules: [global.yaml]
    typescript:
      scan:
        - include: [model.ts]
      watchIntervalMs: 20
  `;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for configured runtime reload");
}
