import { promises as fs, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { scanTypeScriptFactories } from "../../../src/parser/typescriptFactoryScanner";
import { createDefaultTypeScriptModuleLoaderDependencies } from "../../../src/parser/typescriptModuleLoader";
import type { TypeScriptDiscoveryDependencies } from "../../../src/parser/typescriptDiscovery";
import { loadTypeScriptConfiguration } from "../../../src/parser/typescriptLoader";
import { PotemkinConfigure } from "../../../src/authoring/factory";
import { factoryName } from "../../../src/authoring/references";
import { TypeScriptAuthoringError } from "../../../src/authoring/errors";

const openapi = { raw: {}, paths: {} } as never;
const configuration = {
  version: 1,
  specmatic: "specmatic.yaml",
  modules: ["yaml/**/*.yaml"],
} as never;

describe("TypeScript static engine factories", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "potemkin-ts-factory-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("discovers a decorated static method and loads its selected dependency", async () => {
    await fs.writeFile(
      path.join(root, "shared.ts"),
      `export function boundaryName(): string { return "Widget"; }`,
    );
    await fs.writeFile(
      path.join(root, "scenario.ts"),
      `
        import { boundary, simulation } from "potemkin/sdk";
        import {
          PotemkinConfigure,
          type FactoryContext,
        } from "potemkin/sdk";
        import { boundaryName } from "./shared";

        class Scenario {
          @PotemkinConfigure("widgets")
          static create(context: FactoryContext) {
            if (!context.sourceFiles.some((file) => file.endsWith("shared.ts"))) {
              throw new Error("shared dependency was not selected");
            }
            return simulation().boundary(boundary(boundaryName(), "/widgets").build()).build();
          }
        }
      `,
    );

    const result = await loadTypeScriptConfiguration({ scan: [{ include: ["*.ts"] }] }, root, {
      openapi,
      configuration,
      sourceFiles: [],
    });

    expect(result.files).toEqual([path.join(root, "scenario.ts"), path.join(root, "shared.ts")]);
    expect(result.definition?.boundaries.map((item) => item.boundary)).toEqual(["Widget"]);
  });

  it("returns factory registrations from the canonical TypeScript scanner", async () => {
    await fs.writeFile(
      path.join(root, "scenario.ts"),
      `
        import { PotemkinConfigure } from "potemkin/sdk";
        class Scenario {
          @PotemkinConfigure("scenario")
          static create() { return { boundaries: [] }; }
        }
      `,
    );

    const result = await scanTypeScriptFactories({ scan: [{ include: ["*.ts"] }] }, root);

    expect(result.factories.map((entry) => entry.name)).toEqual(["scenario"]);
  });

  it("retains a factory that contributes only global policies or composition uses", async () => {
    await fs.writeFile(
      path.join(root, "global.ts"),
      `
        import { PotemkinConfigure, simulation } from "potemkin/sdk";
        class GlobalConfiguration {
          @PotemkinConfigure("global")
          static create() {
            return simulation()
              .global({ idempotency: { enabled: true, ttlSeconds: 30 } })
              .build();
          }
        }
      `,
    );

    const result = await loadTypeScriptConfiguration({ scan: [{ include: ["*.ts"] }] }, root, {
      openapi,
      configuration,
      sourceFiles: [],
    });

    expect(result.definition).toMatchObject({
      boundaries: [],
      policies: { idempotency: { enabled: true, ttlSeconds: 30 } },
    });
  });

  it("uses injected discovery and module-loader ports at the composition boundary", async () => {
    const scenario = path.join(root, "scenario.ts");
    await fs.writeFile(
      scenario,
      `
        import { PotemkinConfigure } from "potemkin/sdk";
        class Scenario {
          @PotemkinConfigure("injected")
          static create() { return { boundaries: [] }; }
        }
      `,
    );
    const discovered: string[] = [];
    const loaded: string[] = [];
    const discovery: TypeScriptDiscoveryDependencies = {
      resolveGlob: async () => [scenario],
      readFile: (file, encoding) => {
        discovered.push(`${file}:${encoding}`);
        return readFileSync(file, encoding);
      },
    };
    const defaults = createDefaultTypeScriptModuleLoaderDependencies();

    const result = await scanTypeScriptFactories(
      { scan: [{ include: ["ignored-by-injected-port/**/*.ts"] }] },
      root,
      {
        discovery,
        loader: {
          ...defaults,
          readFile: (file, encoding) => {
            loaded.push(`${file}:${encoding}`);
            return defaults.readFile(file, encoding);
          },
        },
      },
    );

    expect(result.factories.map((entry) => entry.name)).toEqual(["injected"]);
    expect(discovered).toEqual([`${scenario}:utf8`]);
    expect(loaded).toEqual([`${scenario}:utf8`]);
  });

  it("loads an imported dependency even when discovery excludes that file", async () => {
    await fs.mkdir(path.join(root, "shared"));
    await fs.writeFile(
      path.join(root, "shared", "names.ts"),
      `export const boundaryName = "ImportedBoundary";`,
    );
    await fs.writeFile(
      path.join(root, "scenario.ts"),
      `
        import { boundary, simulation } from "potemkin/sdk";
        import { PotemkinConfigure } from "potemkin/sdk";
        import { boundaryName } from "./shared/names";
        class Scenario {
          @PotemkinConfigure("scenario")
          static create() {
            return simulation().boundary(boundary(boundaryName, "/widgets").build()).build();
          }
        }
      `,
    );

    const result = await scanTypeScriptFactories(
      {
        scan: [{ include: ["**/*.ts"], exclude: ["shared/**/*.ts"] }],
      },
      root,
    );

    expect(result.files).toEqual([path.join(root, "scenario.ts")]);
    expect(result.loadedFiles).toEqual([
      path.join(root, "scenario.ts"),
      path.join(root, "shared", "names.ts"),
    ]);
    expect(result.factories.map((entry) => entry.name)).toEqual(["scenario"]);
  });

  it("rejects instance methods so only static configuration factories are registered", () => {
    class Scenario {
      create(): never {
        throw new Error("not called");
      }
    }

    expect(() =>
      PotemkinConfigure(factoryName("invalid"))(
        Scenario.prototype,
        "create",
        Object.getOwnPropertyDescriptor(Scenario.prototype, "create")!,
      ),
    ).toThrow(/static method/);
  });

  it("isolates factory discovery across concurrent scans", async () => {
    const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), "potemkin-ts-factory-other-"));
    const source = `
      import { PotemkinConfigure } from "potemkin/sdk";
      class Scenario {
        @PotemkinConfigure("scenario")
        static create() { return { boundaries: [] }; }
      }
    `;
    try {
      await Promise.all([
        fs.writeFile(path.join(root, "scenario.ts"), source),
        fs.writeFile(path.join(otherRoot, "scenario.ts"), source),
      ]);
      const [left, right] = await Promise.all([
        scanTypeScriptFactories({ scan: [{ include: ["*.ts"] }] }, root),
        scanTypeScriptFactories({ scan: [{ include: ["*.ts"] }] }, otherRoot),
      ]);
      expect(left.factories.map((entry) => entry.name)).toEqual(["scenario"]);
      expect(right.factories.map((entry) => entry.name)).toEqual(["scenario"]);
    } finally {
      await fs.rm(otherRoot, { recursive: true, force: true });
    }
  });

  it("reports duplicate factory names through the typed diagnostic contract", async () => {
    const source = (className: string) => `
      import { PotemkinConfigure } from "potemkin/sdk";
      class ${className} {
        @PotemkinConfigure("duplicate")
        static create() { return { boundaries: [] }; }
      }
    `;
    await fs.writeFile(path.join(root, "first.ts"), source("First"));
    await fs.writeFile(path.join(root, "second.ts"), source("Second"));

    const failure = scanTypeScriptFactories({ scan: [{ include: ["*.ts"] }] }, root);
    await expect(failure).rejects.toMatchObject({
      code: "TS_FACTORY_CONFLICT",
      location: { source: "class:Second.create" },
    });
    await expect(failure).rejects.toBeInstanceOf(TypeScriptAuthoringError);
  });

  it("wraps factory execution failures with a stable typed diagnostic", async () => {
    await fs.writeFile(
      path.join(root, "scenario.ts"),
      `
        import { PotemkinConfigure } from "potemkin/sdk";
        class Scenario {
          @PotemkinConfigure("broken")
          static create() { throw new Error("factory exploded"); }
        }
      `,
    );

    const failure = loadTypeScriptConfiguration({ scan: [{ include: ["*.ts"] }] }, root, {
      openapi,
      configuration,
      sourceFiles: [],
    });
    await expect(failure).rejects.toMatchObject({
      code: "TS_EXECUTION",
      details: { name: "broken" },
      location: { source: "class:Scenario.create" },
    });
  });

  it("preserves unknown nested factory failures behind the typed boundary", async () => {
    await fs.writeFile(
      path.join(root, "unknown-failure.ts"),
      `
        import { PotemkinConfigure } from "potemkin/sdk";
        class Scenario {
          @PotemkinConfigure("unknown-failure")
          static create() { throw { nested: { reason: "not an Error instance" } }; }
        }
      `,
    );

    const failure = loadTypeScriptConfiguration({ scan: [{ include: ["*.ts"] }] }, root, {
      openapi,
      configuration,
      sourceFiles: [],
    });
    await expect(failure).rejects.toMatchObject({
      code: "TS_EXECUTION",
      details: { name: "unknown-failure" },
      location: { source: "class:Scenario.create" },
      cause: { nested: { reason: "not an Error instance" } },
    });
  });

  it("reports forbidden imports through the typed loader contract", async () => {
    await fs.writeFile(
      path.join(root, "scenario.ts"),
      `
        import { PotemkinConfigure } from "potemkin/sdk";
        import { readFileSync } from "node:fs";
        class Scenario {
          @PotemkinConfigure("forbidden")
          static create() { return { boundaries: [{ boundary: readFileSync, contractPath: "/x" }] }; }
        }
      `,
    );

    const failure = scanTypeScriptFactories({ scan: [{ include: ["*.ts"] }] }, root);
    await expect(failure).rejects.toMatchObject({
      code: "TS_IMPORT_FORBIDDEN",
      location: { source: path.join(root, "scenario.ts") },
    });
  });
});
