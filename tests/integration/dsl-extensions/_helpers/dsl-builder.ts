/**
 * dsl-builder.ts — Helpers for DSL Tier-1 integration tests.
 *
 * Re-exports the CEL-layer helper for simple CEL fixture runs, and adds
 * a lower-level `bootAndRun` helper that accepts a fully-formed YAML string
 * for the boundary under test plus a minimal OpenAPI spec. All integration
 * tests in this directory use one of these two entry points.
 */

import * as yamlLib from 'js-yaml';
import { bootSystem } from '../../../../src/engine/boot.js';
import { executeUnitOfWork } from '../../../../src/engine/uow.js';
import { resetSystem } from '../../../../src/engine/reset.js';
import { loadOpenApi } from '../../../../src/contract/loader.js';
import { nextUuidv7 } from '../../../../src/ids/uuidv7.js';
import { BootError } from '../../../../src/errors.js';
import type { JsonObject } from '../../../../src/types.js';
import type { ExecutionResult, DomainEvent } from '../../../../src/types.js';

export type { JsonObject };

/** Minimal interface for engine errors that carry an HTTP status code. */
interface SimError extends Error {
  readonly status?: number;
  readonly code?: string;
}

// ---------------------------------------------------------------------------
// Re-export CEL fixture runner from parent helper
// ---------------------------------------------------------------------------
export { runCelFixture } from '../../cel-language/_helpers/dsl-builder.js';

// ---------------------------------------------------------------------------
// Low-level boot+run helper
// ---------------------------------------------------------------------------

export interface RunFixtureOpts {
  /** Full YAML for the boundary under test (boundary name, contract_path, etc.). */
  readonly boundaryYaml: string;
  /** Boundary name to dispatch the command to (must match boundary: in YAML). */
  readonly boundaryName: string;
  /** The contract_path declared in the boundary YAML, e.g. "/widgets/{id}". */
  readonly contractPath: string;
  /** OpenAPI components/schemas to include. Keyed by schema name. */
  readonly schemas?: Record<string, unknown>;
  /** Additional DSL modules that the boundary depends on (e.g. secondary dispatch targets). */
  readonly extraDslModules?: Array<{ name: string; yaml: string }>;
  /** Entity to pre-seed. Must include `id`. */
  readonly entity?: JsonObject;
  /** Payload for the command. */
  readonly commandPayload?: JsonObject;
  /** Whether to use 'mutation' or 'creation' intent. Default: 'mutation'. */
  readonly intent?: 'mutation' | 'creation';
  /** When true, errors thrown by executeUnitOfWork are caught and returned as { status, error }. */
  readonly catchErrors?: boolean;
}

export interface RunFixtureResult {
  result: ExecutionResult;
  events: readonly DomainEvent[];
  state: JsonObject | null;
  /** Present when the system threw a boot error. */
  bootError?: BootError;
  /** Present when executeUnitOfWork threw (and catchErrors is true). */
  thrownError?: SimError;
}

/**
 * Boot a system from inline YAML, dispatch one command, return { result, events, state }.
 *
 * When `entity` is provided and `intent` is 'mutation', the entity is injected into the
 * boundary's initialization block so it exists before the command is dispatched.
 */
