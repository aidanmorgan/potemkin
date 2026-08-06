/**
 * Table-driven LR parser for CEL.
 *
 * Consumes the committed LALR(1) ACTION/GOTO tables (`tables.generated.ts`) and
 * the lexer's positioned token stream, running the standard shift/reduce LR
 * driver. Each reduction invokes a per-production semantic action that builds
 * the typed AST (`ast.ts`). The evaluator consumes that AST directly.
 *
 * Parse errors carry 1-based line/column positions (see {@link ParseError}).
 */

import { lex, LexError, type Token, type Position } from './lexer.js';
import { TABLES } from './tables.generated.js';
import { RECEIVER_METHODS, isComprehensionKind, type Expr } from './ast.js';

/** Parse error carrying a source position (1-based line/col). */
export class ParseError extends Error {
  constructor(
    message: string,
    readonly pos: Position,
  ) {
    super(message);
    this.name = 'ParseError';
  }
}

// ---------------------------------------------------------------------------
// Semantic-value types on the parse stack
// ---------------------------------------------------------------------------

/** Intermediate value for `Entry → Expr : Expr`. */
interface EntryVal {
  key: Expr;
  value: Expr;
}
/** A trailing-comma-tolerant list builder used for Args/Elems/Entries bodies. */
type ExprList = Expr[];
type EntryList = EntryVal[];

/** Anything a reduce action can leave on the value stack. */
type StackVal = Token | Expr | ExprList | EntryList | EntryVal;

function requiredAt<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`CEL_PARSE: missing ${label} at position ${index}`);
  }
  return value;
}

function stackValueAt(values: readonly StackVal[], index: number): StackVal {
  return requiredAt(values, index, 'semantic value');
}

function isToken(value: unknown): value is Token {
  return typeof value === 'object' && value !== null && 'type' in value;
}

function isExpr(value: unknown): value is Expr {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false;
  switch (value.kind) {
    case 'literal':
    case 'ident':
    case 'member':
    case 'nullSafeMember':
    case 'call':
    case 'method':
    case 'nullSafeMethod':
    case 'comprehension':
    case 'unary':
    case 'binary':
    case 'ternary':
    case 'array':
    case 'object':
      return true;
    default:
      return false;
  }
}

function isExprList(value: unknown): value is ExprList {
  return Array.isArray(value) && value.every(isExpr);
}

function isEntryVal(value: unknown): value is EntryVal {
  return (
    typeof value === 'object' &&
    value !== null &&
    'key' in value &&
    'value' in value &&
    isExpr(value.key) &&
    isExpr(value.value)
  );
}

function isEntryList(value: unknown): value is EntryList {
  return Array.isArray(value) && value.every(isEntryVal);
}

function exprAt(values: readonly StackVal[], index: number): Expr {
  const value = stackValueAt(values, index);
  if (!isExpr(value)) throw new Error(`CEL_PARSE: expected expression at stack position ${index}`);
  return value;
}

function exprListAt(values: readonly StackVal[], index: number): ExprList {
  const value = stackValueAt(values, index);
  if (!isExprList(value))
    throw new Error(`CEL_PARSE: expected expression list at stack position ${index}`);
  return value;
}

function entryListAt(values: readonly StackVal[], index: number): EntryList {
  const value = stackValueAt(values, index);
  if (!isEntryList(value))
    throw new Error(`CEL_PARSE: expected entry list at stack position ${index}`);
  return value;
}

function entryAt(values: readonly StackVal[], index: number): EntryVal {
  const value = stackValueAt(values, index);
  if (!isEntryVal(value)) throw new Error(`CEL_PARSE: expected entry at stack position ${index}`);
  return value;
}

function tokenAt(values: readonly StackVal[], index: number): Token {
  const value = stackValueAt(values, index);
  if (!isToken(value)) throw new Error(`CEL_PARSE: expected token at stack position ${index}`);
  return value;
}

