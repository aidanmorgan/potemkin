import * as fs from "node:fs";
import * as path from "node:path";

import { glob } from "tinyglobby";

import type { ScanEntry } from "../config.js";
import { errorMessage, TypeScriptAuthoringError } from "../authoring/errors.js";
import { hasPotemkinConfigureDecorator } from "./typescriptFactorySyntax.js";

/** Filesystem/glob effects used by TypeScript discovery. */
export interface TypeScriptDiscoveryDependencies {
  readonly resolveGlob: (
    patterns: readonly string[],
    cwd: string,
    ignore: readonly string[] | undefined,
  ) => Promise<readonly string[]>;
  readonly readFile: (file: string, encoding: "utf8") => string;
}

/** Default production discovery ports; tests and hosts may inject all effects. */
export function createDefaultTypeScriptDiscoveryDependencies(): TypeScriptDiscoveryDependencies {
  return {
    resolveGlob: async (patterns, cwd, ignore) =>
      glob([...patterns], {
        cwd,
        absolute: true,
        onlyFiles: true,
        ignore: ignore === undefined ? undefined : [...ignore],
      }),
    readFile: (file, encoding) => fs.readFileSync(file, encoding),
  };
}

/** Resolve the configured TypeScript discovery graph without evaluating it. */
export async function resolveTypeScriptScanFiles(
  entries: readonly ScanEntry[],
  cwd: string,
  dependencies: TypeScriptDiscoveryDependencies = createDefaultTypeScriptDiscoveryDependencies(),
): Promise<readonly string[]> {
  const files: string[] = [];
  for (const entry of entries) {
    let matches: string[];
    try {
      matches = [...(await dependencies.resolveGlob(entry.include, cwd, entry.exclude))];
    } catch (error) {
      throw new TypeScriptAuthoringError(
        "TS_CONFIGURATION_INVALID",
        `Cannot resolve TypeScript discovery globs from ${cwd}: ${errorMessage(error)}`,
        {
          details: {
            cwd,
            include: [...entry.include],
            ...(entry.exclude === undefined ? {} : { exclude: [...entry.exclude] }),
          },
          source: cwd,
          cause: error,
        },
      );
    }
    files.push(...matches);
  }
  return [...new Set(files.map((file) => path.resolve(file)))].sort();
}

/** Read only enough source to decide whether the AST contains a factory. */
export function isDecoratedTypeScriptModule(
  file: string,
  dependencies: TypeScriptDiscoveryDependencies = createDefaultTypeScriptDiscoveryDependencies(),
): boolean {
  try {
    return hasPotemkinConfigureDecorator(dependencies.readFile(file, "utf8"), file);
  } catch (error) {
    throw new TypeScriptAuthoringError(
      "TS_SOURCE_READ",
      `Cannot inspect TypeScript authoring file ${file}: ${errorMessage(error)}`,
      { details: { path: file }, source: file, cause: error },
    );
  }
}
