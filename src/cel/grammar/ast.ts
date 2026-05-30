/**
 * Typed CEL AST.
 *
 * These node shapes are the contract between the table-driven parser
 * (`src/cel/grammar/parser.ts`) and the evaluator (`src/cel/evaluator.ts`).
 * They are byte-for-byte the same shapes the legacy recursive-descent parser
 * produced, so the evaluator's `evalExpr` switch is unchanged.
 */

export type ComprehensionKind = 'all' | 'exists' | 'exists_one' | 'filter' | 'map';

export type Expr =
  | { kind: 'literal';        value: string | number | boolean | null }
  | { kind: 'ident';          name: string }
  | { kind: 'member';         obj: Expr; key: Expr }
  | { kind: 'nullSafeMember'; obj: Expr; key: Expr }
  | { kind: 'call';           fn: string; args: Expr[] }
  | { kind: 'method';         receiver: Expr; method: string; args: Expr[] }
  | { kind: 'nullSafeMethod'; receiver: Expr; method: string; args: Expr[] }
  | { kind: 'comprehension';  kind2: ComprehensionKind;
                              receiver: Expr; varName: string; body: Expr; nullSafe?: boolean }
  | { kind: 'unary';          op: string; operand: Expr }
  | { kind: 'binary';         op: string; left: Expr; right: Expr }
  | { kind: 'ternary';        cond: Expr; then: Expr; else: Expr }
  | { kind: 'array';          elements: Expr[] }
  | { kind: 'object';         entries: Array<{ key: Expr; value: Expr }> };

/** CEL receiver-style string methods: `expr.method(args)`. */
export const STRING_METHODS = new Set([
  'startsWith', 'endsWith', 'contains', 'size', 'matches', 'replace',
  'split', 'substring', 'indexOf', 'lastIndexOf', 'lowerAscii', 'upperAscii',
  'trim', 'trimStart', 'trimEnd', 'charAt',
]);
export const LIST_METHODS = new Set([
  'size', 'contains', 'indexOf', 'lastIndexOf', 'sort', 'reverse',
  'join', 'flatten', 'distinct',
]);
export const MAP_METHODS = new Set(['size', 'has', 'keys', 'values']);
export const COMPREHENSION_METHODS = new Set<ComprehensionKind>([
  'all', 'exists', 'exists_one', 'filter', 'map',
]);

/** All identifiers that, when followed by `(` after a `.`, are method calls. */
export const RECEIVER_METHODS = new Set<string>([
  ...STRING_METHODS,
  ...LIST_METHODS,
  ...MAP_METHODS,
  ...COMPREHENSION_METHODS,
]);
