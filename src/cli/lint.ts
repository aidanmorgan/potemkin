import * as fs from "node:fs";
import * as path from "node:path";

import { loadConfiguredOpenApi } from "../parser/configuredOpenApi.js";
import { compileConfiguredProgram, loadConfiguredRuntimeSources } from "../parser/configured.js";
import { bootRuntime } from "../runtime/system.js";
import { createDefaultRuntimeHost } from "../runtime/host.js";
import { BootError } from "../errors.js";

async function main(): Promise<void> {
  const argument = process.argv[2] === "--" ? process.argv[3] : process.argv[2];
  const configPath = resolveConfigPath(argument);
  try {
    const openapi = await loadConfiguredOpenApi(configPath);
    const sources = await loadConfiguredRuntimeSources(configPath, openapi);
    const system = await bootRuntime({
      host: createDefaultRuntimeHost(),
      openapi: sources.openapi,
      configuration: sources.loaded.configuration,
      sourceByBoundary: sources.loaded.boundarySourcePaths,
      programFactory: (context) => compileConfiguredProgram(sources, context),
    });
    await system.dispose();
    process.stdout.write(
      `✓ Lint passed (${sources.loaded.configuration.modules.length} configured module pattern(s)).\n`,
    );
  } catch (error) {
    if (error instanceof BootError) {
      process.stderr.write(`✗ ${error.code}: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

function resolveConfigPath(value: string | undefined): string {
  if (value === undefined) {
    throw new Error("usage: pnpm run lint:sim -- <potemkin.yml | directory>");
  }
  const absolute = path.resolve(value);
  if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) return absolute;
  if (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()) {
    const configPath = path.join(absolute, "potemkin.yml");
    if (fs.existsSync(configPath)) return configPath;
  }
  throw new Error(`No potemkin.yml found at ${absolute}`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
