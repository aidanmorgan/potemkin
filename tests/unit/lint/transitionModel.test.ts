import { transitionModelCheck } from '../../../src/lint/checks/transitionModel';
import { ALL_CHECKS } from '../../../src/lint/checks';
import type { LintContext } from '../../../src/lint/types';
import type { TransitionModel } from '../../../src/model/transitionModel';
import { validateGlobalConfig } from '../../../src/dsl/schema';

function context(model: TransitionModel, states: readonly string[] = []): LintContext {
  return {
    program: { boundaries: [], policies: {} },
    transitionModel: model,
    openapi: {
      raw: {
        components: {
          schemas: {
            Order: {
              type: 'object',
              properties: {
                status: { type: 'string', enum: states },
              },
            },
          },
        },
      },
      paths: {},
    },
  };
}

function machine(overrides: Partial<TransitionModel['machines'][number]> = {}) {
  return {
    aggregate: 'Order',
    controlField: 'status',
    states: ['NEW', 'DONE'],
    transitions: [],
    writeSets: {},
    ...overrides,
  } as TransitionModel['machines'][number];
}

function model(overrides: Partial<TransitionModel['machines'][number]> = {}): TransitionModel {
  return { schemaVersion: 1, machines: [machine(overrides)] };
}

describe('transition model lint', () => {
  it('accepts the same coverage policy shape used by YAML configuration', () => {
    expect(
      validateGlobalConfig({
        coverage: {
          Order: {
            strict: true,
            initial_states: ['NEW'],
            terminal_states: ['DONE'],
            operations: ['complete'],
            suppress_states: ['PROCESSING'],
          },
        },
      }).coverage,
    ).toEqual({
      Order: {
        strict: true,
        initial_states: ['NEW'],
        terminal_states: ['DONE'],
        operations: ['complete'],
        suppress_states: ['PROCESSING'],
      },
    });
  });

  it('is registered with the boot lint checks', () => {
    expect(ALL_CHECKS).toContain(transitionModelCheck);
  });

  it('reports an unreachable state on the connected graph', () => {
    const findings = transitionModelCheck(
      context(
        model({
          states: ['NEW', 'DONE', 'ORPHAN'],
          transitions: [
            { from: 'NEW', to: 'DONE', op: 'complete', guardCel: null, nextStateKnown: true },
          ],
          analysis: { strict: true, initialStates: ['NEW'], terminalStates: ['DONE'] },
        }),
      ),
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'error', code: 'MODEL_UNREACHABLE_STATE' }),
      ]),
    );
  });

  it('reports a reachable non-terminal dead state', () => {
    const findings = transitionModelCheck(
      context(
        model({
          transitions: [
            { from: 'NEW', to: 'DONE', op: 'complete', guardCel: null, nextStateKnown: true },
          ],
          analysis: { strict: true, initialStates: ['NEW'] },
        }),
      ),
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'error', code: 'MODEL_DEAD_STATE' }),
      ]),
    );
  });

  it('reports a missing state/operation transition', () => {
    const findings = transitionModelCheck(
      context(
        model({
          transitions: [
            { from: 'NEW', to: 'DONE', op: 'complete', guardCel: null, nextStateKnown: true },
          ],
          writeSets: {
            complete: { fields: [], replaceState: false, derivedClosure: [], volatile: [] },
            reopen: { fields: [], replaceState: false, derivedClosure: [], volatile: [] },
          },
          analysis: { strict: true, initialStates: ['NEW'], terminalStates: ['DONE'] },
        }),
      ),
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'error', code: 'MODEL_TOTALITY_GAP' }),
      ]),
    );
  });

  it('warns for an uncovered OpenAPI state and accepts a declared suppression', () => {
    const findings = transitionModelCheck(
      context(
        model({
          states: ['NEW', 'PROCESSING', 'DONE'],
          transitions: [
            { from: 'NEW', to: 'DONE', op: 'complete', guardCel: null, nextStateKnown: true },
          ],
          analysis: { suppressStates: ['PROCESSING'] },
        }),
        ['NEW', 'PROCESSING', 'DONE'],
      ),
    );

    expect(findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'MODEL_CONTRACT_STATE_UNCOVERED',
          message: expect.stringContaining('PROCESSING'),
        }),
      ]),
    );
  });

  it('flags a suppression for a state absent from the OpenAPI enum', () => {
    const findings = transitionModelCheck(
      context(model({ analysis: { suppressStates: ['TYPO'] } }), ['NEW', 'DONE']),
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'error', code: 'MODEL_UNKNOWN_STATE_SUPPRESSION' }),
      ]),
    );
  });

  it('warns when a guard names a state no reducer can produce', () => {
    const findings = transitionModelCheck(
      context(
        model({
          transitions: [
            {
              from: 'NEW',
              to: 'DONE',
              op: 'complete',
              guardCel: "state.status == 'PROCESSING'",
              nextStateKnown: true,
            },
          ],
        }),
        ['NEW', 'PROCESSING', 'DONE'],
      ),
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'warning', code: 'MODEL_GUARD_STATE_UNPRODUCED' }),
      ]),
    );
  });
});
