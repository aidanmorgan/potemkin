/**
 * Standalone simulation linter — `potemkin lint`.
 *
 * Runs the full strict lint against an example / config directory WITHOUT
 * starting the engine or the JVM. Exits non-zero with a located report on any
 * error; prints warnings and exits zero otherwise. CI / pre-commit friendly.
 *
 *   tsx src/cli/lint.ts examples/stripe
 *   tsx src/cli/lint.ts path/to/potemkin.yaml
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadOpenApi } from '../contract/loader.js';
import { loadPotemkinConfig } from '../dsl/configLoader.js';
import { runLint, formatFindings } from '../lint/runner.js';
import { ALL_CHECKS } from '../lint/checks/index.js';
import { BootError } from '../errors.js';

function resolvePaths(arg: string): { potemkinConfigPath: string; contractPath: string } {
  const abs = path.resolve(arg);
  const stat = fs.existsSync(abs) ? fs.statSync(abs) : undefined;
  const dir = stat?.isDirectory() ? abs : path.dirname(abs);
  const potemkinConfigPath = stat?.isFile() ? abs : path.join(dir, 'potemkin.yaml');
  if (!fs.existsSync(potemkinConfigPath)) {
    throw new Error(`No potemkin.yaml found at ${potemkinConfigPath}`);
  }
  const openapiDir = path.join(dir, 'openapi');
  if (!fs.existsSync(openapiDir)) {
    throw new Error(`No openapi/ directory found next to ${potemkinConfigPath}`);
  }
  const specs = fs.readdirSync(openapiDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.json'));
  if (specs.length === 0) throw new Error(`No OpenAPI contract in ${openapiDir}`);
  return { potemkinConfigPath, contractPath: path.join(openapiDir, specs[0]) };
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    process.stderr.write('usage: potemkin lint <example-dir | potemkin.yaml>\n');
    process.exit(2);
  }

  let potemkinConfigPath: string;
  let contractPath: string;
  try {
    ({ potemkinConfigPath, contractPath } = resolvePaths(arg));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(2);
    return;
  }

  const openapi = await loadOpenApi(contractPath);

  // Composition + the existing strict boot validation (unknown keys, dangling
  // emit/reducer/reaction references, operationIds, schema_ref) run here and
  // throw a BootError — surface it as a lint failure.
  let loaded;
  try {
    loaded = await loadPotemkinConfig(potemkinConfigPath, { openapi });
  } catch (e) {
    if (e instanceof BootError) {
      process.stderr.write(`✗ ${e.code}: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }

  const { errors, warnings } = runLint(
    { dsl: loaded.compiledDsl, openapi, boundarySourcePaths: loaded.boundarySourcePaths },
    ALL_CHECKS,
  );

  if (warnings.length > 0) {
    process.stderr.write(formatFindings(`${warnings.length} warning(s):`, warnings) + '\n');
  }
  if (errors.length > 0) {
    process.stderr.write(formatFindings(`✗ Lint failed with ${errors.length} error(s):`, errors) + '\n');
    process.exit(1);
  }
  process.stdout.write(`✓ Lint passed (${loaded.compiledDsl.boundaries.length} boundaries, ${warnings.length} warning(s)).\n`);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
