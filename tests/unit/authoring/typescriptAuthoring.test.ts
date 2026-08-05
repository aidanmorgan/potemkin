import {
  all,
  any,
  boundary,
  behavior,
  concatReadonly,
  event,
  expression,
  mapReadonly,
  not,
  pipe,
  simulation,
} from '../../../src/authoring/builders.js';
import { compileProgram } from '../../../src/authoring/compiler.js';
import { reducerRule } from '../../../src/authoring/nativeReducer.js';
import {
  boundaryName,
  behaviorName,
  contractPath,
  eventType,
  operationId,
  pathSegment,
} from '../../../src/domain/references.js';
import { bootRuntime } from '../../../src/runtime/system.js';
import { createDefaultRuntimeHost } from '../../../src/runtime/host.js';
import { loadOpenApi } from '../../../src/contract/loader.js';
import { compileYaml } from '../../../src/parser/yamlParser.js';
import { createRuntimeDataGenerator } from '../../../src/model/data.js';
import { compareDefinitions } from '../../equivalence/configurationParity.js';
import type { EventContext } from '../../../src/model/runtime.js';

const OPENAPI = `
openapi: "3.0.3"
info: { title: TypeScript authoring unit test, version: "1.0.0" }
paths:
  /things:
    post:
      operationId: createThing
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/Thing" }
      responses:
        "201":
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Thing" }
components:
  schemas:
    Thing:
      type: object
      required: [id, name]
      properties:
        id: { type: string }
        name: { type: string }
`;

function thingDefinition() {
  return simulation()
    .boundary(
      boundary(boundaryName('Thing'), contractPath(pathSegment('things')))
        .fallbackOverride(false)
        .identity({ generate: () => 'thing-1' })
        .eventCatalog(
          event(eventType('ThingCreated'), {
            id: expression('event', ({ command }: EventContext) => command.targetId ?? 'thing-1'),
            name: expression('event', ({ payload }: EventContext) => payload.name),
          }),
        )
        .behavior(
          behavior({
            name: behaviorName('createThing'),
            operationId: operationId('createThing'),
            emit: eventType('ThingCreated'),
          }),
        )
        .reducer(
          reducerRule(eventType('ThingCreated'))
            .apply(({ state, event: emitted }) => ({
              ...state,
              id: emitted.payload.id,
              name: emitted.payload.name,
            }))
            .build(),
        )
        .build(),
    )
    .global({})
    .build();
}

const dependencies = {
  contract: { operationIdFor: () => 'createThing' },
  clock: {
    nowMs: () => 1_735_689_600_000,
    offsetMs: () => 0,
    advance: () => 0,
    reset: () => undefined,
  },
  helpers: {
    now: () => '2026-01-01T00:00:00.000Z',
    uuid: () => '00000000-0000-7000-8000-000000000001',
    random: () => 0,
    data: createRuntimeDataGenerator(() => 0),
    clone: <T>(value: T) => structuredClone(value),
  },
};

describe('TypeScript authoring API', () => {
  it('composes pure helpers without mutating inputs', () => {
    const positive = (value: Readonly<{ n: number }>) => value.n > 0;
    expect(
      all(
        positive,
        not((value) => value.n === 2),
      )({ n: 1 }),
    ).toBe(true);
    expect(any((value) => value.n === 2, positive)({ n: 2 })).toBe(true);
    expect(
      pipe(
        2,
        (value) => value + 1,
        (value) => value * 3,
      ),
    ).toBe(9);
    expect(mapReadonly([1, 2], (value) => value * 2)).toEqual([2, 4]);
    expect(concatReadonly([1], [2, 3])).toEqual([1, 2, 3]);
  });

  it('builds the canonical model without a YAML round trip', () => {
    const definition = thingDefinition();
    expect(Object.isFrozen(definition)).toBe(true);
    expect(definition.boundaries).toHaveLength(1);

    const compiled = compileProgram(definition, { dependencies });
    expect(compiled.byBoundaryName.get('Thing')).toBe(compiled.boundaries[0]);
    expect(compiled.byContractPath.get('/things')).toBe(compiled.boundaries[0]);
    expect(compiled.boundaries[0]?.behaviors[0]?.operationId).toBe('createThing');
  });

  it('compares equivalent YAML and TypeScript models semantically', async () => {
    const yaml = await compileYaml([
      {
        name: 'thing.yaml',
        yaml: `
boundary: Thing
contract_path: /things
identity:
  creation:
    generate: "'thing-1'"
event_catalog:
  - type: ThingCreated
    payload_template:
      id: command.targetId
      name: command.payload.name
behaviors:
  - name: createThing
    match: { operationId: createThing, condition: "true" }
    emit: ThingCreated
reducers:
  - on: ThingCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /name, value: "\${event.payload.name}" }
`,
      },
    ]);
    const comparison = compareDefinitions(yaml, thingDefinition());
    expect(comparison.differences).toEqual([]);
  });

  it('boots directly from the TypeScript definition', async () => {
    const openapi = await loadOpenApi(OPENAPI);
    const system = await bootRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      programFactory: ({ dependencies }) =>
        compileProgram(thingDefinition(), { dependencies, openapi }),
    });
    expect(system.program.boundaries.map((item) => item.boundary)).toEqual(['Thing']);
    expect(system.program.byContractPath.get('/things')?.boundary).toBe('Thing');
    await system.dispose();
  });

  it('rejects duplicate TypeScript boundary names and paths at compile time', () => {
    const first = thingDefinition().boundaries[0]!;
    expect(() => compileProgram({ boundaries: [first, first] }, { dependencies })).toThrow(
      /Duplicate runtime boundary/,
    );
    expect(() =>
      compileProgram(
        { boundaries: [{ ...first, boundary: boundaryName('Other') }, first] },
        { dependencies },
      ),
    ).toThrow(/Duplicate runtime contract path/);
  });
});
