/**
 * Grammar-level tests for the table-driven LALR(1) CEL parser: precedence,
 * associativity, AST shapes, quoted-literal-containing tokens, and parse-error
 * line/column positions.
 */
import { parse, ParseError } from '../../../../src/cel/grammar/parser';
import type { Expr } from '../../../../src/cel/grammar/ast';

describe('cel/grammar/parser — precedence & associativity', () => {
  it('multiplication binds tighter than addition', () => {
    const ast = parse('1 + 2 * 3') as Extract<Expr, { kind: 'binary' }>;
    expect(ast).toMatchObject({ kind: 'binary', op: '+' });
    expect(ast.right).toMatchObject({ kind: 'binary', op: '*' });
  });

  it('parentheses override precedence', () => {
    const ast = parse('(1 + 2) * 3') as Extract<Expr, { kind: 'binary' }>;
    expect(ast).toMatchObject({ kind: 'binary', op: '*' });
    expect(ast.left).toMatchObject({ kind: 'binary', op: '+' });
  });

  it('subtraction is left-associative: 1 - 2 - 3 → (1 - 2) - 3', () => {
    const ast = parse('1 - 2 - 3') as Extract<Expr, { kind: 'binary' }>;
    expect(ast.op).toBe('-');
    expect(ast.left).toMatchObject({ kind: 'binary', op: '-' });
    expect(ast.right).toMatchObject({ kind: 'literal', value: 3 });
  });

  it('division is left-associative: 8 / 4 / 2 → (8 / 4) / 2', () => {
    const ast = parse('8 / 4 / 2') as Extract<Expr, { kind: 'binary' }>;
    expect(ast.left).toMatchObject({ kind: 'binary', op: '/' });
  });

  it('&& binds tighter than ||: a && b || c → (a && b) || c', () => {
    const ast = parse('a && b || c') as Extract<Expr, { kind: 'binary' }>;
    expect(ast.op).toBe('||');
    expect(ast.left).toMatchObject({ kind: 'binary', op: '&&' });
  });

  it('unary ! binds tighter than ==: !a == b → (!a) == b', () => {
    const ast = parse('!a == b') as Extract<Expr, { kind: 'binary' }>;
    expect(ast.op).toBe('==');
    expect(ast.left).toMatchObject({ kind: 'unary', op: '!' });
  });

  it('comparison/equality share a left-assoc level: 5 > 3 == true', () => {
    const ast = parse('5 > 3 == true') as Extract<Expr, { kind: 'binary' }>;
    expect(ast.op).toBe('==');
    expect(ast.left).toMatchObject({ kind: 'binary', op: '>' });
  });

  it('ternary is right-associative', () => {
    const ast = parse('a ? b : c ? d : e') as Extract<Expr, { kind: 'ternary' }>;
    expect(ast.kind).toBe('ternary');
    expect(ast.else).toMatchObject({ kind: 'ternary' });
  });

  it('arithmetic binds tighter than comparison: 1 + 2 == 3', () => {
    const ast = parse('1 + 2 == 3') as Extract<Expr, { kind: 'binary' }>;
    expect(ast.op).toBe('==');
    expect(ast.left).toMatchObject({ kind: 'binary', op: '+' });
  });
});

describe('cel/grammar/parser — AST shapes', () => {
  it('member access produces a literal string key', () => {
    expect(parse('a.b')).toEqual({
      kind: 'member',
      obj: { kind: 'ident', name: 'a' },
      key: { kind: 'literal', value: 'b' },
    });
  });

  it('index access keeps the index expression', () => {
    expect(parse('a[0]')).toMatchObject({ kind: 'member', key: { kind: 'literal', value: 0 } });
  });

  it('null-safe member and index', () => {
    expect(parse('a?.b')).toMatchObject({ kind: 'nullSafeMember' });
    expect(parse('a?[0]')).toMatchObject({ kind: 'nullSafeMember' });
  });

  it('function call', () => {
    expect(parse('$concat("a", "b")')).toEqual({
      kind: 'call',
      fn: '$concat',
      args: [
        { kind: 'literal', value: 'a' },
        { kind: 'literal', value: 'b' },
      ],
    });
  });

  it('receiver method call', () => {
    expect(parse('"x".size()')).toMatchObject({ kind: 'method', method: 'size', args: [] });
  });

  it('comprehension with identifier var and body', () => {
    expect(parse('xs.filter(x, x > 0)')).toMatchObject({
      kind: 'comprehension', kind2: 'filter', varName: 'x',
    });
  });

  it('list and map literals, with trailing commas', () => {
    expect(parse('[1, 2, 3,]')).toMatchObject({ kind: 'array' });
    expect(parse('{"a": 1,}')).toMatchObject({ kind: 'object' });
  });

  it('parses a string literal containing operator-like and brace characters', () => {
    // Quoted tokens must not be parsed as structure.
    expect(parse('"a + b ? {x}"')).toEqual({ kind: 'literal', value: 'a + b ? {x}' });
    expect(parse("'state.x ${nope}'")).toEqual({ kind: 'literal', value: 'state.x ${nope}' });
  });
});

describe('cel/grammar/parser — errors carry line/column', () => {
  it('reports the position of an unexpected token', () => {
    try {
      parse('1 +\n  )');
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      const pe = e as ParseError;
      expect(pe.message).toMatch(/line 2, column 3/);
      expect(pe.pos).toMatchObject({ line: 2, col: 3 });
    }
  });

  it('reports end-of-input position for a truncated expression', () => {
    try {
      parse('1 +');
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).message).toMatch(/end of input/);
    }
  });

  it('propagates lexer position errors as ParseError', () => {
    try {
      parse('  @');
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).pos).toMatchObject({ line: 1, col: 3 });
    }
  });

  it('rejects a comprehension whose first argument is not an identifier', () => {
    expect(() => parse('xs.filter(1, x > 0)')).toThrow(/comprehension expects identifier/);
  });

  it('rejects a comprehension with the wrong arity', () => {
    expect(() => parse('xs.filter(x)')).toThrow(/comprehension expects identifier/);
  });

  it('rejects an unknown method name used as a call', () => {
    expect(() => parse('a.bogus(1)')).toThrow(/unknown method/);
  });
});
