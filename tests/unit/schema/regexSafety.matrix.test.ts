import { detectCatastrophicRegexShape } from '../../../src/schema/regexSafety.js';

describe('regular-expression safety guard', () => {
  it.each([
    ['(a+)+', 'nested-quantifier'],
    ['(a*)*', 'nested-quantifier'],
    ['(a|aa)+', 'overlapping-alternation'],
    ['(a(b+))++', 'nested groups'],
    ['a+a+a+', 'sequential-unbounded'],
  ])('rejects the %s catastrophic shape', (pattern, expected) => {
    expect(detectCatastrophicRegexShape(pattern)).toContain(expected);
  });

  it.each(['', '^[a-z]+$', '(?:ab){2,4}', 'a+b+c+', 'foo\\+bar', '[a-z]*\\d+'])(
    'accepts safe pattern %s',
    (pattern) => {
      expect(detectCatastrophicRegexShape(pattern)).toBeNull();
    },
  );
});
