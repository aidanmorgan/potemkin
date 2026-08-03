import type { ScanEntry } from "../config.js";
import { createTypeScriptSdk, sdk, type TypeScriptSdk } from "../sdk/index.js";
import { FactoryCollector } from "../authoring/factory.js";
import type { RegisteredFactory } from "../authoring/factory.js";
import { TypeScriptModuleLoader } from "./typescriptModuleLoader.js";
import type { TypeScriptModuleLoaderDependencies } from "./typescriptModuleLoader.js";
import {
  createDefaultTypeScriptDiscoveryDependencies,
  isDecoratedTypeScriptModule,
  resolveTypeScriptScanFiles,
} from "./typescriptDiscovery.js";
import type { TypeScriptDiscoveryDependencies } from "./typescriptDiscovery.js";

export interface FactoryScanConfig {
  readonly scan: readonly ScanEntry[];
}

export interface FactoryScanResult {
  readonly files: readonly string[];
  /** Evaluated factory modules and their imported dependencies. */
  readonly loadedFiles: readonly string[];
  readonly factories: readonly RegisteredFactory[];
}

export interface FactoryScannerOptions {
  readonly sdk?: TypeScriptSdk;
  readonly discovery?: TypeScriptDiscoveryDependencies;
  readonly loader?: TypeScriptModuleLoaderDependencies;
}

/** Discover only @PotemkinConfigure static factories from selected modules. */
export async function scanTypeScriptFactories(
  config: FactoryScanConfig,
  cwd: string,
  options: FactoryScannerOptions = {},
): Promise<FactoryScanResult> {
  const collector = new FactoryCollector();
  const configuredSdk = createTypeScriptSdk(collector, options.sdk ?? sdk);
  const discovery = options.discovery ?? createDefaultTypeScriptDiscoveryDependencies();
  const files = await resolveTypeScriptScanFiles(config.scan, cwd, discovery);
  const loader = new TypeScriptModuleLoader({
    cwd,
    scan: config.scan,
    sdk: configuredSdk,
    dependencies: options.loader,
  });
  for (const file of files) {
    if (isDecoratedTypeScriptModule(file, discovery)) loader.load(file);
  }
  return { files, loadedFiles: loader.loadedFiles(), factories: collector.snapshot() };
}