export async function bootAndRun(opts: RunFixtureOpts): Promise<RunFixtureResult> {
  const {
    boundaryYaml,
    boundaryName,
    contractPath,
    schemas = {},
    extraDslModules = [],
    entity,
    commandPayload = {},
    intent = 'mutation',
    catchErrors = true,
  } = opts;

  const entityId = entity ? String(entity['id'] ?? nextUuidv7()) : nextUuidv7();

  // Inject initialization block into the boundary YAML when entity is provided for mutation
  // (so the entity exists before the command arrives).
  let patchedBoundaryYaml = boundaryYaml;
  if (entity && intent === 'mutation' && !boundaryYaml.includes('initialization:')) {
    const initYaml = buildInitYaml(entity);
    patchedBoundaryYaml = boundaryYaml.trimEnd() + `\ninitialization:\n${initYaml}\n`;
  }

  // Build a minimal OpenAPI with the boundary's contract path and schema.
  // Also include paths/schemas for any extra DSL modules (secondary boundaries).
  const schemasYaml = buildSchemasYaml(boundaryName, schemas);
  const pathsYaml = buildPathsYaml(contractPath, boundaryName);

  // Extract boundary/contract_path from extra modules to add to OpenAPI
  let extraPathsYaml = '';
  let extraSchemasYaml = '';
  for (const mod of extraDslModules) {
    const bMatch = /^boundary:\s*(\S+)/m.exec(mod.yaml);
    const pMatch = /^contract_path:\s*(\S+)/m.exec(mod.yaml);
    if (bMatch && pMatch) {
      const extBoundary = bMatch[1]!;
      const extPath = pMatch[1]!;
      extraPathsYaml += buildPathsYaml(extPath, extBoundary);
      extraSchemasYaml += `\n` + buildSchemasYaml(extBoundary, {});
    }
  }

  const OPENAPI_YAML = `
openapi: "3.0.3"
info:
  title: DSL Extension Fixture
  version: "1.0.0"
paths:
${pathsYaml}${extraPathsYaml}
components:
  schemas:
${schemasYaml}${extraSchemasYaml}
`;

  const openapi = await loadOpenApi(OPENAPI_YAML);

  const dslModules = [
    { name: 'main', yaml: patchedBoundaryYaml },
    ...extraDslModules,
  ];

  let sys: Awaited<ReturnType<typeof bootSystem>>;
  try {
    sys = await bootSystem({ openapi, dslModules });
  } catch (err) {
    if (err instanceof BootError) {
      return { result: { status: 500, body: { error: err.message }, events: [] }, events: [], state: null, bootError: err };
    }
    throw err;
  }

  try {
    const isPathParam = contractPath.includes('{');
    const resolvedPath = isPathParam ? contractPath.replace(/\{[^}]+\}/, entityId) : contractPath;
    // Always use POST — the OpenAPI fixture only declares POST operations.
    const httpMethod = 'POST';

    const cmd = {
      commandId: nextUuidv7(),
      boundary: boundaryName,
      intent: intent as 'mutation' | 'creation',
      targetId: intent === 'mutation' ? entityId : null,
      payload: commandPayload,
      queryParams: {},
      httpMethod,
      path: resolvedPath,
      origin: 'inbound' as const,
      depth: 0,
    };

    let result: ExecutionResult;
    let thrownError: SimError | undefined;
    try {
      result = await executeUnitOfWork({
        command: cmd,
        dsl: sys.dsl,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
        schemaRegistry: sys.schemaRegistry,
        logger: sys.logger,
        tracer: sys.tracer,
        metrics: sys.metrics,
        openapi,
      });
    } catch (err) {
      if (!catchErrors) throw err;
      const simErr = err as SimError;
      thrownError = simErr;
      const status = simErr.status ?? 500;
      result = { status, body: { error: simErr.message, code: simErr.code ?? null }, events: [] };
    }

    const state = sys.graph.get(entityId);
    return { result, events: result.events, state, thrownError };
  } finally {
    resetSystem(sys);
  }
}

/**
 * Attempt to boot a system and return the BootError if one occurs.
 * Throws if no BootError is thrown (the boot succeeded unexpectedly).
 */
