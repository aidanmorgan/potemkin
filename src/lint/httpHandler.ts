/**
 * GET /_engine/lint — publishes the engine's lint result so the plugin can fold
 * it into a single combined [engine]/[plugin] report.
 *
 * The boot already ABORTS on any lint error, so a running engine has passed; the
 * checks are fast, so the endpoint simply re-runs them against the booted model
 * (no boot-time state to thread). Errors are reported too for completeness.
 */
import type { Request, Response } from 'express';
import type { BootedSystem } from '../engine/boot.js';
import { runLint } from './runner.js';
import { ALL_CHECKS } from './checks/index.js';

export function createLintHandler(sys: BootedSystem) {
  return function lintHandler(_req: Request, res: Response): void {
    const { errors, warnings } = runLint({ dsl: sys.dsl, openapi: sys.openapi }, ALL_CHECKS);
    res.status(200).json({
      engine: 'potemkin-stateful',
      passed: errors.length === 0,
      errors,
      warnings,
    });
  };
}
