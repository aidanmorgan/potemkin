/**
 * Unit tests for the Tier-6 observability controls consumed by executeUnitOfWork
 * (potemkin-1eg): X-Potemkin-Log-Level overrides the request logger level, and
 * X-Potemkin-Metric-Tag is attached to every recorded metric attribute set.
 *
 * Both tests assert at the sink: they FAIL if the wiring in uow.ts were removed.
 */

import pino from 'pino';
import { executeUnitOfWork } from '../../../src/engine/uow.js';
import { bootSystem, type BootedSystem } from '../../../src/engine/boot.js';
import { resetSystem } from '../../../src/engine/reset.js';
import { compileDsl } from '../../../src/dsl/parser.js';
import { loadOpenApi } from '../../../src/contract/loader.js';
import { createEngineMetrics } from '../../../src/observability/metrics.js';
import type { Attributes, Counter } from '@opentelemetry/api';
import { nextUuidv7 } from '../../../src/ids/uuidv7.js';
import type { Command } from '../../../src/types.js';
import type { ControlHeaders } from '../../../src/http/controlHeaders.js';

const OPENAPI_YAML = `
openapi: '3.0.3'
info:
  title: Things
  version: '1.0.0'
paths:
  /things:
    post:
      operationId: createThing
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Thing'
      responses:
        '201':
          description: Created
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Thing'
components:
  schemas:
    Thing:
      type: object
      additionalProperties: true
      properties:
        id:
          type: string
        name:
          type: string
`;

const THING_DSL = `
boundary: Thing
contract_path: /things
fallback_override: true
identity:
  creation:
    generate: $uuidv7()
behaviors: []
reducers: []
event_catalog: []
`;

async function bootThings(): Promise<BootedSystem> {
  const openapi = await loadOpenApi(OPENAPI_YAML);
  const compiledDsl = await compileDsl([{ name: 'thing', yaml: THING_DSL }]);
  return bootSystem({ openapi, compiledDsl });
}

function makeCreateCommand(): Command {
  return {
    commandId: nextUuidv7(),
    boundary: 'Thing',
    intent: 'creation',
    targetId: nextUuidv7(),
    payload: { name: 'widget' },
    queryParams: {},
    httpMethod: 'POST',
    path: '/things',
    origin: 'inbound',
    depth: 0,
    headers: {},
  };
}

function emptyControls(): ControlHeaders {
  return {
    transparency: {},
    sideEffects: {},
    identity: {},
    timeTravel: {},
    format: {},
    observability: {},
    validation: {},
  };
}

/** Build a pino logger whose records are captured into `records`. Root level=info. */
function capturingLogger(records: Array<{ level: number; msg?: string }>): pino.Logger {
  const stream = {
    write(line: string) {
      records.push(JSON.parse(line) as { level: number; msg?: string });
    },
  };
  return pino({ level: 'info' }, stream);
}

const DEBUG_LEVEL = 20;

describe('uow observability — X-Potemkin-Log-Level', () => {
  let sys: BootedSystem;

  beforeAll(async () => {
    sys = await bootThings();
  });

  beforeEach(() => resetSystem(sys));

  function runWith(logLevel: 'debug' | undefined, records: Array<{ level: number; msg?: string }>) {
    const controls = emptyControls();
    if (logLevel) {
      (controls as { observability: { logLevel?: string } }).observability = { logLevel };
    }
    return executeUnitOfWork({
      command: makeCreateCommand(),
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      schemaRegistry: sys.schemaRegistry,
      openapi: sys.openapi,
      logger: capturingLogger(records),
      controls,
    });
  }

  it('without the control, the info-level logger suppresses UoW debug records', async () => {
    const records: Array<{ level: number; msg?: string }> = [];
    await runWith(undefined, records);
    expect(records.some((r) => r.level === DEBUG_LEVEL)).toBe(false);
  });

  it('logLevel=debug raises the request logger level so debug records reach the sink', async () => {
    const records: Array<{ level: number; msg?: string }> = [];
    await runWith('debug', records);
    // The UoW emits a "UoW staged event" debug record per staged event.
    expect(records.some((r) => r.level === DEBUG_LEVEL)).toBe(true);
  });
});

describe('uow observability — X-Potemkin-Metric-Tag', () => {
  let sys: BootedSystem;

  beforeAll(async () => {
    sys = await bootThings();
  });

  beforeEach(() => resetSystem(sys));

  it('attaches the parsed metric tag to every recorded metric attribute set', async () => {
    const base = createEngineMetrics();
    const seen: Array<Record<string, unknown>> = [];
    const wrap = (c: Counter): Counter =>
      ({
        add: (v: number, a?: Attributes) => {
          seen.push((a ?? {}) as Record<string, unknown>);
          c.add(v, a);
        },
      }) as Counter;

    const metrics = {
      ...base,
      commandsTotal: wrap(base.commandsTotal),
      eventsAppendedTotal: wrap(base.eventsAppendedTotal),
    };

    const controls = emptyControls();
    (controls as { observability: { metricTag?: { key: string; value: string } } }).observability = {
      metricTag: { key: 'tenant', value: 'acme' },
    };

    await executeUnitOfWork({
      command: makeCreateCommand(),
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      schemaRegistry: sys.schemaRegistry,
      openapi: sys.openapi,
      metrics,
      controls,
    });

    // commandsTotal AND eventsAppendedTotal increments both carry the tag.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((a) => a['tenant'] === 'acme')).toBe(true);
  });
});
