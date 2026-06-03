/**
 * Coverage backfill for engine/projection.ts
 *
 * Uncovered lines:
 *  - 49: non-Error thrown in projectEvent span catch (String(err) branch)
 *  - 151: validator.validateEntity branch (validator is supplied)
 */

import { projectEvent } from '../../../src/engine/projection';
import { createStateGraph } from '../../../src/stategraph/graph';
import { createCelEvaluator } from '../../../src/cel/evaluator';
import { InternalExecutionError } from '../../../src/errors';
import type { ContractValidator } from '../../../src/contract/validator';
import { makeBoundary, makeDomainEvent } from '../_helpers';

const cel = createCelEvaluator();

describe('projection.ts additional coverage', () => {
  describe('append patch applies appended value (positive)', () => {
    it('appends the resolved value to the target array', () => {
      const graph = createStateGraph();
      graph.set('agg-1', { items: ['a'] });
      const boundary = makeBoundary({
        reducers: [{ on: 'ItemAdded', patches: [{ op: 'append', path: '/items', value: '${"b"}' }] }],
      });
      const event = makeDomainEvent({ type: 'ItemAdded', payload: {} });
      projectEvent({ event, boundary, graph, cel });
      expect(graph.get('agg-1')?.items).toEqual(['a', 'b']);
    });
  });

  // ── Line 151: validator.validateEntity branch ────────────────────────────────

  describe('validator.validateEntity called when validator is supplied (line 151)', () => {
    it('calls validateEntity with the boundary and projected state', () => {
      const graph = createStateGraph();
      graph.set('agg-1', { status: 'pending' });

      const validateEntityMock = jest.fn();
      const mockValidator: Partial<ContractValidator> = {
        validateEntity: validateEntityMock,
      };

      const boundary = makeBoundary({
        reducers: [{ on: 'StatusChanged', patches: [{ op: 'replace', path: '/status', value: '${"active"}' }] }],
      });
      const event = makeDomainEvent({ type: 'StatusChanged', payload: {} });

      projectEvent({
        event,
        boundary,
        graph,
        cel,
        validator: mockValidator as ContractValidator,
      });

      expect(validateEntityMock).toHaveBeenCalledWith('TestBoundary', expect.objectContaining({ status: 'active' }));
    });

    it('throws if validateEntity throws InternalExecutionError', () => {
      const graph = createStateGraph();
      graph.set('agg-1', { status: 'pending' });

      const mockValidator: Partial<ContractValidator> = {
        validateEntity: () => {
          throw new InternalExecutionError('Schema validation failed', {});
        },
      };

      const boundary = makeBoundary({
        reducers: [{ on: 'StatusChanged', patches: [{ op: 'replace', path: '/status', value: '${"active"}' }] }],
      });
      const event = makeDomainEvent({ type: 'StatusChanged', payload: {} });

      expect(() =>
        projectEvent({
          event,
          boundary,
          graph,
          cel,
          validator: mockValidator as ContractValidator,
        }),
      ).toThrow(InternalExecutionError);
    });
  });

  // ── Non-Error throw in projectEvent span catch (line 49) ────────────────────

  describe('non-Error thrown in projectEvent span catch (line 49)', () => {
    it('handles non-Error thrown from validator.validateEntity — String(err) used in span status', () => {
      // validator.validateEntity throws a non-Error (string) → line 49 fires String(err)
      // Note: this still propagates the throw; line 49 is the span.setStatus branch
      const graph = createStateGraph();
      graph.set('agg-1', { status: 'pending' });

      const mockValidator: Partial<ContractValidator> = {
        validateEntity: () => {
          throw 'non-error-string-from-validator';
        },
      };

      const boundary = makeBoundary({
        reducers: [{ on: 'StatusChanged', patches: [{ op: 'replace', path: '/status', value: '${"active"}' }] }],
      });
      const event = makeDomainEvent({ type: 'StatusChanged', payload: {} });

      // The non-Error thrown by validator propagates up from projectEvent
      expect(() =>
        projectEvent({
          event,
          boundary,
          graph,
          cel,
          validator: mockValidator as ContractValidator,
        }),
      ).toThrow('non-error-string-from-validator');
    });
  });
});
