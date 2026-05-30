/**
 * dsl-builder.ts — Reusable helper to build minimal inline DSL+OpenAPI fixtures
 * around a single CEL expression under test, then dispatch a command through
 * the real engine and return { result, events, state }.
 *
 * Usage:
 *   const { result, events, state } = await runCelFixture({
 *     expression: 'state.tags.contains("vip")',
 *     phase: 'condition',
 *     initialEntity: { id: 'test-id', tags: ['vip'], status: 'ACTIVE' },
 *     commandPayload: { amount: 100 },
 *   });
 *
 * Phases:
 *  - 'condition' — CEL is used as the behavior match condition; if truthy the
 *                  behavior fires and a TestEvent is emitted; if falsy a 422 is returned.
 *  - 'payload'   — CEL is used as a payload_template field value; the emitted event's
 *                  payload.computed field contains the evaluation result.
 *  - 'reducer'   — CEL is used in a reducer assign expression; the resulting state
 *                  field `computed` holds the value.
 */

import type { JsonObject } from '../../../../src/types.js';
import type { ExecutionResult } from '../../../../src/types.js';
import type { DomainEvent } from '../../../../src/types.js';
import { bootSystem } from '../../../../src/engine/boot.js';
import { executeUnitOfWork } from '../../../../src/engine/uow.js';
import { resetSystem } from '../../../../src/engine/reset.js';
import { loadOpenApi } from '../../../../src/contract/loader.js';
import { compileDsl } from '../../../../src/dsl/parser.js';
import { nextUuidv7 } from '../../../../src/ids/uuidv7.js';

/** Minimal interface for engine errors that carry an HTTP status code. */
interface SimError extends Error {
  readonly status?: number;
}

export type CelTestPhase = 'condition' | 'payload' | 'reducer';

export interface FixtureOptions {
  /** The CEL expression under test. */
  expression: string;
  /** Where the expression is wired. */
  phase: CelTestPhase;
  /** Seed state; must include an `id` field. */
  initialEntity: JsonObject;
  /** Payload for the inbound mutation command. */
  commandPayload?: JsonObject;
  /**
   * Optional: extra fields for the payload_template when phase === 'payload'.
   * Defaults to { id: "command.targetId" }.
   */
  extraPayloadTemplate?: Record<string, string>;
  /**
   * Optional: extra reducer assign fields.
   * Defaults to { id: "event.payload.id" }.
   */
  extraReducerAssign?: Record<string, string>;
}

export interface FixtureResult {
  result: ExecutionResult;
  events: readonly DomainEvent[];
  /** State of the entity after the command completes (null when not found). */
  state: JsonObject | null;
}

/**
 * Build an inline minimal DSL + OpenAPI, boot the system, dispatch a mutation
 * command against `initialEntity.id`, and return the full execution result.
 */
export async function runCelFixture(opts: FixtureOptions): Promise<FixtureResult> {
  const entityId = String(opts.initialEntity['id'] ?? nextUuidv7());

  // -------------------------------------------------------------------------
  // Build OpenAPI inline
  // -------------------------------------------------------------------------
  const OPENAPI_YAML = `
openapi: "3.0.3"
info:
  title: CEL Fixture API
  version: "1.0.0"
paths:
  /widgets:
    post:
      operationId: createWidget
      requestBody:
        required: false
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Widget"
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Widget"
        "400":
          description: Bad request
          content:
            application/json:
              schema:
                type: object
        "409":
          description: Conflict
          content:
            application/json:
              schema:
                type: object
  /widgets/{id}:
    post:
      operationId: mutateWidget
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      requestBody:
        required: false
        content:
          application/json:
            schema:
              type: object
      responses:
        "200":
          description: Updated
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Widget"
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
components:
  schemas:
    Widget:
      type: object
      additionalProperties: true
      properties:
        id:
          type: string
        computed: {}
      required:
        - id
    WidgetById:
      type: object
      additionalProperties: true
      properties:
        id:
          type: string
        computed: {}
      required:
        - id
`;

  // -------------------------------------------------------------------------
  // Build DSL inline based on phase
  // -------------------------------------------------------------------------
  const initEntry = JSON.stringify(opts.initialEntity);
  const initYaml = buildInitYaml(opts.initialEntity);
  const cmdPayload = opts.commandPayload ?? {};

  let behaviorDsl: string;
  let reducerDsl: string;

  switch (opts.phase) {
    case 'condition': {
      // Condition gates firing a TestEvent
      behaviorDsl = `
  - name: cel-test-behavior
    match:
      operationId: mutateWidget
      condition: "${escapeForYamlString(opts.expression)}"
    emit: TestEvent
`;
      reducerDsl = `
  - on: TestEvent
    patches:
      - { op: replace, path: /status, value: "\${'MATCHED'}" }
`;
      break;
    }
    case 'payload': {
      // Expression is the value of the `computed` field in the payload template
      const extraTemplate = opts.extraPayloadTemplate ?? {};
      const extraLines = Object.entries(extraTemplate)
        .map(([k, v]) => `      ${k}: "${escapeForYamlString(v)}"`)
        .join('\n');
      behaviorDsl = `
  - name: cel-test-behavior
    match:
      operationId: mutateWidget
      condition: "true"
    emit: TestEvent
`;
      const payloadTemplate = `
    payload_template:
      id: "command.targetId"
      computed: "${escapeForYamlString(opts.expression)}"
${extraLines}`;
      reducerDsl = `
  - on: TestEvent
    patches:
      - { op: replace, path: /computed, value: "\${event.payload.computed}" }
      - { op: replace, path: /id, value: "\${event.payload.id}" }
`;
      // Need to inject the payload template into the event catalog
      return runWithCustomEventCatalog({
        entityId,
        openApiYaml: OPENAPI_YAML,
        initYaml,
        behaviorDsl,
        reducerDsl,
        payloadTemplate,
        cmdPayload,
      });
    }
    case 'reducer': {
      // Expression is used in the reducer assign for field `computed`
      const extraAssign = opts.extraReducerAssign ?? {};
      const extraLines = Object.entries(extraAssign)
        .map(([k, v]) => `      - { op: replace, path: /${k.replace(/\./g, '/')}, value: "\${${escapeForYamlString(v)}}" }`)
        .join('\n');
      behaviorDsl = `
  - name: cel-test-behavior
    match:
      operationId: mutateWidget
      condition: "true"
    emit: TestEvent
`;
      reducerDsl = `
  - on: TestEvent
    patches:
      - { op: replace, path: /computed, value: "\${${escapeForYamlString(opts.expression)}}" }
${extraLines}
`;
      break;
    }
  }

  const widgetDsl = buildWidgetDsl({ initYaml, behaviorDsl, reducerDsl });
  const widgetByIdDsl = buildWidgetByIdDsl({ behaviorDsl, reducerDsl });

  const openapi = await loadOpenApi(OPENAPI_YAML);
  const dslModules = [
    { name: 'widget', yaml: widgetDsl },
    { name: 'widgetById', yaml: widgetByIdDsl },
  ];

  const sys = await bootSystem({ openapi, compiledDsl: await compileDsl(dslModules) });

  try {
    const cmd = {
      commandId: nextUuidv7(),
      boundary: 'WidgetById',
      intent: 'mutation' as const,
      targetId: entityId,
      payload: cmdPayload,
      queryParams: {},
      httpMethod: 'POST',
      path: `/widgets/${entityId}`,
      origin: 'inbound' as const,
      depth: 0,
    };

    let result: ExecutionResult;
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
      // Engine errors (UnhandledOperationError, etc.) carry an HTTP status.
      // Convert to a synthetic ExecutionResult so tests can assert on status.
      const simErr = err as SimError;
      const status = simErr.status ?? 500;
      result = { status, body: { error: simErr.message }, events: [] };
    }

    const state = sys.graph.get(entityId);
    return { result, events: result.events, state };
  } finally {
    resetSystem(sys);
  }
}

