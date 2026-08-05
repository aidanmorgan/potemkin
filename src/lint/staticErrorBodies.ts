import type { OpenApiDoc } from '../contract/loader.js';
import { buildContractErrorBody, validateContractErrorBody } from '../contract/errorBody.js';
import { resolveResponseSchema } from '../contract/responseSchema.js';
import { BootError } from '../errors.js';
import type { RuntimeBoundary, RuntimeFault, RuntimeProgram } from '../model/runtime.js';

export interface StaticErrorLintOptions {
  readonly sourceByBoundary?: Readonly<Record<string, string>>;
}

interface OperationLocation {
  readonly method: string;
  readonly path: string;
  readonly operationId?: string;
}

/**
 * Validate error bodies that exist before the runtime starts.
 *
 * This lint consumes only the canonical runtime model and the contract
 * primitives. It deliberately does not import the engine, HTTP gateway, or
 * dynamic fault store. Runtime fault headers and admin-registered faults are
 * therefore outside this check and remain runtime/conformance concerns.
 */
export function lintStaticErrorBodies(
  program: Pick<RuntimeProgram, 'boundaries' | 'policies'>,
  openapi: OpenApiDoc,
  options: StaticErrorLintOptions = {},
): void {
  const operations = listOperations(openapi);

  for (const boundary of program.boundaries) {
    lintBoundaryGuards(boundary, operations, openapi, options);
    lintFaults(
      boundary.faults ?? [],
      boundary.boundary,
      operationsForBoundary(boundary, operations),
      openapi,
      options,
    );
  }

  lintFaults(program.policies.faults ?? [], '__global__', operations, openapi, options);
}

function lintBoundaryGuards(
  boundary: RuntimeBoundary,
  operations: readonly OperationLocation[],
  openapi: OpenApiDoc,
  options: StaticErrorLintOptions,
): void {
  for (const behavior of boundary.behaviors) {
    const operation = operations.find(
      (candidate) => candidate.operationId === behavior.operationId,
    );
    if (operation === undefined) continue;
    for (const guard of behavior.requires ?? []) {
      const status = 422;
      const body = buildContractErrorBody(
        openapi,
        operation.method,
        operation.path,
        status,
        { code: guard.errorCode, message: guard.errorMessage },
        { codeMap: openapi.errorCodeMap },
      );
      if (body === undefined) continue;
      assertValid(
        body,
        openapi,
        operation,
        status,
        `guard "${guard.name}" on behavior "${behavior.name}"`,
        boundary.boundary,
        options,
      );
    }
  }
}

function lintFaults(
  faults: readonly RuntimeFault[],
  boundaryName: string,
  operations: readonly OperationLocation[],
  openapi: OpenApiDoc,
  options: StaticErrorLintOptions,
): void {
  for (const fault of faults) {
    if (fault.response.status < 400) continue;
    for (const operation of operations) {
      const schema = resolveResponseSchema(
        openapi,
        operation.method,
        operation.path,
        fault.response.status,
      );
      if (schema === undefined) continue;
      const body = fault.response.body ?? null;
      assertValid(
        body,
        openapi,
        operation,
        fault.response.status,
        `fault "${fault.name}"`,
        boundaryName,
        options,
      );
    }
  }
}

function assertValid(
  body: Parameters<typeof validateContractErrorBody>[4],
  openapi: OpenApiDoc,
  operation: OperationLocation,
  status: number,
  declaration: string,
  boundary: string,
  options: StaticErrorLintOptions,
): void {
  const validation = validateContractErrorBody(
    openapi,
    operation.method,
    operation.path,
    status,
    body,
  );
  if (validation.valid) return;

  const source = options.sourceByBoundary?.[boundary];
  const location = source === undefined ? boundary : `${source} (${boundary})`;
  throw new BootError(
    'BOOT_ERR_DSL_SCHEMA_VIOLATION',
    `${location}: ${declaration} produces a body that does not conform to ${operation.method.toUpperCase()} ${operation.path} ${status}`,
    {
      boundary,
      declaration,
      ...(source === undefined ? {} : { source }),
      method: operation.method.toUpperCase(),
      path: operation.path,
      status,
      ...(operation.operationId === undefined ? {} : { operationId: operation.operationId }),
      errors: (validation.errors ?? []).map((error) =>
        error instanceof Error ? error.message : String(error),
      ),
    },
  );
}

function listOperations(openapi: OpenApiDoc): readonly OperationLocation[] {
  return Object.entries(openapi.paths).flatMap(([path, item]) =>
    Object.entries(item).flatMap(([method, operation]) =>
      operation === undefined
        ? []
        : [
            {
              method,
              path,
              ...(operation.operationId === undefined
                ? {}
                : { operationId: operation.operationId }),
            },
          ],
    ),
  );
}

function operationsForBoundary(
  boundary: RuntimeBoundary,
  operations: readonly OperationLocation[],
): readonly OperationLocation[] {
  const matches = operations.filter((operation) => operation.path === boundary.contractPath);
  return matches.length === 0 ? operations : matches;
}
