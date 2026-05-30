/**
 * Grammar-level tests for the DSL value-template lexer + parser:
 * ${expr} / prefix-${e}-suffix / $${literal} / bare literal, including nested
 * braces inside an interpolation.
 */
import { parseTemplate } from '../../../../src/cel/grammar/template';
import { lexTemplate } from '../../../../src/cel/grammar/templateLexer';

describe('cel/grammar/template — parseTemplate plans', () => {
  it('non-string value is a pass-through literal', () => {
    expect(parseTemplate(42)).toEqual({ kind: 'literal', value: 42 });
    expect(parseTemplate(null)).toEqual({ kind: 'literal', value: null });
    expect(parseTemplate([1, 2])).toEqual({ kind: 'literal', value: [1, 2] });
  });

  it('bare string without ${} is a whole CEL expression', () => {
    expect(parseTemplate('state.score')).toEqual({ kind: 'whole', expr: 'state.score' });
  });

  it('a lone ${expr} is a whole expression preserving type', () => {
    expect(parseTemplate('${state.score}')).toEqual({ kind: 'whole', expr: 'state.score' });
  });

  it('prefix-${expr}-suffix is interpolation', () => {
    const plan = parseTemplate('Status: ${state.status}!');
    expect(plan.kind).toBe('interp');
    if (plan.kind === 'interp') {
      expect(plan.parts).toEqual([
        { kind: 'text', text: 'Status: ' },
        { kind: 'expr', src: 'state.status' },
        { kind: 'text', text: '!' },
      ]);
    }
  });

  it('multiple expressions interpolate', () => {
    const plan = parseTemplate('${a} and ${b}');
    expect(plan.kind).toBe('interp');
  });

  it('$${literal} escapes to literal ${literal}', () => {
    expect(parseTemplate('$${not-an-expr}')).toEqual({
      kind: 'literal', value: '${not-an-expr}',
    });
  });

  it('escaped and text coalesce into one literal', () => {
    expect(parseTemplate('pre $${x} post')).toEqual({
      kind: 'literal', value: 'pre ${x} post',
    });
  });

  it('handles nested braces inside an interpolation', () => {
    // The map literal {"a":1} inside the ${...} must not close the span early.
    expect(parseTemplate('${ {"a": 1}.size() }')).toEqual({
      kind: 'whole', expr: ' {"a": 1}.size() ',
    });
  });

  it('handles nested ${...} braces in mixed interpolation', () => {
    const plan = parseTemplate('x=${ {"k": v}["k"] }!');
    expect(plan.kind).toBe('interp');
    if (plan.kind === 'interp') {
      expect(plan.parts[1]).toEqual({ kind: 'expr', src: ' {"k": v}["k"] ' });
    }
  });
});

describe('cel/grammar/templateLexer', () => {
  it('classifies TEXT, EXPR, ESCAPED lexemes', () => {
    const toks = lexTemplate('a ${b} c $${d}');
    expect(toks.map(t => t.type)).toEqual(['TEXT', 'EXPR', 'TEXT', 'ESCAPED']);
  });

  it('treats an unbalanced ${ as plain text', () => {
    const toks = lexTemplate('a ${b');
    expect(toks.every(t => t.type === 'TEXT')).toBe(true);
    expect(toks.map(t => (t.type === 'TEXT' ? t.text : '')).join('')).toBe('a ${b');
  });

  it('treats an unbalanced $${ as plain text', () => {
    const toks = lexTemplate('$${b');
    expect(toks.map(t => (t.type === 'TEXT' ? t.text : '')).join('')).toBe('$${b');
  });

  it('reports a position on each token', () => {
    const toks = lexTemplate('ab${c}');
    expect(toks[0]!.pos).toMatchObject({ line: 1, col: 1 });
    expect(toks[1]!.pos.offset).toBe(2);
  });
});
