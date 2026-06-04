/**
 * RED TEAM: per-aggregate lock map growth (invariant #4 — resource/DoS).
 *
 * executeUnitOfWork acquires a lock keyed on command.targetId from the
 * per-system aggregateLocks map. acquireLock self-cleans: on release it deletes
 * the key IFF it is still the tail of the chain. We hammer the map with many
 * distinct aggregate ids (both sequentially and concurrently) and assert the map
 * does NOT retain entries after all work drains — otherwise a long-running sim
 * leaks one Map entry per distinct aggregate id forever.
 */

import { bootSystem, type BootedSystem } from '../src/engine/boot.js';
import { executeUnitOfWork } from '../src/engine/uow.js';
import { loadOpenApi } from '../src/contract/loader.js';
import { compileDsl } from '../src/dsl/parser.js';
import { nextUuidv7 } from '../src/ids/uuidv7.js';
import type { Command } from '../src/types.js';

const OPENAPI = `
openapi: "3.0.3"
info: { title: Lock Leak Test, version: "1.0.0" }
paths:
  /widgets:
    post:
      operationId: createWidget
      requestBody:
        required: true
        content: { application/json: { schema: { $ref: "#/components/schemas/Widget" } } }
      responses:
        "201": { description: Created, content: { application/json: { schema: { $ref: "#/components/schemas/Widget" } } } }
components:
  schemas:
    Widget: { type: object, properties: { id: { type: string } }, additionalProperties: true }
`;

const DSL = `
boundary: Widget
contract_path: /widgets
identity: { creation: { generate: '$uuidv7()' } }
event_catalog:
  - type: WidgetCreated
    payload_template: { id: command.targetId }
behaviors:
  - name: createWidget
    match: { operationId: createWidget, condition: 'true' }
    emit: WidgetCreated
reducers:
  - on: WidgetCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
`;

async function build(): Promise<BootedSystem> {
  const openapi = await loadOpenApi(OPENAPI);
  const compiledDsl = await compileDsl([{ name: 'widget', yaml: DSL }]);
  return bootSystem({ openapi, compiledDsl });
}

function widget(id: string): Command {
  return {
    commandId: nextUuidv7(), boundary: 'Widget', intent: 'creation', targetId: id,
    payload: {}, queryParams: {}, httpMethod: 'POST', path: '/widgets', origin: 'inbound', depth: 0,
  };
}

describe('REDTEAM lock-map leak', () => {
  it('the aggregate lock map drains to empty after a large burst of distinct-aggregate UoWs', async () => {
    const sys = await build();
    const common = {
      dsl: sys.dsl, openapi: sys.openapi, graph: sys.graph, events: sys.events,
      cel: sys.cel, validator: sys.validator, schemaRegistry: sys.schemaRegistry,
      aggregateLocks: sys.aggregateLocks,
    };

    // 200 sequential distinct-aggregate UoWs.
    for (let i = 0; i < 200; i++) {
      await executeUnitOfWork({ command: widget(nextUuidv7()), ...common });
    }
    const afterSeq = sys.aggregateLocks.size;

    // 200 concurrent distinct-aggregate UoWs.
    await Promise.all(
      Array.from({ length: 200 }, () => executeUnitOfWork({ command: widget(nextUuidv7()), ...common })),
    );
    const afterConcurrent = sys.aggregateLocks.size;

    // eslint-disable-next-line no-console
    console.log('REDTEAM lock-leak:', { afterSeq, afterConcurrent });

    expect(afterSeq).toBe(0);
    expect(afterConcurrent).toBe(0);
  });
});
