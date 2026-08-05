import * as path from 'node:path';
import { loadOpenApi } from '../../../src/contract/loader.js';
import { loadPotemkinConfig } from '../../../src/parser/configLoader.js';
import { buildConfiguredTransitionModel } from '../../../src/parser/transitionModel.js';
import type { TransitionModel } from '../../../src/model/transitionModel.js';
import {
  coverageForSequences,
  generateTransitionModelSequences,
  generateTransitionModelWpSuite,
} from '../../equivalence/modelGenerator.js';

async function loadExampleModel(name: 'crm' | 'stripe'): Promise<TransitionModel> {
  const root = path.resolve(process.cwd(), 'examples', name);
  const contract = await loadOpenApi(
    path.join(root, 'openapi', name === 'crm' ? 'nuisance-bureau.yaml' : 'stripe-official.json'),
  );
  const loaded = await loadPotemkinConfig(path.join(root, 'potemkin.yml'), { openapi: contract });
  return buildConfiguredTransitionModel(loaded.yamlProgram, contract);
}

describe('MODEL1-driven equivalence generation', () => {
  it('generates CRM sequences with state and transition coverage and negatives', async () => {
    const model = await loadExampleModel('crm');
    const sequences = generateTransitionModelSequences(model, {
      maxDepth: 4,
      includeNegative: true,
    });
    const leadSequences = sequences.filter((sequence) => sequence.aggregate === 'Lead');
    const coverage = coverageForSequences(leadSequences);

    expect(leadSequences.length).toBeGreaterThan(0);
    expect(
      leadSequences.some(
        (sequence) =>
          sequence.steps[0]?.operation === 'createLead' &&
          sequence.steps[0]?.targetRef === 'lead-1',
      ),
    ).toBe(true);
    expect(coverage.states).toEqual(expect.arrayContaining(['NEW', 'CONTACTED', 'QUALIFIED']));
    expect(coverage.transitions).toEqual(
      expect.arrayContaining([
        expect.stringContaining('*:createLead->NEW'),
        expect.stringContaining('*:contactLead->CONTACTED'),
      ]),
    );
    expect(leadSequences.some((sequence) => sequence.steps.some((step) => step.negative))).toBe(
      true,
    );
    const qualified = leadSequences.find((sequence) => sequence.finalState === 'QUALIFIED');
    expect(qualified?.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: 'patchLead', input: { callId: 'generated-call-1' } }),
      ]),
    );
  });

  it('propagates the PaymentIntent manual capture guard back to creation input', async () => {
    const model = await loadExampleModel('stripe');
    const sequences = generateTransitionModelSequences(model, { maxDepth: 4 });
    const manualCapture = sequences.find((sequence) =>
      sequence.steps.some(
        (step) => step.to === 'requires_capture' && step.operation.includes('Confirm'),
      ),
    );

    expect(manualCapture).toBeDefined();
    expect(manualCapture?.steps[0]?.input).toMatchObject({ capture_method: 'manual' });
    expect(manualCapture?.steps.some((step) => step.targetRef !== undefined)).toBe(true);
  });

  it('covers every Stripe state machine with positive and negative model traces', async () => {
    const model = await loadExampleModel('stripe');
    const sequences = generateTransitionModelSequences(model, {
      maxDepth: 4,
      includeNegative: true,
    });

    for (const machine of model.machines.filter((candidate) => candidate.transitions.length > 0)) {
      const generated = sequences.filter((sequence) => sequence.aggregate === machine.aggregate);
      const coverage = coverageForSequences(generated);
      expect(generated.some((sequence) => sequence.steps.every((step) => !step.negative))).toBe(
        true,
      );
      expect(generated.some((sequence) => sequence.steps.some((step) => step.negative))).toBe(true);
      expect(coverage.transitions).toEqual(
        expect.arrayContaining(
          machine.transitions.map(
            (transition) => `${transition.from}:${transition.op}->${transition.to}`,
          ),
        ),
      );
    }
  });

  it('increases the bounded W/Wp suite with the configured implementation-state bound', () => {
    const model: TransitionModel = {
      schemaVersion: 1,
      machines: [
        {
          aggregate: 'Order',
          controlField: 'state',
          states: ['A', 'B'],
          transitions: [
            { from: '*', to: 'A', op: 'create', guardCel: null, nextStateKnown: true },
            { from: 'A', to: 'B', op: 'advance', guardCel: null, nextStateKnown: true },
            { from: 'B', to: 'A', op: 'reopen', guardCel: null, nextStateKnown: true },
          ],
          writeSets: {},
        },
      ],
    };
    const small = generateTransitionModelWpSuite(model, { m: 2, maxDepth: 5 });
    const larger = generateTransitionModelWpSuite(model, { m: 4, maxDepth: 5 });

    expect(larger.length).toBeGreaterThan(small.length);
    expect(larger.every((sequence) => sequence.steps.every((step) => !step.negative))).toBe(true);
  });
});
