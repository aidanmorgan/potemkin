import * as path from 'node:path';

import { loadOpenApi } from '../../../src/contract/loader.js';
import type { TransitionMachine } from '../../../src/model/transitionModel.js';
import { loadPotemkinConfig } from '../../../src/parser/configLoader.js';
import { buildConfiguredTransitionModel } from '../../../src/parser/transitionModel.js';
import {
  checkFiniteStateRefinement,
  RefinementAnalysisError,
} from '../../equivalence/refinement.js';

function machine(
  aggregate: string,
  states: readonly string[],
  transitions: TransitionMachine['transitions'],
  initialStates: readonly string[] = [states[0]!],
): TransitionMachine {
  return {
    aggregate,
    controlField: 'state',
    states,
    transitions,
    writeSets: {},
    analysis: { initialStates },
  };
}

describe('finite-state refinement analysis', () => {
  it('accepts an implementation with extra unreachable internal states', () => {
    const specification = machine(
      'Order',
      ['OPEN', 'CLOSED'],
      [{ from: 'OPEN', to: 'CLOSED', op: 'close', guardCel: null, nextStateKnown: true }],
    );
    const implementation = machine(
      'Order',
      ['OPEN', 'CLOSED', 'INTERNAL'],
      [
        { from: 'OPEN', to: 'CLOSED', op: 'close', guardCel: null, nextStateKnown: true },
        { from: 'INTERNAL', to: 'INTERNAL', op: 'debug', guardCel: null, nextStateKnown: true },
      ],
    );

    const result = checkFiniteStateRefinement(specification, implementation);

    expect(result.refines).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.relation).toEqual(
      expect.arrayContaining([
        { implementationState: 'OPEN', specificationState: 'OPEN' },
        { implementationState: 'CLOSED', specificationState: 'CLOSED' },
      ]),
    );
  });

  it('reports an implementation transition with no specification match', () => {
    const specification = machine(
      'Order',
      ['OPEN', 'CLOSED'],
      [{ from: 'OPEN', to: 'CLOSED', op: 'close', guardCel: null, nextStateKnown: true }],
    );
    const implementation = machine(
      'Order',
      ['OPEN', 'CLOSED'],
      [
        { from: 'OPEN', to: 'CLOSED', op: 'close', guardCel: null, nextStateKnown: true },
        { from: 'CLOSED', to: 'CLOSED', op: 'reopen', guardCel: null, nextStateKnown: true },
      ],
    );

    const result = checkFiniteStateRefinement(specification, implementation);

    expect(result.refines).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          implementationState: 'CLOSED',
          operation: 'reopen',
          reason: 'NO_MATCHING_OPERATION',
        }),
      ]),
    );
  });

  it('rejects an UNKNOWN transition instead of issuing a verdict', () => {
    const unknown = machine(
      'Agent',
      ['AVAILABLE', 'UNKNOWN'],
      [
        {
          from: 'AVAILABLE',
          to: 'UNKNOWN',
          op: 'updateAgentStatus',
          guardCel: null,
          nextStateKnown: false,
        },
      ],
    );

    expect(() => checkFiniteStateRefinement(unknown, unknown)).toThrow(RefinementAnalysisError);
    try {
      checkFiniteStateRefinement(unknown, unknown);
    } catch (error) {
      expect(error).toMatchObject({
        code: 'REFINEMENT_UNKNOWN_TRANSITION',
        details: { aggregate: 'Agent', side: 'specification' },
      });
    }
  });

  it('rejects unguarded nondeterminism', () => {
    const nondeterministic = machine(
      'Order',
      ['OPEN', 'CLOSED', 'CANCELED'],
      [
        { from: 'OPEN', to: 'CLOSED', op: 'finish', guardCel: null, nextStateKnown: true },
        { from: 'OPEN', to: 'CANCELED', op: 'finish', guardCel: null, nextStateKnown: true },
      ],
    );

    expect(() => checkFiniteStateRefinement(nondeterministic, nondeterministic)).toThrow(
      expect.objectContaining({ code: 'REFINEMENT_NONDETERMINISTIC' }),
    );
  });

  it('accepts guard-lifted deterministic branches when disjointness is obvious', () => {
    const specification = machine(
      'PaymentIntent',
      ['REQUIRES', 'CAPTURE', 'SUCCEEDED'],
      [
        {
          from: 'REQUIRES',
          to: 'CAPTURE',
          op: 'confirm',
          guardCel: "state.capture_method == 'manual'",
          nextStateKnown: true,
        },
        {
          from: 'REQUIRES',
          to: 'SUCCEEDED',
          op: 'confirm',
          guardCel: "!(state.capture_method == 'manual')",
          nextStateKnown: true,
        },
      ],
    );

    const result = checkFiniteStateRefinement(specification, specification);

    expect(result.refines).toBe(true);
  });

  it('rejects the real CRM Agent status machine because it contains UNKNOWN', async () => {
    const root = path.resolve(process.cwd(), 'examples/crm');
    const openapi = await loadOpenApi(path.join(root, 'openapi/nuisance-bureau.yaml'));
    const loaded = await loadPotemkinConfig(path.join(root, 'potemkin.yml'), { openapi });
    const model = await buildConfiguredTransitionModel(loaded.yamlProgram, openapi);
    const agent = model.machines.find((candidate) => candidate.aggregate === 'Agent');

    expect(agent).toBeDefined();
    expect(() => checkFiniteStateRefinement(agent!, agent!)).toThrow(
      expect.objectContaining({ code: 'REFINEMENT_UNKNOWN_TRANSITION' }),
    );
  });
});