function tokenValueAt(values: readonly StackVal[], index: number): string | number | boolean {
  const value = tokenAt(values, index).value;
  if (value === undefined)
    throw new Error(`CEL_PARSE: expected value-bearing token at stack position ${index}`);
  return value;
}

function numberValueAt(values: readonly StackVal[], index: number): number {
  const value = tokenValueAt(values, index);
  if (typeof value !== 'number')
    throw new Error(`CEL_PARSE: expected numeric token at stack position ${index}`);
  return value;
}

function stringValueAt(values: readonly StackVal[], index: number): string {
  const value = tokenValueAt(values, index);
  if (typeof value !== 'string')
    throw new Error(`CEL_PARSE: expected string token at stack position ${index}`);
  return value;
}

function booleanValueAt(values: readonly StackVal[], index: number): boolean {
  const value = tokenValueAt(values, index);
  if (typeof value !== 'boolean')
    throw new Error(`CEL_PARSE: expected boolean token at stack position ${index}`);
  return value;
}

// ---------------------------------------------------------------------------
// Reduce actions, indexed by production number (must match grammar.ts).
// Each action receives the slice of semantic values for the production's RHS
// (left-to-right) and returns the LHS semantic value.
// ---------------------------------------------------------------------------

const tokVal = (t: StackVal): string | number | boolean => {
  if (!isToken(t) || t.value === undefined) {
    throw new Error('CEL_PARSE: expected value-bearing token');
  }
  return t.value;
};

type Action = (rhs: StackVal[]) => StackVal;

