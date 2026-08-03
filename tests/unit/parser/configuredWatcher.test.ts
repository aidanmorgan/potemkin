import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfiguredYamlSources } from "../../../src/parser/configuredYaml.js";
import { loadConfiguredTypeScriptSources } from "../../../src/parser/configuredTypeScript.js";
import {
  DEFAULT_CONFIG_WATCH_INTERVAL_MS,
  startConfiguredRuntimeWatcher,
  type ConfiguredRuntimeWatcherScheduler,
} from "../../../src/parser/configuredWatcher.js";
import type { RuntimeSystem } from "../../../src/runtime/system.js";
import type { RuntimeModel } from "../../../src/model/index.js";

const OPENAPI = `
openapi: 3.0.3
info: { title: watcher, version: '1.0.0' }
paths:
  /orders:
    get:
      operationId: listOrders
      responses: { '200': { description: ok } }
`;

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for configured watcher reload");
}

describe("configured runtime watcher", () => {
  it("polls every configured interval, ignores excluded files, and reloads YAML/TS/config changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "potemkin-watcher-matrix-"));
    const moduleDir = path.join(root, "modules");
    await fs.mkdir(moduleDir);
    const configPath = path.join(root, "potemkin.yml");
    await fs.writeFile(path.join(root, "openapi.yaml"), OPENAPI);
    await fs.writeFile(path.join(moduleDir, "global.yaml"), "idempotency: {}\n");
    await fs.writeFile(
      path.join(moduleDir, "model.ts"),
      `
import { PotemkinConfigure, simulation } from "potemkin/sdk";
import { marker } from "./excluded";
class Model {
  @PotemkinConfigure("model")
  static create() {
    if (marker !== "excluded") throw new Error("dependency was not loaded");
    return simulation().build();
  }
}
`,
    );
    await fs.writeFile(path.join(moduleDir, "excluded.ts"), `export const marker = "excluded";\n`);
    await fs.writeFile(path.join(moduleDir, "unrelated.ts"), "// undiscovered source\n");
    await fs.writeFile(
      configPath,
      `
version: 1
specmatic: ./specmatic.yaml
openapi: [openapi.yaml]
modules: [modules/*.yaml]
typescript:
  scan:
    - include: [modules/*.ts]
      exclude: [modules/excluded.ts, modules/unrelated.ts]
  watchIntervalMs: 25
`,
    );

    try {
      const yaml = await loadConfiguredYamlSources(configPath, { raw: {}, paths: {} } as never);
      const typescript = await loadConfiguredTypeScriptSources(yaml.loaded, yaml.openapi);
      const initialSources = { ...yaml, ...typescript };
      const scheduled = new Map<number, () => void>();
      let nextTimer = 0;
      const intervals: number[] = [];
      const scheduler: ConfiguredRuntimeWatcherScheduler = {
        setTimeout: (callback, milliseconds) => {
          intervals.push(milliseconds);
          const id = nextTimer++;
          scheduled.set(id, () => {
            scheduled.delete(id);
            callback();
          });
          return id;
        },
        clearTimeout: (handle) => {
          scheduled.delete(handle as number);
        },
        sleep: async () => {},
      };
      let reloads = 0;
      let models = 0;
      let compilationCount = 0;
      const system = {
        engine: { program: { dependencies: {} } },
        configuration: initialSources.loaded.configuration,
        reload: async () => {
          reloads += 1;
        },
      } as unknown as RuntimeSystem;
      const watcher = await startConfiguredRuntimeWatcher({
        configPath,
        openapi: yaml.openapi,
        system,
        initialSources,
        compile: async () => {
          compilationCount += 1;
          return {} as RuntimeModel;
        },
        model: async () => {
          models += 1;
          return undefined;
        },
        scheduler,
      });
      expect(scheduled.size).toBe(1);
      expect(intervals[0]).toBe(25);
      expect(DEFAULT_CONFIG_WATCH_INTERVAL_MS).toBe(10_000);

      const poll = async (expectedReloads = 1): Promise<void> => {
        const callback = [...scheduled.values()][0];
        expect(callback).toBeDefined();
        callback?.();
        await waitFor(() => reloads >= expectedReloads);
      };
      const initialPoll = [...scheduled.values()][0];
      initialPoll?.();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(reloads).toBe(0);

      await fs.writeFile(path.join(moduleDir, "unrelated.ts"), "// ignored source changed\n");
      const unrelatedPoll = [...scheduled.values()][0];
      unrelatedPoll?.();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(reloads).toBe(0);

      await fs.writeFile(
        path.join(moduleDir, "excluded.ts"),
        `export const marker = "excluded";\n// imported dependency changed\n`,
      );
      const dependencyPoll = [...scheduled.values()][0];
      dependencyPoll?.();
      await waitFor(() => reloads >= 1);

      await fs.writeFile(
        path.join(moduleDir, "model.ts"),
        "// selected TypeScript source changed\nchanged\n",
      );
      await poll(2);
      expect(reloads).toBe(2);
      expect(models).toBe(2);
      expect(compilationCount).toBe(2);

      await fs.writeFile(
        configPath,
        (await fs.readFile(configPath, "utf8")).replace("version: 1", "version: 2"),
      );
      await poll(3);
      expect(reloads).toBe(3);
      expect(compilationCount).toBe(3);
      await watcher.stop();
      expect(scheduled.size).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("coalesces concurrent reload requests and releases the timer after stop", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "potemkin-watcher-coalesce-"));
    try {
      const modules = path.join(root, "modules");
      await fs.mkdir(modules);
      const configPath = path.join(root, "potemkin.yml");
      await fs.writeFile(path.join(modules, "global.yaml"), "idempotency: {}\n");
      await fs.writeFile(
        configPath,
        "version: 1\nspecmatic: ./specmatic.yaml\nmodules: [modules/*.yaml]\n",
      );
      const loaded = {
        potemkinConfigPath: configPath,
        specmaticConfigPath: path.join(root, "specmatic.yaml"),
        configuration: {} as never,
        yamlProgram: { modules: [] },
        boundaryModulePaths: [],
        boundarySourcePaths: {},
        globalModulePaths: [],
        componentModulePaths: [],
        useMappingModulePaths: [],
        pluginConfig: undefined,
        typescript: undefined,
        watchGlobs: [path.join(root, "modules/*.yaml")],
        watchIgnores: [],
      };
      const scheduled = new Map<number, () => void>();
      let timerId = 0;
      const scheduler: ConfiguredRuntimeWatcherScheduler = {
        setTimeout: (callback) => {
          const id = timerId++;
          scheduled.set(id, callback);
          return id;
        },
        clearTimeout: (handle) => {
          scheduled.delete(handle as number);
        },
        sleep: async () => {},
      };
      let resolveCompilation!: (model: RuntimeModel) => void;
      const compilation = new Promise<RuntimeModel>((resolve) => {
        resolveCompilation = resolve;
      });
      const system = {
        engine: { program: { dependencies: {} } },
        configuration: undefined,
        reload: async () => {},
      } as unknown as RuntimeSystem;
      const watcher = await startConfiguredRuntimeWatcher({
        configPath,
        openapi: { raw: {}, paths: {} } as never,
        system,
        initialSources: {
          loaded,
          openapi: { raw: {}, paths: {} } as never,
          files: undefined,
          typescriptDependencyFiles: undefined,
          authoring: undefined,
        },
        compile: async () => compilation,
        scheduler,
      });
      const first = watcher.reload();
      const second = watcher.reload();
      expect(first).toBe(second);
      resolveCompilation({} as RuntimeModel);
      await first;
      await watcher.stop();
      expect(scheduled.size).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
