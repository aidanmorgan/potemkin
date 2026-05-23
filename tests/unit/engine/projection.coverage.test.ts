/**
 * Coverage backfill for engine/projection.ts
 *
 * Uncovered lines:
 *  - 49: non-Error thrown in projectEvent span catch (String(err) branch)
 *  - 104: non-Error CEL throw in assign reducer (String(err) branch)
 *  - 129: InternalExecutionError on append CEL evaluation failure
 *  - 130: non-Error CEL throw in append reducer (String(err) branch)
 *  - 151: validator.validateEntity branch (validator is supplied)
 *  - 177: parsePath returns empty array branch (unreachable — kept for documentation)
 *  - 183: `return; // Can't navigate further` inside setByDotPath loop when current is non-object
 *  - 187-193: Array.isArray(current) traversal branch in setByDotPath loop
 *  - 198: creating [] intermediate node when next part is numeric and current key is null
 *  - 208: lastPart is a number → use as array index directly
 *  - 228-229: getByDotPath array traversal (Array.isArray branch)
 */

import { projectEvent, setByDotPath, getByDotPath } from '../../../src/engine/projection';
import { createStateGraph } from '../../../src/stategraph/graph';
import { createCelEvaluator } from '../../../src/cel/evaluator';
import { InternalExecutionError } from '../../../src/errors';
import type { CelEvaluator } from '../../../src/cel/evaluator';
import type { ContractValidator } from '../../../src/contract/validator';
import { makeBoundary, makeDomainEvent } from '../_helpers';

const cel = createCelEvaluator();

// ── Line 129: append CEL evaluation failure ──────────────────────────────────

