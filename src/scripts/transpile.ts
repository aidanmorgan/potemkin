import * as esbuild from 'esbuild';
import { BootError } from '../errors.js';

/**
 * REQ-68: Transpile TypeScript source to CommonJS JavaScript using esbuild.
 * This is transpile-only — no type checking is performed.
 *
 * @throws {BootError} BOOT_ERR_SCRIPT_SYNTAX on transpile failure.
 */
export function transpileScript(scriptName: string, boundary: string, code: string): string {
  try {
    const result = esbuild.transformSync(code, {
      loader: 'ts',
      format: 'cjs',
      target: 'es2022',
    });
    return result.code;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BootError(
      'BOOT_ERR_SCRIPT_SYNTAX',
      `Script "${scriptName}" in boundary "${boundary}" failed transpilation: ${message}`,
      { boundary, scriptName, message },
    );
  }
}
