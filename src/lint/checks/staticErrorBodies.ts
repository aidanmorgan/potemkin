import { BootError } from '../../errors.js';
import { lintStaticErrorBodies } from '../staticErrorBodies.js';
import type { LintCheck } from '../types.js';

/** Validate error bodies that are present in the canonical model at boot. */
export const staticErrorBodiesCheck: LintCheck = (context) => {
  try {
    lintStaticErrorBodies(context.program, context.openapi, {
      sourceByBoundary: context.sourceByBoundary,
    });
    return [];
  } catch (error) {
    const details = error instanceof BootError ? error.details : undefined;
    const location = staticErrorLocation(details);
    return [
      {
        severity: 'error' as const,
        code: error instanceof BootError ? error.code : 'LINT_STATIC_ERROR_BODY',
        message: error instanceof Error ? error.message : String(error),
        location,
        ...(details === undefined ? {} : { details }),
      },
    ];
  }
};

function staticErrorLocation(details: unknown): {
  readonly file?: string;
  readonly boundary?: string;
  readonly pointer?: string;
} {
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return {};
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) values[key] = value;
  const source = typeof values['source'] === 'string' ? values['source'] : undefined;
  const boundary = typeof values['boundary'] === 'string' ? values['boundary'] : undefined;
  const operationId = typeof values['operationId'] === 'string' ? values['operationId'] : undefined;
  return {
    ...(source === undefined ? {} : { file: source }),
    ...(boundary === undefined ? {} : { boundary }),
    ...(operationId === undefined ? {} : { pointer: `operationId:${operationId}` }),
  };
}
