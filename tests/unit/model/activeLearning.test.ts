import type { EquivalenceStep } from '../../equivalence/types.js';
import type { JsonObject } from '../../../src/contracts/value.js';
import {
  ActiveLearningError,
  diffLearnedHypothesis,
  learnBoundedHypothesis,
  type ActiveLearningRunner,
} from '../../equivalence/activeLearning.js';
import type { TransitionMachine } from '../../../src/model/transitionModel.js';

const step = (operation: string, status: number, body: JsonObject): EquivalenceStep => ({
  operation,
  request: { method: 'POST', path: `/${operation}` },
  model: { status, body },
  real: { status, body },
});

describe('bounded active-learning discovery', () => {
  it('requires the equality/freshness identifier domain', async () => {
    const runner: ActiveLearningRunner = { run: async () => ({ steps: [], inconclusive: false }) };

    await expect(
      learnBoundedHypothesis(
        runner,
        [{ operation: 'create', request: { method: 'POST', path: '/create' } }],
        { identifierDomain: 'arbitrary' },
      ),
    ).rejects.toMatchObject({ code: 'LEARNING_PRECONDITION_UNSATISFIED' });
  });

  it('learns a bounded observation hypothesis from the injected EQ2 runner', async () => {
    const runner: ActiveLearningRunner = {
      run: async (sequence) => ({
        inconclusive: false,
        steps: sequence.map((entry, index) =>
          step(
            entry.operation,
            200,
            index === 0 ? { id: 'pi_real_123', status: 'created' } : { status: 'confirmed' },
          ),
        ),
      }),
    };
    const alphabet = [
      { operation: 'create', request: { method: 'POST', path: '/create' } },
      { operation: 'confirm', request: { method: 'POST', path: '/confirm' } },
    ];

    const hypothesis = await learnBoundedHypothesis(runner, alphabet, {
      identifierDomain: 'equality-freshness',
      maxDepth: 2,
    });

    expect(hypothesis.queriedSequences).toBe(6);
    expect(hypothesis.states.map((state) => state.signature)).toEqual(
      expect.arrayContaining([
        '<initial>',
        JSON.stringify({ status: 200, body: { id: 'pi_<fresh>', status: 'created' } }),
      ]),
    );
    expect(hypothesis.transitions).toEqual(
      expect.arrayContaining([expect.objectContaining({ operation: 'create' })]),
    );
  });

  it('reports operations and transitions observed outside MODEL1', () => {
    const hypothesis = {
      initialState: 's0',
      states: [
        { id: 's0', signature: '<initial>' },
        { id: 's1', signature: 'done' },
      ],
      transitions: [{ from: 's0', operation: 'delete', to: 's1' }],
      queriedSequences: 1,
    };
    const model: TransitionMachine = {
      aggregate: 'PaymentIntent',
      controlField: 'status',
      states: ['requires_payment_method', 'succeeded'],
      transitions: [
        {
          from: '*',
          to: 'requires_payment_method',
          op: 'create',
          guardCel: null,
          nextStateKnown: true,
        },
      ],
      writeSets: {},
    };

    expect(diffLearnedHypothesis(hypothesis, model)).toEqual(
      expect.arrayContaining([
        { kind: 'UNMODELED_OPERATION', operation: 'delete' },
        { kind: 'UNOBSERVED_OPERATION', operation: 'create' },
        expect.objectContaining({ kind: 'UNMODELED_TRANSITION', operation: 'delete' }),
      ]),
    );
  });

  it('rejects an inconclusive teacher result', async () => {
    const runner: ActiveLearningRunner = {
      run: async () => ({ steps: [], inconclusive: true }),
    };

    await expect(
      learnBoundedHypothesis(
        runner,
        [{ operation: 'read', request: { method: 'GET', path: '/read' } }],
        { identifierDomain: 'equality-freshness' },
      ),
    ).rejects.toBeInstanceOf(ActiveLearningError);
  });
});
