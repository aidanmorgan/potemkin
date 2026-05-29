/**
 * Unit tests for the DSL v2 evaluateDslValue() method on CelEvaluator.
 *
 * Verifies the ${expr} syntax: bare values are literals, ${...} is CEL,
 * string interpolation, and $${...} escaping.
 */

import { createCelEvaluator } from '../../../src/cel/evaluator.js';
import { CelPhase } from '../../../src/cel/phases.js';

describe('CelEvaluator.evaluateDslValue', () => {
  const cel = createCelEvaluator();
  const ctx = { state: { status: 'NEW', score: 50 }, command: { payload: { name: 'Test' } } };

  describe('non-string values returned as-is', () => {
    it('number → number', () => {
      expect(cel.evaluateDslValue(42, ctx, CelPhase.Behavior)).toBe(42);
    });

    it('boolean → boolean', () => {
      expect(cel.evaluateDslValue(true, ctx, CelPhase.Behavior)).toBe(true);
      expect(cel.evaluateDslValue(false, ctx, CelPhase.Behavior)).toBe(false);
    });

    it('null → null', () => {
      expect(cel.evaluateDslValue(null, ctx, CelPhase.Behavior)).toBeNull();
    });

    it('array → array', () => {
      expect(cel.evaluateDslValue([], ctx, CelPhase.Behavior)).toEqual([]);
      expect(cel.evaluateDslValue([1, 2, 3], ctx, CelPhase.Behavior)).toEqual([1, 2, 3]);
    });

    it('object → object', () => {
      expect(cel.evaluateDslValue({ a: 1 }, ctx, CelPhase.Behavior)).toEqual({ a: 1 });
    });
  });

  describe('${expr} full expression', () => {
    it('evaluates CEL expression and preserves return type', () => {
      expect(cel.evaluateDslValue('${state.score}', ctx, CelPhase.Behavior)).toBe(50);
    });

    it('evaluates string-returning expression', () => {
      expect(cel.evaluateDslValue('${state.status}', ctx, CelPhase.Behavior)).toBe('NEW');
    });

    it('evaluates complex expression', () => {
      expect(cel.evaluateDslValue('${state.score > 40}', ctx, CelPhase.Behavior)).toBe(true);
    });
  });

  describe('string interpolation', () => {
    it('interpolates ${expr} within a string', () => {
      expect(cel.evaluateDslValue('Status: ${state.status}', ctx, CelPhase.Behavior)).toBe('Status: NEW');
    });

    it('interpolates multiple expressions', () => {
      expect(cel.evaluateDslValue('${state.status} (${state.score})', ctx, CelPhase.Behavior)).toBe('NEW (50)');
    });
  });

  describe('escape with $${', () => {
    it('$${...} produces literal ${...}', () => {
      expect(cel.evaluateDslValue('$${not-an-expression}', ctx, CelPhase.Behavior)).toBe('${not-an-expression}');
    });
  });

  describe('backward compat: bare strings evaluated as CEL', () => {
    it('bare CEL expression still works', () => {
      expect(cel.evaluateDslValue('state.score', ctx, CelPhase.Behavior)).toBe(50);
    });

    it('bare string literal in CEL works', () => {
      expect(cel.evaluateDslValue("'NEW'", ctx, CelPhase.Behavior)).toBe('NEW');
    });
  });
});
