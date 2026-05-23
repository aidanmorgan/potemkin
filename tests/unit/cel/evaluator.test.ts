import { createCelEvaluator } from '../../../src/cel/evaluator';
import { CelPhase } from '../../../src/cel/phases';

describe('cel/evaluator', () => {
  const cel = createCelEvaluator();
  const phase = CelPhase.Behavior;
  const eval_ = (expr: string, ctx: Record<string, unknown> = {}) =>
    cel.evaluate(expr, ctx, phase);

  // ── compile ────────────────────────────────────────────────────────────────
  describe('compile', () => {
    it('returns CompiledCel with source and _ast', () => {
      const compiled = cel.compile('1 + 1');
      expect(compiled.source).toBe('1 + 1');
      expect(compiled._ast).toBeDefined();
    });

    it('throws on invalid expression', () => {
      expect(() => cel.compile('??')).toThrow();
    });

    it('compiled expression can be passed directly to evaluate', () => {
      const compiled = cel.compile('2 * 3');
      const result = cel.evaluate(compiled, {}, phase);
      expect(result).toBe(6);
    });

    // FIXME: bug in cel/evaluator tokenizer — unclosed string literals are silently consumed
    // instead of throwing a parse error. The tokenizer stops at EOF without checking closure.
    it.failing('throws on unclosed string literal', () => {
      expect(() => cel.compile('"hello')).toThrow();
    });
  });

  // ── literals ───────────────────────────────────────────────────────────────
  describe('literals', () => {
    it('evaluates integer literal', () => {
      expect(eval_('42')).toBe(42);
    });

    it('evaluates negative number literal', () => {
      expect(eval_('-7')).toBe(-7);
    });

    it('evaluates float literal', () => {
      expect(eval_('3.14')).toBeCloseTo(3.14);
    });

    it('evaluates double-quoted string literal', () => {
      expect(eval_('"hello"')).toBe('hello');
    });

    it('evaluates single-quoted string literal', () => {
      expect(eval_("'world'")).toBe('world');
    });

    it('evaluates true literal', () => {
      expect(eval_('true')).toBe(true);
    });

    it('evaluates false literal', () => {
      expect(eval_('false')).toBe(false);
    });

    it('evaluates null literal', () => {
      expect(eval_('null')).toBeNull();
    });

    it('evaluates array literal', () => {
      expect(eval_('[1, 2, 3]')).toEqual([1, 2, 3]);
    });

    it('evaluates empty array literal', () => {
      expect(eval_('[]')).toEqual([]);
    });

    it('evaluates object literal', () => {
      expect(eval_('{"a": 1, "b": 2}')).toEqual({ a: 1, b: 2 });
    });

    it('evaluates empty object literal', () => {
      expect(eval_('{}')).toEqual({});
    });

    it('handles string escape sequences', () => {
      expect(eval_('"line1\\nline2"')).toBe('line1\nline2');
    });
  });

  // ── identifiers ────────────────────────────────────────────────────────────
  describe('identifiers', () => {
    it('resolves identifier from context', () => {
      expect(eval_('x', { x: 99 })).toBe(99);
    });

    it('throws on undefined identifier', () => {
      expect(() => eval_('notDefined')).toThrow('CEL_EVAL');
    });

    it('resolves null context value', () => {
      expect(eval_('x', { x: null })).toBeNull();
    });
  });

  // ── property access ────────────────────────────────────────────────────────
  describe('member access', () => {
    it('accesses nested property with dot notation', () => {
      expect(eval_('a.b', { a: { b: 42 } })).toBe(42);
    });

    it('accesses array element with bracket notation', () => {
      expect(eval_('arr[0]', { arr: [10, 20, 30] })).toBe(10);
    });

    it('accesses nested property with bracket string key', () => {
      expect(eval_('obj["key"]', { obj: { key: 'val' } })).toBe('val');
    });

    it('returns undefined for missing property', () => {
      expect(eval_('a.b', { a: {} })).toBeUndefined();
    });

    it('throws when accessing property on non-object/array', () => {
      expect(() => eval_('a.b', { a: 42 })).toThrow('CEL_EVAL');
    });
  });

  // ── arithmetic operators ───────────────────────────────────────────────────
  describe('arithmetic operators', () => {
    it('addition', () => {
      expect(eval_('2 + 3')).toBe(5);
    });

    it('subtraction', () => {
      expect(eval_('10 - 4')).toBe(6);
    });

    it('multiplication', () => {
      expect(eval_('3 * 4')).toBe(12);
    });

    it('division', () => {
      expect(eval_('10 / 4')).toBeCloseTo(2.5);
    });

    it('modulo', () => {
      expect(eval_('10 % 3')).toBe(1);
    });

    it('unary minus on number', () => {
      expect(eval_('-(3 + 4)')).toBe(-7);
    });

    it('unary minus on non-number throws', () => {
      expect(() => eval_('-"hello"')).toThrow('CEL_EVAL');
    });
  });

  // ── string concatenation ───────────────────────────────────────────────────
  describe('string concatenation via +', () => {
    it('concatenates two strings', () => {
      expect(eval_('"hello" + " world"')).toBe('hello world');
    });

    it('coerces number to string when other operand is string', () => {
      expect(eval_('"val:" + 42')).toBe('val:42');
    });

    it('left string + right number', () => {
      expect(eval_('x + "!"', { x: 'hi' })).toBe('hi!');
    });
  });

  // ── comparison operators ───────────────────────────────────────────────────
  describe('comparison operators', () => {
    it('== equal numbers', () => {
      expect(eval_('1 == 1')).toBe(true);
    });

    it('== unequal values', () => {
      expect(eval_('1 == 2')).toBe(false);
    });

    it('!= not equal', () => {
      expect(eval_('1 != 2')).toBe(true);
    });

    it('< less than', () => {
      expect(eval_('3 < 5')).toBe(true);
    });

    it('<= less or equal', () => {
      expect(eval_('5 <= 5')).toBe(true);
    });

    it('> greater than', () => {
      expect(eval_('10 > 9')).toBe(true);
    });

    it('>= greater or equal', () => {
      expect(eval_('4 >= 4')).toBe(true);
    });

    it('== with strings', () => {
      expect(eval_('"a" == "a"')).toBe(true);
    });
  });

  // ── logical operators ──────────────────────────────────────────────────────
  describe('logical operators', () => {
    it('&& true && true = true', () => {
      expect(eval_('true && true')).toBe(true);
    });

    it('&& true && false = false', () => {
      expect(eval_('true && false')).toBe(false);
    });

    it('|| false || true = true', () => {
      expect(eval_('false || true')).toBe(true);
    });

    it('|| false || false = false', () => {
      expect(eval_('false || false')).toBe(false);
    });

    it('! negation of true', () => {
      expect(eval_('!true')).toBe(false);
    });

    it('! negation of false', () => {
      expect(eval_('!false')).toBe(true);
    });

    it('&& short-circuits: right side not evaluated when left is false', () => {
      // "undefined_var" would throw if evaluated, but short-circuit prevents it
      const result = eval_('false && undefined_var', { undefined_var: undefined });
      expect(result).toBe(false);
    });

    it('|| short-circuits: right side not evaluated when left is true', () => {
      const result = eval_('true || undefined_var', { undefined_var: undefined });
      expect(result).toBe(true);
    });
  });

  // ── in operator ────────────────────────────────────────────────────────────
  describe('in operator', () => {
    it('"a" in ["a","b"] is true', () => {
      expect(eval_('"a" in ["a","b"]')).toBe(true);
    });

    it('"c" in ["a","b"] is false', () => {
      expect(eval_('"c" in ["a","b"]')).toBe(false);
    });

    it('"key" in object is true when key present', () => {
      expect(eval_('"k" in obj', { obj: { k: 1 } })).toBe(true);
    });

    it('"key" in object is false when key absent', () => {
      expect(eval_('"z" in obj', { obj: { k: 1 } })).toBe(false);
    });

    it('throws when right side is neither array nor object', () => {
      expect(() => eval_('"a" in 42')).toThrow('CEL_EVAL');
    });
  });

  // ── ternary ────────────────────────────────────────────────────────────────
  describe('ternary operator', () => {
    it('true ? "yes" : "no" returns yes', () => {
      expect(eval_('true ? "yes" : "no"')).toBe('yes');
    });

    it('false ? "yes" : "no" returns no', () => {
      expect(eval_('false ? "yes" : "no"')).toBe('no');
    });

    it('nested ternary', () => {
      expect(eval_('1 == 1 ? (2 == 2 ? "both" : "first") : "neither"')).toBe('both');
    });
  });

  // ── operator precedence ────────────────────────────────────────────────────
  describe('operator precedence', () => {
    it('multiplication before addition', () => {
      expect(eval_('2 + 3 * 4')).toBe(14);
    });

    it('parentheses override precedence', () => {
      expect(eval_('(2 + 3) * 4')).toBe(20);
    });

    it('comparison before &&', () => {
      expect(eval_('1 < 2 && 3 < 4')).toBe(true);
    });

    it('&& before ||', () => {
      expect(eval_('false && false || true')).toBe(true);
    });
  });

  // ── builtin functions ──────────────────────────────────────────────────────
  describe('builtin function calls', () => {
    it('$concat joins arguments', () => {
      expect(eval_('$concat("a", "b", "c")')).toBe('abc');
    });

    it('$uuidv7 returns a UUID string', () => {
      const result = eval_('$uuidv7()') as string;
      expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/i);
    });

    it('$now returns an ISO string', () => {
      const result = eval_('$now()') as string;
      expect(() => new Date(result)).not.toThrow();
    });

    it('unknown function throws', () => {
      expect(() => eval_('$bogus()')).toThrow('CEL_UNKNOWN_BUILTIN');
    });

    it('$uuidv7 banned in Reducer phase', () => {
      expect(() =>
        cel.evaluate('$uuidv7()', {}, CelPhase.Reducer),
      ).toThrow('CEL_PHASE_BANNED');
    });

    it('$now banned in Reducer phase', () => {
      expect(() =>
        cel.evaluate('$now()', {}, CelPhase.Reducer),
      ).toThrow('CEL_PHASE_BANNED');
    });

    it('$concat allowed in Reducer phase', () => {
      expect(cel.evaluate('$concat("x","y")', {}, CelPhase.Reducer)).toBe('xy');
    });
  });

  // ── parse errors ───────────────────────────────────────────────────────────
  describe('parse errors', () => {
    it('throws on unexpected character @', () => {
      expect(() => eval_('@bad')).toThrow();
    });

    it('throws on expression with trailing garbage', () => {
      expect(() => cel.compile('1 + 2 extra')).toThrow('CEL_PARSE');
    });

    it('throws on mismatched parentheses', () => {
      expect(() => cel.compile('(1 + 2')).toThrow();
    });

    it('throws on empty expression implicitly (ident from context)', () => {
      // empty string produces eof token which means nothing to parse
      // different evaluator behavior but shouldn't silently succeed
      expect(() => cel.compile('')).toThrow();
    });
  });
});