const ACTIONS: Record<number, Action> = {
  // 0: Expr → Cond
  0: (r) => stackValueAt(r, 0),

  // 1: Cond → Or
  1: (r) => stackValueAt(r, 0),
  // 2: Cond → Or ? Expr : Expr
  // oxlint-disable-next-line unicorn/no-thenable -- CEL AST preserves the grammar's `then` field name.
  2: (r) => ({ kind: 'ternary', cond: exprAt(r, 0), ['then']: exprAt(r, 2), else: exprAt(r, 4) }),

  // 3: Or → Or || Or
  3: (r) => ({ kind: 'binary', op: '||', left: exprAt(r, 0), right: exprAt(r, 2) }),
  // 4: Or → And
  4: (r) => stackValueAt(r, 0),
  // 5: And → And && And
  5: (r) => ({ kind: 'binary', op: '&&', left: exprAt(r, 0), right: exprAt(r, 2) }),
  // 6: And → Rel
  6: (r) => stackValueAt(r, 0),

  // 7..13: Rel → Rel <op> Rel
  7: (r) => ({ kind: 'binary', op: '==', left: exprAt(r, 0), right: exprAt(r, 2) }),
  8: (r) => ({ kind: 'binary', op: '!=', left: exprAt(r, 0), right: exprAt(r, 2) }),
  9: (r) => ({ kind: 'binary', op: '<', left: exprAt(r, 0), right: exprAt(r, 2) }),
  10: (r) => ({ kind: 'binary', op: '<=', left: exprAt(r, 0), right: exprAt(r, 2) }),
  11: (r) => ({ kind: 'binary', op: '>', left: exprAt(r, 0), right: exprAt(r, 2) }),
  12: (r) => ({ kind: 'binary', op: '>=', left: exprAt(r, 0), right: exprAt(r, 2) }),
  13: (r) => ({ kind: 'binary', op: 'in', left: exprAt(r, 0), right: exprAt(r, 2) }),
  // 14: Rel → Add
  14: (r) => stackValueAt(r, 0),

  // 15,16: Add → Add +|- Add
  15: (r) => ({ kind: 'binary', op: '+', left: exprAt(r, 0), right: exprAt(r, 2) }),
  16: (r) => ({ kind: 'binary', op: '-', left: exprAt(r, 0), right: exprAt(r, 2) }),
  // 17: Add → Mul
  17: (r) => stackValueAt(r, 0),

  // 18,19,20: Mul → Mul *|/|% Mul
  18: (r) => ({ kind: 'binary', op: '*', left: exprAt(r, 0), right: exprAt(r, 2) }),
  19: (r) => ({ kind: 'binary', op: '/', left: exprAt(r, 0), right: exprAt(r, 2) }),
  20: (r) => ({ kind: 'binary', op: '%', left: exprAt(r, 0), right: exprAt(r, 2) }),
  // 21: Mul → Unary
  21: (r) => stackValueAt(r, 0),

  // 22: Unary → ! Unary
  22: (r) => ({ kind: 'unary', op: '!', operand: exprAt(r, 1) }),
  // 23: Unary → - Unary
  23: (r) => ({ kind: 'unary', op: '-', operand: exprAt(r, 1) }),
  // 24: Unary → Postfix
  24: (r) => stackValueAt(r, 0),

  // 25: Postfix → Primary
  25: (r) => stackValueAt(r, 0),
  // 26: Postfix → Postfix . IDENT          (member)
  26: (r) => ({
    kind: 'member',
    obj: exprAt(r, 0),
    key: { kind: 'literal', value: String(tokVal(stackValueAt(r, 2))) },
  }),
  // 27: Postfix → Postfix . IDENT ( Args )  (method / comprehension)
  27: (r) =>
    buildCall(
      exprAt(r, 0),
      String(tokVal(stackValueAt(r, 2))),
      exprListAt(r, 4),
      false,
      tokenAt(r, 2).pos,
    ),
  // 28: Postfix → Postfix ?. IDENT          (null-safe member)
  28: (r) => ({
    kind: 'nullSafeMember',
    obj: exprAt(r, 0),
    key: { kind: 'literal', value: String(tokVal(stackValueAt(r, 2))) },
  }),
  // 29: Postfix → Postfix ?. IDENT ( Args )  (null-safe method/comprehension)
  29: (r) =>
    buildCall(
      exprAt(r, 0),
      String(tokVal(stackValueAt(r, 2))),
      exprListAt(r, 4),
      true,
      tokenAt(r, 2).pos,
    ),
  // 30: Postfix → Postfix [ Expr ]          (index)
  30: (r) => ({ kind: 'member', obj: exprAt(r, 0), key: exprAt(r, 2) }),
  // 31: Postfix → Postfix ?[ Expr ]         (null-safe index)
  31: (r) => ({ kind: 'nullSafeMember', obj: exprAt(r, 0), key: exprAt(r, 2) }),

  // 32..35: literals
  32: (r) => ({ kind: 'literal', value: numberValueAt(r, 0) }),
  33: (r) => ({ kind: 'literal', value: stringValueAt(r, 0) }),
  34: (r) => ({ kind: 'literal', value: booleanValueAt(r, 0) }),
  35: () => ({ kind: 'literal', value: null }),
  // 36: Primary → IDENT
  36: (r) => ({ kind: 'ident', name: String(tokVal(stackValueAt(r, 0))) }),
  // 37: Primary → IDENT ( Args )            (function call)
  37: (r) => ({ kind: 'call', fn: String(tokVal(stackValueAt(r, 0))), args: exprListAt(r, 2) }),
  // 38: Primary → ( Expr )
  38: (r) => stackValueAt(r, 1),
  // 39: Primary → [ Elems ]
  39: (r) => ({ kind: 'array', elements: exprListAt(r, 1) }),
  // 40: Primary → { Entries }
  40: (r) => ({ kind: 'object', entries: entryListAt(r, 1) }),

  // 41,42,43: Args
  41: () => [],
  42: (r) => stackValueAt(r, 0),
  43: (r) => stackValueAt(r, 0), // trailing comma — ignore
  // 44,45: ArgList
  44: (r) => [exprAt(r, 0)],
  45: (r) => [...exprListAt(r, 0), exprAt(r, 2)],

  // 46,47,48: Elems
  46: () => [],
  47: (r) => stackValueAt(r, 0),
  48: (r) => stackValueAt(r, 0),
  // 49,50: ElemList
  49: (r) => [exprAt(r, 0)],
  50: (r) => [...exprListAt(r, 0), exprAt(r, 2)],

  // 51,52,53: Entries
  51: () => [],
  52: (r) => stackValueAt(r, 0),
  53: (r) => stackValueAt(r, 0),
  // 54,55: EntryList
  54: (r) => [entryAt(r, 0)],
  55: (r) => [...entryListAt(r, 0), entryAt(r, 2)],
  // 56: Entry → Expr : Expr
  56: (r) => ({ key: exprAt(r, 0), value: exprAt(r, 2) }),
};