// ---------------------------------------------------------------------------
// Variant for payload-phase that needs a custom event catalog
// ---------------------------------------------------------------------------

async function runWithCustomEventCatalog(opts: {
  entityId: string;
  openApiYaml: string;
  initYaml: string;
  behaviorDsl: string;
  reducerDsl: string;
  payloadTemplate: string;
  cmdPayload: JsonObject;
}): Promise<FixtureResult> {
  const widgetDsl = `
boundary: Widget
contract_path: /widgets
fallback_override: true
identity:
  creation:
    generate: "$uuidv7()"
initialization:
${opts.initYaml}
event_catalog:
  - type: TestEvent
${opts.payloadTemplate}
behaviors:
${opts.behaviorDsl}
reducers:
${opts.reducerDsl}
`;

  const widgetByIdDsl = `
boundary: WidgetById
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: TestEvent
${opts.payloadTemplate}
behaviors:
${opts.behaviorDsl}
reducers:
${opts.reducerDsl}
`;

  const openapi = await loadOpenApi(opts.openApiYaml);
  const dslModules = [
    { name: 'widget', yaml: widgetDsl },
    { name: 'widgetById', yaml: widgetByIdDsl },
  ];

  const sys = await bootSystem({ openapi, compiledDsl: await compileDsl(dslModules) });

  try {
    const cmd = {
      commandId: nextUuidv7(),
      boundary: 'WidgetById',
      intent: 'mutation' as const,
      targetId: opts.entityId,
      payload: opts.cmdPayload,
      queryParams: {},
      httpMethod: 'POST',
      path: `/widgets/${opts.entityId}`,
      origin: 'inbound' as const,
      depth: 0,
    };

    let result: ExecutionResult;
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
      const simErr = err as SimError;
      const status = simErr.status ?? 500;
      result = { status, body: { error: simErr.message }, events: [] };
    }

    const state = sys.graph.get(opts.entityId);
    return { result, events: result.events, state };
  } finally {
    resetSystem(sys);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeForYamlString(expr: string): string {
  // Escape double quotes for embedding into YAML double-quoted strings
  return expr.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildInitYaml(entity: JsonObject): string {
  // Build YAML initialization block; each field on its own indented line
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
      // Serialize as JSON inline (YAML accepts JSON)
      lines.push(`    ${k}: ${JSON.stringify(v)}`);
    }
  }
  return lines.join('\n');
}

function buildWidgetDsl(opts: {
  initYaml: string;
  behaviorDsl: string;
  reducerDsl: string;
}): string {
  return `
boundary: Widget
contract_path: /widgets
fallback_override: true
identity:
  creation:
    generate: "$uuidv7()"
initialization:
${opts.initYaml}
event_catalog:
  - type: TestEvent
    payload_template:
      id: "command.targetId"
behaviors:
${opts.behaviorDsl}
reducers:
${opts.reducerDsl}
`;
}

function buildWidgetByIdDsl(opts: {
  behaviorDsl?: string;
  reducerDsl?: string;
} = {}): string {
  const behaviors = opts.behaviorDsl ?? `
  - name: cel-test-behavior
    match:
      operationId: mutateWidget
      condition: "true"
    emit: TestEvent
`;
  const reducers = opts.reducerDsl ?? `
  - on: TestEvent
    patches:
      - { op: replace, path: /status, value: "\${'MATCHED'}" }
`;
  return `
boundary: WidgetById
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: TestEvent
    payload_template:
      id: "command.targetId"
behaviors:
${behaviors}
reducers:
${reducers}
`;
}