describe('projection.ts additional coverage', () => {
  describe('append CEL evaluation failure (line 129)', () => {
    it('throws InternalExecutionError when append CEL expression throws', () => {
      const graph = createStateGraph();
      graph.set('agg-1', { items: [] });
      const boundary = makeBoundary({
        reducers: [{ on: 'ItemAdded', append: { items: 'undefined_ident_append' } }],
      });
      const event = makeDomainEvent({ type: 'ItemAdded', payload: {} });
      expect(() =>
        projectEvent({ event, boundary, graph, cel }),
      ).toThrow(InternalExecutionError);
    });

    it('InternalExecutionError message mentions the append path', () => {
      const graph = createStateGraph();
      graph.set('agg-1', { tags: [] });
      const boundary = makeBoundary({
        reducers: [{ on: 'Tagged', append: { tags: 'undefined_cel_fn()' } }],
      });
      const event = makeDomainEvent({ type: 'Tagged', payload: {} });
      try {
        projectEvent({ event, boundary, graph, cel });
        fail('expected InternalExecutionError');
      } catch (err) {
        expect(err).toBeInstanceOf(InternalExecutionError);
        expect((err as InternalExecutionError).message).toContain('tags');
      }
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
        reducers: [{ on: 'StatusChanged', assign: { status: '"active"' } }],
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
        reducers: [{ on: 'StatusChanged', assign: { status: '"active"' } }],
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

  // ── Lines 183, 187-193: setByDotPath array traversal branches ───────────────

  describe('setByDotPath — array traversal branches (lines 183, 187-193)', () => {
    it('array intermediate node: sets value inside nested array using bracket notation', () => {
      // Path: items[0].name — current becomes an array at 'items', then traverses index 0
      const obj: any = { items: [{ name: 'old' }] };
      setByDotPath(obj, 'items[0].name', 'new');
      expect(obj.items[0].name).toBe('new');
    });

    it('array intermediate node: creates object at null index in array', () => {
      // Path: items[0].name — current is array, items[0] is null → creates {} then sets .name
      const obj: any = { items: [null] };
      setByDotPath(obj, 'items[0].name', 'created');
      expect(obj.items[0].name).toBe('created');
    });

    it('array intermediate node: creates array at numeric next part', () => {
      // Path: matrix[0][1] — navigates matrix (array) → index 0 (null → new array) → index 1
      const obj: any = { matrix: [null] };
      setByDotPath(obj, 'matrix[0][1]', 42);
      expect(obj.matrix[0][1]).toBe(42);
    });

    it('returns early when navigating through non-object/non-array primitive (line 183)', () => {
      // Path: a.b.c — but a is a number (non-object), so should return without throwing
      const obj: any = { a: 42 };
      // Should not throw — just silently returns
      expect(() => setByDotPath(obj, 'a.b.c', 'value')).not.toThrow();
      // 'a' remains unchanged
      expect(obj.a).toBe(42);
    });

    it('array NaN index returns early (line 188)', () => {
      // Traversing through array with a non-numeric part → isNaN(idx) → return
      const obj: any = { items: ['x', 'y'] };
      // setByDotPath with path that resolves to NaN array index
      // 'items.notAnIndex.deep' — items is an array, 'notAnIndex' parses to NaN
      expect(() => setByDotPath(obj, 'items.notAnIndex.deep', 'x')).not.toThrow();
    });

    it('sets value at array index in final position (line 207-209)', () => {
      // Navigate to an array, set value at numeric index
      const obj: any = { nums: [1, 2, 3] };
      setByDotPath(obj, 'nums[2]', 99);
      expect(obj.nums[2]).toBe(99);
    });

    it('creates [] intermediate node when key is null and next part is numeric (line 198)', () => {
      // Path 'a[0]' on empty obj → parts = ['a', 0]
      // Iteration 0: part='a', current={}, current['a']==null, nextPart=0 (number) → current['a'] = []
      // After loop: lastPart=0 (number), Array.isArray(current) → idx=0, current[0] = value
      const obj: any = {};
      setByDotPath(obj, 'a[0]', 'first');
      expect(obj.a[0]).toBe('first');
    });

    it('creates nested [] from object with missing key and numeric next part', () => {
      // Path 'list[0]' on object with no 'list' key — creates array at 'list', sets index 0
      const obj: any = { other: 'value' };
      setByDotPath(obj, 'list[0]', 42);
      expect(obj.list).toBeDefined();
      expect(Array.isArray(obj.list)).toBe(true);
      expect(obj.list[0]).toBe(42);
    });

    it('returns early at final part when current is a primitive (line 205)', () => {
      // Path 'a[0]' on {a: 'string'} — after loop, current = 'string' (primitive)
      // → line 205: typeof current !== 'object' → return
      const obj: any = { a: 'string-not-array' };
      // Should not throw — silently returns when current is primitive at final step
      expect(() => setByDotPath(obj, 'a[0]', 'value')).not.toThrow();
      // 'a' should remain unchanged since we can't index into a string
      expect(obj.a).toBe('string-not-array');
    });
  });

  // ── getByDotPath — array traversal branch (lines 228-229) ───────────────────

  describe('getByDotPath — array traversal (lines 228-229)', () => {
    it('traverses through array intermediate node (Array.isArray branch)', () => {
      // Path: 'items[0].name' — parts = ['items', 0, 'name']
      // Iteration for part=0: Array.isArray(current) → TRUE, idx=0
      const obj: any = { items: [{ name: 'first' }, { name: 'second' }] };
      expect(getByDotPath(obj, 'items[0].name')).toBe('first');
      expect(getByDotPath(obj, 'items[1].name')).toBe('second');
    });

    it('returns undefined for NaN array index in getByDotPath', () => {
      // Array with non-numeric part → isNaN → return undefined
      const obj: any = { items: ['a', 'b'] };
      // 'items.notAnIndex' — when current is array, 'notAnIndex' is NaN → undefined
      expect(getByDotPath(obj, 'items.notAnIndex')).toBeUndefined();
    });

    it('returns element at numeric array index', () => {
      // Direct numeric part access in array
      const obj: any = { nums: [10, 20, 30] };
      expect(getByDotPath(obj, 'nums[1]')).toBe(20);
    });

    it('returns undefined when array index is out of bounds', () => {
      const obj: any = { items: ['a'] };
      expect(getByDotPath(obj, 'items[5]')).toBeUndefined();
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
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          throw 'non-error-string-from-validator';
        },
      };

      const boundary = makeBoundary({
        reducers: [{ on: 'StatusChanged', assign: { status: '"active"' } }],
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

  // ── Non-Error throws in projectEvent (lines 104, 130) ───────────────────────

  describe('non-Error throws in projectEvent — String(err) branches (lines 104, 130)', () => {
    it('assign CEL throws non-Error (string) → InternalExecutionError uses String(err) (line 104)', () => {
      const graph = createStateGraph();
      graph.set('agg-1', { val: 'old' });

      // Create a mock cel that throws a string (non-Error) for evaluate
      const mockCel: CelEvaluator = {
        ...cel,
        evaluate: (expr: string, _ctx: unknown, _phase: unknown) => {
          // Only throw for the CEL expressions in reducers (not for other phases)
          throw 'non-error-string-from-cel';
        },
      };

      const boundary = makeBoundary({
        reducers: [{ on: 'ValueChanged', assign: { val: '"new"' } }],
      });
      const event = makeDomainEvent({ type: 'ValueChanged', payload: {} });

      let caughtError: unknown;
      try {
        projectEvent({ event, boundary, graph, cel: mockCel });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(InternalExecutionError);
      // String(err) = 'non-error-string-from-cel' should appear in the message
      expect((caughtError as InternalExecutionError).message).toContain('non-error-string-from-cel');
    });

    it('append CEL throws non-Error (string) → InternalExecutionError uses String(err) (line 130)', () => {
      const graph = createStateGraph();
      graph.set('agg-1', { tags: [] });

      const mockCel: CelEvaluator = {
        ...cel,
        evaluate: (_expr: string, _ctx: unknown, _phase: unknown) => {
          throw 'non-error-append-fail';
        },
      };

      const boundary = makeBoundary({
        reducers: [{ on: 'TagAdded', append: { tags: '"newtag"' } }],
      });
      const event = makeDomainEvent({ type: 'TagAdded', payload: {} });

      let caughtError: unknown;
      try {
        projectEvent({ event, boundary, graph, cel: mockCel });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(InternalExecutionError);
      expect((caughtError as InternalExecutionError).message).toContain('non-error-append-fail');
    });
  });
});
