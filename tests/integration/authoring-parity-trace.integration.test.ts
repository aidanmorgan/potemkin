import {
  boundaryName,
  behaviorName,
  contractPath,
  eventType,
  operationId,
  pathSegment,
} from '../../src/domain/references.js';
import { boundary, event, expression, simulation } from '../../src/authoring/builders.js';
import type { SimulationDefinition } from '../../src/authoring/types.js';
import { reducerRule } from '../../src/authoring/nativeReducer.js';
import type { EventContext, IdentityContext } from '../../src/model/runtime.js';
import { compareDefinitions } from '../equivalence/configurationParity.js';
import { compileYaml } from '../../src/parser/yamlParser.js';

const YAML = `
boundary: Shipment
contract_path: /shipments
fallback_override: false
identity:
  creation:
    generate: command.payload.id
event_catalog:
  - type: ShipmentCreated
    payload_template:
      id: command.payload.id
      tracking: command.payload.tracking
      status: "'QUEUED'"
behaviors:
  - name: create-shipment
    match:
      operationId: createShipment
      condition: "true"
    emit: ShipmentCreated
reducers:
  - on: ShipmentCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /tracking, value: "\${event.payload.tracking}" }
      - { op: replace, path: /status, value: "\${event.payload.status}" }
`;

function definition(operationName = 'createShipment'): SimulationDefinition {
  return simulation()
    .boundary(
      boundary(boundaryName('Shipment'), contractPath(pathSegment('shipments')))
        .fallbackOverride(false)
        .identity({
          generate: expression('identity', ({ payload }: IdentityContext) => String(payload.id)),
        })
        .eventCatalog(
          event(eventType('ShipmentCreated'), {
            id: expression('event', ({ payload }: EventContext) => payload.id),
            tracking: expression('event', ({ payload }: EventContext) => payload.tracking),
            status: 'QUEUED',
          }),
        )
        .behavior({
          name: behaviorName('create-shipment'),
          operationId: operationId(operationName),
          emit: eventType('ShipmentCreated'),
        })
        .reducer(
          reducerRule(eventType('ShipmentCreated'))
            .apply(({ state, event }) => ({
              ...state,
              id: event.payload.id,
              tracking: event.payload.tracking,
              status: event.payload.status,
            }))
            .build(),
        ),
    )
    .build();
}

describe('authoring parity integration boundary', () => {
  it('normalizes equivalent YAML and TypeScript declarations to one model', async () => {
    const yaml = await compileYaml([{ name: 'shipment.yaml', yaml: YAML }]);
    const typescript = definition();
    const comparison = compareDefinitions(yaml, typescript);
    expect(comparison.equal).toBe(true);
    expect(comparison.differences).toEqual([]);
    expect(typescript.boundaries).toHaveLength(1);
    expect(yaml.boundaries).toHaveLength(1);
  });

  it('reports semantic parity drift by canonical path rather than declaration format', async () => {
    const yaml = await compileYaml([{ name: 'shipment.yaml', yaml: YAML }]);
    const changed = compareDefinitions(yaml, definition('createDifferentShipment'));

    expect(changed.equal).toBe(false);
    expect(changed.differences).toEqual(
      expect.arrayContaining([expect.stringContaining('operationId')]),
    );
  });
});
