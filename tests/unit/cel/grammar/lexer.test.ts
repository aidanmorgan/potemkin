/**
 * Unit tests for the CEL lexer: token classes, positions, and the
 * negative-number lexeme quirk (docs/grammar/cel.grammar.md §1.1).
 */
import { lex, LexError, type Token } from '../../../../src/cel/grammar/lexer';

const types = (src: string): string[] => lex(src).map(t => t.type);
const noEof = (toks: Token[]): Token[] => toks.filter(t => t.type !== '$end');

describe('cel/grammar/lexer', () => {
  describe('token classes', () => {
    it('lexes a number, identifier, and operator', () => {
      expect(types('a + 1')).toEqual(['IDENT', '+', 'NUMBER', '$end']);
    });

    it('lexes booleans and null as their own token types', () => {
      expect(types('true false null')).toEqual(['BOOL', 'BOOL', 'NULL', '$end']);
    });

    it('lexes the in keyword distinctly from identifiers', () => {
      expect(types('x in y')).toEqual(['IDENT', 'in', 'IDENT', '$end']);
    });

    it('lexes two-char operators before single-char', () => {
      expect(types('== != <= >= && ||')).toEqual(
        ['==', '!=', '<=', '>=', '&&', '||', '$end'],
      );
    });

    it('lexes null-safe accessors ?. and ?[', () => {
      expect(types('a?.b ?[ 0 ]')).toEqual(
        ['IDENT', '?.', 'IDENT', '?[', 'NUMBER', ']', '$end'],
      );
    });
  });

  describe('string literals', () => {
    it('decodes escape sequences', () => {
      const [t] = noEof(lex('"a\\nb"'));
      expect(t!.value).toBe('a\nb');
    });

    it('decodes single-quoted strings with an escaped quote', () => {
      const [t] = noEof(lex("'he\\'llo'"));
      expect(t!.value).toBe("he'llo");
    });

    it('reads raw strings without escape processing', () => {
      const [t] = noEof(lex("r'a\\nb'"));
      expect(t!.value).toBe('a\\nb');
    });

    it('throws with a position on an unclosed string', () => {
      expect(() => lex('"oops')).toThrow(/CEL_PARSE_ERROR/);
    });

    it('throws with a position on an unclosed raw string', () => {
      expect(() => lex("r'oops")).toThrow(/CEL_PARSE_ERROR/);
    });
  });

  describe('negative-number lexeme quirk (§1.1)', () => {
    it('lexes -42 as a single NUMBER token', () => {
      const toks = noEof(lex('-42'));
      expect(toks).toHaveLength(1);
      expect(toks[0]!.type).toBe('NUMBER');
      expect(toks[0]!.value).toBe(-42);
    });

    it('lexes 1 - 2 (spaced) as NUMBER op NUMBER', () => {
      expect(types('1 - 2')).toEqual(['NUMBER', '-', 'NUMBER', '$end']);
    });

    it('lexes a -2 (digit hugging minus) as IDENT NUMBER', () => {
      const toks = noEof(lex('a -2'));
      expect(toks.map(t => t.type)).toEqual(['IDENT', 'NUMBER']);
      expect(toks[1]!.value).toBe(-2);
    });

    it('lexes a lone - as the minus operator', () => {
      expect(types('-')).toEqual(['-', '$end']);
    });
  });

  describe('positions', () => {
    it('reports 1-based line/col for each token', () => {
      const toks = noEof(lex('a +\n  b'));
      expect(toks[0]!.pos).toMatchObject({ line: 1, col: 1 });
      expect(toks[1]!.pos).toMatchObject({ line: 1, col: 3 });
      expect(toks[2]!.pos).toMatchObject({ line: 2, col: 3 });
    });
  });

  describe('errors', () => {
    it('throws LexError with a position on an unexpected character', () => {
      try {
        lex('@');
        fail('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(LexError);
        expect((e as LexError).pos).toMatchObject({ line: 1, col: 1 });
      }
    });
  });
});