export async function expectBootError(opts: {
  boundaryYaml: string;
  boundaryName: string;
  contractPath: string;
  schemas?: Record<string, unknown>;
  extraDslModules?: Array<{ name: string; yaml: string }>;
}): Promise<BootError> {
  const { boundaryYaml, boundaryName, contractPath, schemas = {}, extraDslModules = [] } = opts;

  const schemasYaml = buildSchemasYaml(boundaryName, schemas);
  const pathsYaml = buildPathsYaml(contractPath, boundaryName);

  const OPENAPI_YAML = `
openapi: "3.0.3"
info:
  title: DSL Extension Fixture
  version: "1.0.0"
paths:
${pathsYaml}
components:
  schemas:
${schemasYaml}
`;

  const openapi = await loadOpenApi(OPENAPI_YAML);
  const dslModules = [
    { name: 'main', yaml: boundaryYaml },
    ...extraDslModules,
  ];

  try {
    const sys = await bootSystem({ openapi, dslModules });
    resetSystem(sys);
    throw new Error('Expected a BootError but boot succeeded');
  } catch (err) {
    if (err instanceof BootError) return err;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Internal YAML builders
// ---------------------------------------------------------------------------

function buildInitYaml(entity: JsonObject): string {
  const lines: string[] = [];
  lines.push(`  - id: "${entity['id']}"`);
  for (const [k, v] of Object.entries(entity)) {
    if (k === 'id') continue;
    if (v === null) {
      lines.push(`    ${k}: null`);
    } else if (typeof v === 'string') {
      lines.push(`    ${k}: "${v}"`);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      lines.push(`    ${k}: ${v}`);
    } else if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(`    ${k}: []`);
      } else {
        lines.push(`    ${k}:`);
        for (const item of v) {
          if (typeof item === 'string') {
            lines.push(`      - "${item}"`);
          } else {
            lines.push(`      - ${JSON.stringify(item)}`);
          }
        }
      }
    } else if (typeof v === 'object') {
      lines.push(`    ${k}: ${JSON.stringify(v)}`);
    }
  }
  return lines.join('\n');
}

function buildSchemasYaml(boundaryName: string, extraSchemas: Record<string, unknown>): string {
  const lines: string[] = [];

  // If caller supplied a schema keyed by the boundary name, use it as-is.
  // Otherwise generate a permissive default.
  if (boundaryName in extraSchemas) {
    const schemaYaml = yamlLib.dump(extraSchemas[boundaryName], { indent: 2, lineWidth: -1 })
      .trimEnd()
      .split('\n')
      .map((l) => `      ${l}`)
      .join('\n');
    lines.push(`    ${boundaryName}:\n${schemaYaml}`);
  } else {
    lines.push(`    ${boundaryName}:`);
    lines.push(`      type: object`);
    lines.push(`      additionalProperties: true`);
    lines.push(`      properties:`);
    lines.push(`        id:`);
    lines.push(`          type: string`);
    lines.push(`      required:`);
    lines.push(`        - id`);
  }

  for (const [name, schema] of Object.entries(extraSchemas)) {
    if (name === boundaryName) continue; // already handled above
    // Use js-yaml dump to produce valid YAML, then indent each line by 6 spaces
    const schemaYaml = yamlLib.dump(schema, { indent: 2, lineWidth: -1 })
      .trimEnd()
      .split('\n')
      .map((l) => `      ${l}`)
      .join('\n');
    lines.push(`    ${name}:\n${schemaYaml}`);
  }

  return lines.join('\n');
}

function buildPathsYaml(contractPath: string, boundaryName: string): string {
  const hasParam = contractPath.includes('{');
  const paramPart = hasParam
    ? `
        - name: id
          in: path
          required: true
          schema:
            type: string`
    : '';

  return `
  ${contractPath}:
    post:
      operationId: run${boundaryName}
      parameters:${paramPart}
      requestBody:
        required: false
        content:
          application/json:
            schema:
              type: object
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/${boundaryName}"
        "201":
          description: Created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/${boundaryName}"
        "422":
          description: Unhandled
          content:
            application/json:
              schema:
                type: object
        "404":
          description: Not found
          content:
            application/json:
              schema:
                type: object
        "500":
          description: Internal error
          content:
            application/json:
              schema:
                type: object
`;
}