/**
 * Build the AST for `recv.name(args)`:
 * comprehension macro, receiver method, or — for an unknown method name — a
 * parse error for unknown method names.
 */
function buildCall(
  receiver: Expr,
  name: string,
  args: ExprList,
  nullSafe: boolean,
  pos: Position,
): Expr {
  if (isComprehensionKind(name)) {
    // Comprehension: first arg must be a bare identifier, second its body.
    if (args.length !== 2) {
      throw new ParseError(`CEL_PARSE: comprehension expects identifier as first argument`, pos);
    }
    const varExpr = args[0];
    if (varExpr.kind !== 'ident') {
      throw new ParseError(`CEL_PARSE: comprehension expects identifier as first argument`, pos);
    }
    return {
      kind: 'comprehension',
      kind2: name,
      receiver,
      varName: varExpr.name,
      body: args[1],
      nullSafe,
    };
  }
  if (RECEIVER_METHODS.has(name)) {
    return nullSafe
      ? { kind: 'nullSafeMethod', receiver, method: name, args }
      : { kind: 'method', receiver, method: name, args };
  }
  throw new ParseError(`CEL_PARSE: unknown method '${name}' in call`, pos);
}

// ---------------------------------------------------------------------------
// LR driver
// ---------------------------------------------------------------------------

/** Parse CEL source into a typed AST. Throws {@link ParseError} on bad input. */
export function parse(src: string): Expr {
  let tokens: Token[];
  try {
    tokens = lex(src);
  } catch (e) {
    if (e instanceof LexError) throw new ParseError(e.message, e.pos);
    throw e;
  }

  const stateStack: number[] = [0];
  const valueStack: StackVal[] = [];
  let tp = 0;

  for (;;) {
    const state = requiredAt(stateStack, stateStack.length - 1, 'parser state');
    const tok = requiredAt(tokens, tp, 'token');
    const act = TABLES.action[state]?.[tok.type];

    if (!act) {
      throw new ParseError(
        `CEL_PARSE: unexpected token '${tok.type}'` +
          (tok.type === '$end' ? ' (end of input)' : '') +
          ` at line ${tok.pos.line}, column ${tok.pos.col}`,
        tok.pos,
      );
    }

    if (act.type === 'shift') {
      stateStack.push(act.state);
      valueStack.push(tok);
      tp++;
      continue;
    }

    if (act.type === 'reduce') {
      const prod = requiredAt(TABLES.productions, act.production, 'production');
      const n = prod.length;
      const rhs = n > 0 ? valueStack.splice(valueStack.length - n, n) : [];
      if (n > 0) stateStack.splice(stateStack.length - n, n);

      const action = ACTIONS[act.production];
      /* istanbul ignore next — every production has an action */
      if (!action)
        throw new ParseError(`CEL_PARSE: no action for production ${act.production}`, tok.pos);
      const value = action(rhs);
      valueStack.push(value);

      const currentState = requiredAt(stateStack, stateStack.length - 1, 'parser state');
      const gotoState = TABLES.goto[currentState]?.[prod.lhs];
      /* istanbul ignore next — a successful reduce always has a GOTO entry */
      if (gotoState === undefined) {
        throw new ParseError(
          `CEL_PARSE: no goto for ${prod.lhs} from state ${currentState}`,
          tok.pos,
        );
      }
      stateStack.push(gotoState);
      continue;
    }

    // accept
    return exprAt(valueStack, valueStack.length - 1);
  }
}
