import * as path from 'node:path';
import { loadOpenApi } from '../../../src/contract/loader.js';
import { loadPotemkinConfig } from '../../../src/parser/configLoader.js';
import { buildConfiguredTransitionModel } from '../../../src/parser/transitionModel.js';
import type { TransitionMachine, TransitionModel } from '../../../src/model/transitionModel.js';
import {
  deriveModelMetamorphicRelations,
  runModelMetamorphicRelation,
  type ModelMetamorphicTarget,
  type ModelMetamorphicRequestFactory,
} from '../../equivalence/modelMetamorphic.js';

async function loadModel(name: 'crm' | 'stripe'): Promise<TransitionModel> {
  const root = path.resolve(process.cwd(), 'examples', name);
  const openapi = await loadOpenApi(
    path.join(root, 'openapi', name === 'crm' ? 'nuisance-bureau.yaml' : 'stripe-official.json'),
  );
  const loaded = await loadPotemkinConfig(path.join(root, 'potemkin.yml'), { openapi });
  return buildConfiguredTransitionModel(loaded.yamlProgram, openapi);
}

const genericRequests: ModelMetamorphicRequestFactory = {
  requestFor: (machine, operation) => ({
    method: 'POST',
    path: `/model/${machine.aggregate}/${operation}`,
    operation,
  }),
};

describe('MODEL1-derived metamorphic relations', () => {
  it('derives idempotency and disjoint commutativity for CRM', async () => {
    const relations = deriveModelMetamorphicRelations(await loadModel('crm'), genericRequests);

    expect(relations.some((relation) => relation.kind === 'idempotency')).toBe(true);
    expect(relations.some((relation) => relation.kind === 'commutativity')).toBe(true);
    expect(
      relations.some(
        (relation) =>
          relation.kind === 'commutativity' && relation.aggregates[0] !== relation.aggregates[1],
      ),
    ).toBe(true);
  });

  it('emits the concrete Stripe cross-aggregate Customer/Product pair', async () => {
    const model = await loadModel('stripe');
    const requests: ModelMetamorphicRequestFactory = {
      requestFor: (machine, operation) => {
        if (machine.aggregate === 'Customer' && operation === 'PostCustomers')
          return { method: 'POST', path: '/v1/customers', operation };
        if (machine.aggregate === 'Product' && operation === 'PostProducts')
          return { method: 'POST', path: '/v1/products', operation };
        return undefined;
      },
    };
    const relations = deriveModelMetamorphicRelations(model, requests);

    expect(
      relations.find(
        (relation) =>
          relation.kind === 'commutativity' &&
          relation.aggregates.includes('Customer') &&
          relation.aggregates.includes('Product'),
      ),
    ).toBeDefined();
  });

  it('does not emit a same-aggregate pair whose write sets overlap', () => {
    const model: TransitionModel = {
      schemaVersion: 1,
      machines: [
        machine('Order', {
          create: { fields: ['id', 'status'], replaceState: false },
          approve: { fields: ['status'], replaceState: false },
        }),
      ],
    };
    const relations = deriveModelMetamorphicRelations(model, genericRequests);
    expect(relations.filter((relation) => relation.kind === 'commutativity')).toHaveLength(0);
  });

  it('fails when a reducer violates a derived idempotency relation', async () => {
    const model: TransitionModel = {
      schemaVersion: 1,
      machines: [
        machine('Order', {
          settle: { fields: ['status'], replaceState: false },
        }),
      ],
    };
    const relation = deriveModelMetamorphicRelations(model, genericRequests).find(
      (candidate) => candidate.kind === 'idempotency',
    );
    expect(relation).toBeDefined();

    let applications = 0;
    const brokenReducer: ModelMetamorphicTarget = {
      async reset(): Promise<void> {
        applications = 0;
      },
      async execute(requests) {
        return requests.map(() => ({
          status: 200,
          body: { applications: ++applications },
        }));
      },
    };
    const result = await runModelMetamorphicRelation(relation!, brokenReducer);
    expect(result.divergences).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'BODY_MISMATCH' })]),
    );
  });
});

function machine(
  aggregate: string,
  writeSets: Readonly<Record<string, { fields: readonly string[]; replaceState: boolean }>>,
): TransitionMachine {
  return {
    aggregate,
    controlField: 'status',
    states: ['settled'],
    transitions: Object.keys(writeSets).map((operation) => ({
      from: '*',
      to: 'settled',
      op: operation,
      guardCel: null,
      nextStateKnown: true,
    })),
    writeSets: Object.fromEntries(
      Object.entries(writeSets).map(([operation, writeSet]) => [
        operation,
        {
          fields: writeSet.fields,
          replaceState: writeSet.replaceState,
          derivedClosure: [],
          volatile: [],
        },
      ]),
    ),
  };
}
