import * as path from 'node:path';

import { loadOpenApi } from '../../../src/contract/loader';
import { mergeTransitionModels } from '../../../src/model/transitionModel';
import type { TransitionModel } from '../../../src/model/transitionModel';
import { loadPotemkinConfig } from '../../../src/parser/configLoader';
import { compileYaml } from '../../../src/parser/yamlParser.js';
import { buildTransitionModel } from '../../../src/parser/transitionModel';
import type { YamlLinkedProgram } from '../../../src/dsl/types';

async function loadExample(name: 'crm' | 'stripe') {
  const root = path.resolve(process.cwd(), 'examples', name);
  const contract = await loadOpenApi(
    path.join(root, 'openapi', name === 'crm' ? 'nuisance-bureau.yaml' : 'stripe-official.json'),
  );
  const loaded = await loadPotemkinConfig(path.join(root, 'potemkin.yml'), {
    openapi: contract,
  });
  const program = await compileYaml(
    loaded.yamlProgram.modules,
    loaded.yamlProgram.globalYaml,
    loaded.yamlProgram.componentModules,
    loaded.yamlProgram.useMappingModules,
  );
  return buildTransitionModel({ program, openapi: contract });
}

describe('source-independent transition model', () => {
  it('merges overlapping machines without duplicate transitions and with unioned write sets', () => {
    const first: TransitionModel = {
      schemaVersion: 1 as const,
      machines: [
        {
          aggregate: 'Order',
          controlField: 'state',
          states: ['OPEN'],
          transitions: [
            {
              from: 'OPEN' as const,
              to: 'CLOSED' as const,
              op: 'close',
              guardCel: null,
              nextStateKnown: true,
            },
          ],
          writeSets: {
            close: {
              fields: ['status'],
              replaceState: false,
              derivedClosure: ['total'],
              volatile: [],
            },
          },
          analysis: { strict: true, initialStates: ['OPEN'], operations: ['close'] },
        },
      ],
    };
    const second: TransitionModel = {
      schemaVersion: 1 as const,
      machines: [
        {
          aggregate: 'Order',
          controlField: 'status',
          states: ['CLOSED', 'OPEN'],
          transitions: [
            {
              from: 'OPEN' as const,
              to: 'CLOSED' as const,
              op: 'close',
              guardCel: null,
              nextStateKnown: true,
            },
            {
              from: 'CLOSED' as const,
              to: 'OPEN' as const,
              op: 'reopen',
              guardCel: 'true',
              nextStateKnown: true,
            },
          ],
          writeSets: {
            close: {
              fields: ['id', 'status'],
              replaceState: true,
              derivedClosure: ['total', 'summary'],
              volatile: ['updatedAt'],
            },
            reopen: {
              fields: [],
              replaceState: false,
              derivedClosure: [],
              volatile: [],
            },
          },
          analysis: {
            terminalStates: ['CLOSED'],
            operations: ['reopen'],
            suppressStates: ['ARCHIVED'],
          },
        },
        {
          aggregate: 'Account',
          controlField: 'state',
          states: ['ACTIVE'],
          transitions: [],
          writeSets: {},
        },
      ],
    };

    const merged = mergeTransitionModels(first, second);

    expect(merged.machines.map((machine) => machine.aggregate)).toEqual(['Account', 'Order']);
    expect(merged.machines[1]).toMatchObject({
      controlField: 'status',
      states: ['CLOSED', 'OPEN'],
      transitions: expect.arrayContaining([
        expect.objectContaining({ op: 'close' }),
        expect.objectContaining({ op: 'reopen' }),
      ]),
      writeSets: {
        close: {
          fields: ['id', 'status'],
          replaceState: true,
          derivedClosure: ['summary', 'total'],
          volatile: ['updatedAt'],
        },
      },
      analysis: {
        strict: true,
        initialStates: ['OPEN'],
        terminalStates: ['CLOSED'],
        operations: ['close', 'reopen'],
        suppressStates: ['ARCHIVED'],
      },
    });
  });

  it('merges empty analysis metadata without manufacturing empty fields', () => {
    const model = mergeTransitionModels(
      {
        schemaVersion: 1,
        machines: [
          { aggregate: 'A', controlField: 'state', states: [], transitions: [], writeSets: {} },
        ],
      },
      {
        schemaVersion: 1,
        machines: [
          {
            aggregate: 'A',
            controlField: 'state',
            states: [],
            transitions: [],
            writeSets: {},
            analysis: {},
          },
        ],
      },
    );

    expect(model.machines[0]?.analysis).toEqual({});
  });

  it('aggregates the CRM Lead boundaries into one connected machine', async () => {
    const model = await loadExample('crm');
    const lead = model.machines.filter((machine) => machine.aggregate === 'Lead');

    expect(lead).toHaveLength(1);
    expect(lead[0]).toMatchObject({
      controlField: 'status',
      states: expect.arrayContaining(['NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'DNC']),
    });
    expect(lead[0]!.transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ op: 'qualifyLead', to: 'QUALIFIED', nextStateKnown: true }),
        expect.objectContaining({ op: 'convertLead', to: 'CONVERTED', nextStateKnown: true }),
      ]),
    );
  });

  it('selects Agent.currentStatus from the OpenAPI enum and preserves unknown request-driven next state', async () => {
    const model = await loadExample('crm');
    const agent = model.machines.find((machine) => machine.aggregate === 'Agent');

    expect(agent).toMatchObject({
      controlField: 'currentStatus',
      states: ['AVAILABLE', 'BREAK', 'OFFLINE', 'ON_CALL'],
    });
    expect(agent?.transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op: 'updateAgentStatus',
          to: 'UNKNOWN',
          nextStateKnown: false,
        }),
      ]),
    );
  });

  it('resolves PaymentIntent event indirection into guarded confirm transitions', async () => {
    const model = await loadExample('stripe');
    const paymentIntent = model.machines.find((machine) => machine.aggregate === 'PaymentIntent');
    const confirm = paymentIntent?.transitions.filter(
      (transition) => transition.op === 'PostPaymentIntentsIntentConfirm',
    );

    expect(paymentIntent).toMatchObject({ controlField: 'status', states: expect.any(Array) });
    expect(paymentIntent?.states).toHaveLength(7);
    expect(confirm).toEqual([
      expect.objectContaining({
        to: 'requires_capture',
        guardCel: expect.stringContaining("state.capture_method == 'manual'"),
        nextStateKnown: true,
      }),
      expect.objectContaining({
        to: 'succeeded',
        guardCel: expect.stringContaining("!(state.capture_method == 'manual')"),
        nextStateKnown: true,
      }),
    ]);
    expect(paymentIntent?.writeSets.PostPaymentIntents).toMatchObject({
      replaceState: true,
      fields: expect.arrayContaining(['id', 'status', 'amount', 'currency']),
    });
    expect(paymentIntent?.writeSets.PostPaymentIntentsIntent).toEqual({
      fields: ['amount', 'description', 'metadata'],
      replaceState: false,
      derivedClosure: [],
      volatile: [],
    });
  });

  it('uses a deterministic single-state fallback when no enum or transition literal exists', () => {
    const program = {
      boundaries: [
        {
          boundary: 'Empty',
          contractPath: '/empty',
          behaviors: [],
          reducers: [],
          eventCatalog: [],
        },
      ],
      byContractPath: {},
      byBoundaryName: {},
    } as unknown as YamlLinkedProgram;
    const model = buildTransitionModel({
      program,
      openapi: {
        raw: { openapi: '3.0.3', paths: {} },
        paths: {},
      },
    });

    expect(model).toEqual({
      schemaVersion: 1,
      machines: [
        {
          aggregate: 'Empty',
          controlField: 'state',
          states: ['UNKNOWN'],
          transitions: [],
          writeSets: {},
        },
      ],
    });
  });

  it('terminates when component schemas contain a cyclic reference chain', async () => {
    const program = await compileYaml([
      {
        name: 'node.yaml',
        yaml: `
boundary: Node
contract_path: /nodes
behaviors: []
reducers: []
event_catalog: []
`,
      },
    ]);

    const model = buildTransitionModel({
      program,
      openapi: {
        raw: {
          components: {
            schemas: {
              Node: { $ref: '#/components/schemas/Other' },
              Other: { $ref: '#/components/schemas/Node' },
            },
          },
        },
        paths: {},
      },
    });

    expect(model.machines[0]).toMatchObject({
      aggregate: 'Node',
      controlField: 'state',
      states: ['UNKNOWN'],
    });
  });

  it('expands computed-field dependencies into a non-replace write-set closure', () => {
    const program = {
      boundaries: [
        {
          boundary: 'Order',
          contractPath: '/orders',
          state: {
            computed: [{ name: 'total', formula: 'state.amount', dependsOn: ['amount'] }],
          },
          behaviors: [
            {
              name: 'updateOrder',
              match: { operationId: 'updateOrder', condition: 'true' },
              emit: 'OrderUpdated',
            },
          ],
          eventCatalog: [{ type: 'OrderUpdated', payloadTemplate: {} }],
          reducers: [
            {
              on: 'OrderUpdated',
              patches: [{ op: 'replace', path: '/amount', value: '${event.payload.amount}' }],
            },
          ],
        },
      ],
      byContractPath: {},
      byBoundaryName: {},
    } as unknown as YamlLinkedProgram;

    const model = buildTransitionModel({
      program,
      openapi: {
        raw: {
          components: {
            schemas: {
              Order: {
                type: 'object',
                properties: { status: { type: 'string', enum: ['OPEN', 'CLOSED'] } },
              },
            },
          },
        },
        paths: {},
      },
    });

    expect(model.machines[0]!.writeSets.updateOrder.derivedClosure).toEqual(['total']);
  });
});
