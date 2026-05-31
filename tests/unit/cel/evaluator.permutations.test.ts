/**
 * Exhaustive permutation tests for CEL evaluator.
 * Targets: src/cel/evaluator.ts (branches ~90% → ≥95%)
 */
import { createCelEvaluator } from '../../../src/cel/evaluator';
import { CelPhase } from '../../../src/cel/phases';

describe('cel/evaluator — permutations', () => {
  const cel = createCelEvaluator();
  const ev = (expr: string, ctx: Record<string, unknown> = {}) =>
    cel.evaluate(expr, ctx, CelPhase.Behavior);

  // ── Escape sequences ────────────────────────────────────────────────────────
  describe('string escape sequences — full coverage', () => {
    it.each([
      ['"\\n"', '\n'],
      ['"\\t"', '\t'],
      ['"\\r"', '\r'],
      ['"\\\\"', '\\'],
      ['"\\""', '"'],
      ["\"\\\'\"", "'"],
    ])('escape %s → %j', (expr, expected) => {
      expect(ev(expr)).toBe(expected);
    });

    it('unknown escape sequence returns the escaped char', () => {
      // e.g. \z — not a standard escape, returns 'z'
      expect(ev('"\\z"')).toBe('z');
    });

    it('single-quoted string with escape', () => {
      expect(ev("'hello\\'s world'")).toBe("hello's world");
    });
  });

  // ── Operator precedence / associativity matrix ──────────────────────────────
  describe('operator precedence', () => {
    it('1 + 2 * 3 = 7 (mul before add)', () => {
      expect(ev('1 + 2 * 3')).toBe(7);
    });

    it('(1 + 2) * 3 = 9 (parens override)', () => {
      expect(ev('(1 + 2) * 3')).toBe(9);
    });

    it('1 - 2 - 3 = -4 (left-associative subtraction)', () => {
      expect(ev('1 - 2 - 3')).toBe(-4);
    });

    it('8 / 4 / 2 = 1 (left-associative division)', () => {
      expect(ev('8 / 4 / 2')).toBe(1);
    });

    it('a && b || c: && has higher precedence', () => {
      // false && false || true = true
      expect(ev('false && false || true')).toBe(true);
    });

    it('a || b && c: && binds tighter', () => {
      // true || false && false = true
      expect(ev('true || false && false')).toBe(true);
    });

    it('!a == b: unary ! has higher precedence than ==', () => {
      expect(ev('!false == true')).toBe(true);
    });

    it('a + b == c: arithmetic before comparison', () => {
      expect(ev('1 + 2 == 3')).toBe(true);
    });

    it('comparison chains are left-to-right', () => {
      expect(ev('5 > 3 == true')).toBe(true);
    });
  });

  // ── Short-circuit semantics ─────────────────────────────────────────────────
  describe('short-circuit evaluation', () => {
    it('false && <throws> does NOT evaluate right side', () => {
      // If right side were evaluated, it would throw on undefined identifier
      expect(() => ev('false && undefinedIdentifier')).not.toThrow();
      expect(ev('false && undefinedIdentifier')).toBe(false);
    });

    it('true || <throws> does NOT evaluate right side', () => {
      expect(() => ev('true || undefinedIdentifier')).not.toThrow();
      expect(ev('true || undefinedIdentifier')).toBe(true);
    });

    it('true && <expr> DOES evaluate right side', () => {
      // right side evaluated — should resolve
      expect(ev('true && 42 == 42')).toBe(true);
    });

    it('false || <expr> DOES evaluate right side', () => {
      expect(ev('false || "x" == "x"')).toBe(true);
    });

    it('ternary true branch: only then is evaluated', () => {
      expect(ev('true ? 1 : undefinedIdentifier')).toBe(1);
    });

    it('ternary false branch: only else is evaluated', () => {
      expect(ev('false ? undefinedIdentifier : 2')).toBe(2);
    });
  });

  // ── Type coercion in + ──────────────────────────────────────────────────────
  describe('+ operator type coercion', () => {
    it('number + number = number', () => {
      expect(ev('10 + 20')).toBe(30);
    });

    it('string + string = string', () => {
      expect(ev('"a" + "b"')).toBe('ab');
    });

    it('number + string → string (right is string)', () => {
      expect(ev('42 + "!"')).toBe('42!');
    });

    it('string + number → string (left is string)', () => {
      expect(ev('"val:" + 7')).toBe('val:7');
    });

    it('null + string → string "null..."', () => {
      expect(ev('null + "x"')).toBe('nullx');
    });
  });

  // ── Strict equality ─────────────────────────────────────────────────────────
  describe('strict equality (CEL uses ===)', () => {
    it('1 == "1" is false (no coercion)', () => {
      expect(ev('1 == "1"')).toBe(false);
    });

    it('null == null is true', () => {
      expect(ev('null == null')).toBe(true);
    });

    it('false == 0 is false', () => {
      expect(ev('false == 0')).toBe(false);
    });

    it('"" == false is false', () => {
      expect(ev('"" == false')).toBe(false);
    });

    it('null != 0 is true', () => {
      expect(ev('null != 0')).toBe(true);
    });
  });

  // ── Nested member access ────────────────────────────────────────────────────
  describe('nested member access', () => {
    it('a.b.c.d (4 levels deep)', () => {
      expect(ev('a.b.c.d', { a: { b: { c: { d: 'deep' } } } })).toBe('deep');
    });

    it('bracket access a["b"]', () => {
      expect(ev('a["b"]', { a: { b: 99 } })).toBe(99);
    });

    it('mixed a.b[0].c', () => {
      expect(ev('a.b[0].c', { a: { b: [{ c: 'found' }] } })).toBe('found');
    });

    it('a[0][1] (2D array)', () => {
      expect(ev('a[0][1]', { a: [[10, 20], [30, 40]] })).toBe(20);
    });

    it('throws on non-object/array member access', () => {
      expect(() => ev('a[0]', { a: 'not-array' })).toThrow('CEL_EVAL');
    });

    it('throws on string key on array', () => {
      expect(() => ev('a["key"]', { a: [1, 2, 3] })).toThrow('CEL_EVAL');
    });
  });

  // ── Object literals ─────────────────────────────────────────────────────────
  describe('object literals', () => {
    it('empty object evaluates to {}', () => {
      expect(ev('{}')).toEqual({});
    });

    it('object with string key and value', () => {
      expect(ev('{"k": "v"}')).toEqual({ k: 'v' });
    });

    it('throws when object key is not a string', () => {
      expect(() => ev('{1: "val"}')).toThrow('CEL_EVAL');
    });
  });

  // ── Array literals ──────────────────────────────────────────────────────────
  describe('array literals', () => {
    it('array of mixed types', () => {
      expect(ev('[1, "two", true, null]')).toEqual([1, 'two', true, null]);
    });

    it('nested array literal', () => {
      expect(ev('[[1, 2], [3, 4]]')).toEqual([[1, 2], [3, 4]]);
    });
  });

  // ── in operator ─────────────────────────────────────────────────────────────
  describe('in operator edge cases', () => {
    it('number in array', () => {
      expect(ev('2 in [1, 2, 3]')).toBe(true);
    });

    it('null in array', () => {
      expect(ev('null in [null, 1, 2]')).toBe(true);
    });

    it('key in nested object', () => {
      expect(ev('"x" in obj.nested', { obj: { nested: { x: 1 } } })).toBe(true);
    });
  });

  // ── Negative number in expression ───────────────────────────────────────────
  describe('negative numbers', () => {
    it('tokenizer handles negative integer', () => {
      expect(ev('-42')).toBe(-42);
    });

    it('tokenizer handles negative float', () => {
      expect(ev('-3.14')).toBeCloseTo(-3.14);
    });

    it('unary minus on variable', () => {
      expect(ev('-x', { x: 5 })).toBe(-5);
    });
  });

  // ── Compiled AST reuse ──────────────────────────────────────────────────────
  describe('compiled AST reuse', () => {
    it('same compiled expr evaluated multiple times yields consistent results', () => {
      const compiled = cel.compile('x + 1');
      expect(cel.evaluate(compiled, { x: 10 }, CelPhase.Behavior)).toBe(11);
      expect(cel.evaluate(compiled, { x: 10 }, CelPhase.Behavior)).toBe(11);
      expect(cel.evaluate(compiled, { x: 20 }, CelPhase.Behavior)).toBe(21);
    });

    it('compile then evaluate passes through AST', () => {
      const compiled = cel.compile('a == b');
      expect(cel.evaluate(compiled, { a: 1, b: 1 }, CelPhase.Behavior)).toBe(true);
      expect(cel.evaluate(compiled, { a: 1, b: 2 }, CelPhase.Behavior)).toBe(false);
    });
  });

  // ── Whitespace-only and empty expressions ───────────────────────────────────
  describe('empty/whitespace expressions', () => {
    it('throws on empty string expression', () => {
      expect(() => cel.compile('')).toThrow();
    });

    it('throws on whitespace-only expression', () => {
      expect(() => cel.compile('   ')).toThrow();
    });
  });

  // ── Parse errors ────────────────────────────────────────────────────────────
  describe('parse error coverage', () => {
    it('trailing operator causes parse error', () => {
      expect(() => cel.compile('1 + ')).toThrow();
    });

    it('mismatched parens throws', () => {
      expect(() => cel.compile('(1 + 2')).toThrow();
    });

    it('unclosed string literal throws', () => {
      expect(() => cel.compile('"not closed')).toThrow(/CEL_PARSE_ERROR/);
    });

    it('unclosed single-quote string throws', () => {
      expect(() => cel.compile("'not closed")).toThrow(/CEL_PARSE_ERROR/);
    });

    it('unexpected char @ throws', () => {
      expect(() => cel.compile('@x')).toThrow();
    });

    it('extra tokens after expression throw', () => {
      expect(() => cel.compile('1 + 2 extra')).toThrow('CEL_PARSE');
    });

    it('dot without identifier throws', () => {
      expect(() => cel.compile('a. ')).toThrow();
    });
  });

  // ── Phase-banning ───────────────────────────────────────────────────────────
  describe('phase banning — all phases', () => {
    it.each([CelPhase.Behavior, CelPhase.EventHydration] as CelPhase[])(
      '$uuidv7 allowed in phase %s',
      (phase) => {
        const result = cel.evaluate('$uuidv7()', {}, phase) as string;
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);
      },
    );

    it.each([CelPhase.Behavior, CelPhase.EventHydration] as CelPhase[])(
      '$now allowed in phase %s',
      (phase) => {
        const result = cel.evaluate('$now()', {}, phase) as string;
        expect(new Date(result).getFullYear()).toBeGreaterThan(2020);
      },
    );

    it('$uuidv7 banned in Reducer phase throws CEL_PHASE_BANNED', () => {
      expect(() => cel.evaluate('$uuidv7()', {}, CelPhase.Reducer)).toThrow('CEL_PHASE_BANNED');
    });

    it('$now banned in Reducer phase throws CEL_PHASE_BANNED', () => {
      expect(() => cel.evaluate('$now()', {}, CelPhase.Reducer)).toThrow('CEL_PHASE_BANNED');
    });

    it('$concat allowed in all phases', () => {
      for (const phase of [CelPhase.Behavior, CelPhase.EventHydration, CelPhase.Reducer]) {
        expect(cel.evaluate('$concat("x", "y")', {}, phase)).toBe('xy');
      }
    });
  });

  // ── Non-Error thrown objects ────────────────────────────────────────────────
  describe('non-Error thrown objects', () => {
    it('re-throws a non-Error (string) thrown during member access in the evaluate path', () => {
      // The evaluate path's catch handles non-Error throws via the String(err)
      // branch. A context property defined as a getter that throws a bare string
      // makes evalExpr throw a non-Error, which evaluate logs then re-throws
      // unchanged (the original string identity is preserved).
      const ctx: Record<string, unknown> = {};
      Object.defineProperty(ctx, 'boom', {
        enumerable: true,
        get() {
          throw 'non-error-string';
        },
      });

      let thrown: unknown;
      try {
        cel.evaluate('boom', ctx, CelPhase.Behavior);
        throw new Error('expected evaluate to re-throw the non-Error');
      } catch (err) {
        thrown = err;
      }

      // The non-Error value is re-thrown verbatim (not wrapped in an Error).
      expect(thrown).toBe('non-error-string');
      expect(thrown).not.toBeInstanceOf(Error);
    });
  });

  // ── Edge cases for ?? branches in tokenizer/parser ──────────────────────────
  describe('tokenizer edge case branches', () => {
    it('escape at end of string (esc ?? "" branch) — backslash at end of unclosed string', () => {
      // The expression is a double-quote then backslash: the esc var will be undefined
      // because i++ after \ puts us past the end before the closing quote
      const backslashThenEnd = String.fromCharCode(34) + String.fromCharCode(92); // " + \
      expect(() => cel.compile(backslashThenEnd)).toThrow(/CEL_PARSE_ERROR/);
    });

    it('backslash followed by undefined char in single-quoted string', () => {
      // single-quote + backslash with no closing quote
      const backslashThenEnd = String.fromCharCode(39) + String.fromCharCode(92); // ' + \
      expect(() => cel.compile(backslashThenEnd)).toThrow(/CEL_PARSE_ERROR/);
    });

    it('negative sign at end of input (src[i+1] ?? "" branch)', () => {
      // "-" as last char is NOT treated as negative number start because [0-9] doesn't match ""
      // This exercises the ?? '' branch in the negative number check
      // "-" alone would be tokenized as operator
      expect(() => cel.compile('-')).toThrow();
    });

    it('tokens array exhausted — ?? {kind: eof} branch in peek/advance', () => {
      // Compile a valid expression where parser may call advance past token array
      // Empty args function call exercises parser path where peek/advance runs
      expect(ev('$concat()')).toBe('');
    });
  });

  // ── Complex real-world-like expressions ─────────────────────────────────────
  describe('complex expressions', () => {
    it('compound condition with state and command', () => {
      const ctx = {
        state: { status: 'active', balance: 100 },
        command: { payload: { amount: 50 } },
      };
      expect(ev('state.status == "active" && state.balance >= command.payload.amount', ctx)).toBe(true);
    });

    it('ternary with comparison', () => {
      expect(ev('x > 10 ? "big" : "small"', { x: 15 })).toBe('big');
      expect(ev('x > 10 ? "big" : "small"', { x: 5 })).toBe('small');
    });

    it('in operator with array from context', () => {
      expect(ev('val in allowed', { val: 'admin', allowed: ['user', 'admin'] })).toBe(true);
      expect(ev('val in allowed', { val: 'guest', allowed: ['user', 'admin'] })).toBe(false);
    });

    it('chained && and == with negation', () => {
      expect(ev('!false && 1 == 1 && "a" != "b"')).toBe(true);
    });
  });
});
