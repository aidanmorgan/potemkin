/**
 * Table-driven LR parser for CEL.
 *
 * Consumes the committed LALR(1) ACTION/GOTO tables (`tables.generated.ts`) and
 * the lexer's positioned token stream, running the standard shift/reduce LR
 * driver. Each reduction invokes a per-production semantic action that builds
 * the typed AST (`ast.ts`). The AST is byte-for-byte the shape the legacy
 * recursive-descent parser produced, so the evaluator is unchanged.
 *
 * Parse errors carry 1-based line/column positions (see {@link ParseError}).
 */

import { lex, LexError, type Token, type Position } from './lexer.js';
import { TABLES } from './tables.generated.js';
import {
  RECEIVER_METHODS, COMPREHENSION_METHODS,
  type Expr, type ComprehensionKind,
} from './ast.js';

/** Parse error carrying a source position (1-based line/col). */
export class ParseError extends Error {
  constructor(message: string, readonly pos: Position) {
    super(message);
    this.name = 'ParseError';
  }
}

// ---------------------------------------------------------------------------
// Semantic-value types on the parse stack
// ---------------------------------------------------------------------------

/** Intermediate value for `Entry → Expr : Expr`. */
interface EntryVal { key: Expr; value: Expr }
/** A trailing-comma-tolerant list builder used for Args/Elems/Entries bodies. */
type ExprList = Expr[];
type EntryList = EntryVal[];

/** Anything a reduce action can leave on the value stack. */
type StackVal = Token | Expr | ExprList | EntryList | EntryVal | string;

// ---------------------------------------------------------------------------
// Reduce actions, indexed by production number (must match grammar.ts).
// Each action receives the slice of semantic values for the production's RHS
// (left-to-right) and returns the LHS semantic value.
// ---------------------------------------------------------------------------

const tokVal = (t: StackVal): string | number | boolean =>
  (t as Token).value as string | number | boolean;

type Action = (rhs: StackVal[]) => StackVal;

const ACTIONS: Record<number, Action> = {
  // 0: Expr → Cond
  0: (r) => r[0]!,

  // 1: Cond → Or
  1: (r) => r[0]!,
  // 2: Cond → Or ? Expr : Expr
  2: (r) => ({ kind: 'ternary', cond: r[0] as Expr, then: r[2] as Expr, else: r[4] as Expr }),

  // 3: Or → Or || Or
  3: (r) => ({ kind: 'binary', op: '||', left: r[0] as Expr, right: r[2] as Expr }),
  // 4: Or → And
  4: (r) => r[0]!,
  // 5: And → And && And
  5: (r) => ({ kind: 'binary', op: '&&', left: r[0] as Expr, right: r[2] as Expr }),
  // 6: And → Rel
  6: (r) => r[0]!,

  // 7..13: Rel → Rel <op> Rel
  7:  (r) => ({ kind: 'binary', op: '==', left: r[0] as Expr, right: r[2] as Expr }),
  8:  (r) => ({ kind: 'binary', op: '!=', left: r[0] as Expr, right: r[2] as Expr }),
  9:  (r) => ({ kind: 'binary', op: '<',  left: r[0] as Expr, right: r[2] as Expr }),
  10: (r) => ({ kind: 'binary', op: '<=', left: r[0] as Expr, right: r[2] as Expr }),
  11: (r) => ({ kind: 'binary', op: '>',  left: r[0] as Expr, right: r[2] as Expr }),
  12: (r) => ({ kind: 'binary', op: '>=', left: r[0] as Expr, right: r[2] as Expr }),
  13: (r) => ({ kind: 'binary', op: 'in', left: r[0] as Expr, right: r[2] as Expr }),
  // 14: Rel → Add
  14: (r) => r[0]!,

  // 15,16: Add → Add +|- Add
  15: (r) => ({ kind: 'binary', op: '+', left: r[0] as Expr, right: r[2] as Expr }),
  16: (r) => ({ kind: 'binary', op: '-', left: r[0] as Expr, right: r[2] as Expr }),
  // 17: Add → Mul
  17: (r) => r[0]!,

  // 18,19,20: Mul → Mul *|/|% Mul
  18: (r) => ({ kind: 'binary', op: '*', left: r[0] as Expr, right: r[2] as Expr }),
  19: (r) => ({ kind: 'binary', op: '/', left: r[0] as Expr, right: r[2] as Expr }),
  20: (r) => ({ kind: 'binary', op: '%', left: r[0] as Expr, right: r[2] as Expr }),
  // 21: Mul → Unary
  21: (r) => r[0]!,

  // 22: Unary → ! Unary
  22: (r) => ({ kind: 'unary', op: '!', operand: r[1] as Expr }),
  // 23: Unary → - Unary
  23: (r) => ({ kind: 'unary', op: '-', operand: r[1] as Expr }),
  // 24: Unary → Postfix
  24: (r) => r[0]!,

  // 25: Postfix → Primary
  25: (r) => r[0]!,
  // 26: Postfix → Postfix . IDENT          (member)
  26: (r) => ({ kind: 'member', obj: r[0] as Expr, key: { kind: 'literal', value: String(tokVal(r[2]!)) } }),
  // 27: Postfix → Postfix . IDENT ( Args )  (method / comprehension)
  27: (r) => buildCall(r[0] as Expr, String(tokVal(r[2]!)), r[4] as ExprList, false, (r[2] as Token).pos),
  // 28: Postfix → Postfix ?. IDENT          (null-safe member)
  28: (r) => ({ kind: 'nullSafeMember', obj: r[0] as Expr, key: { kind: 'literal', value: String(tokVal(r[2]!)) } }),
  // 29: Postfix → Postfix ?. IDENT ( Args )  (null-safe method/comprehension)
  29: (r) => buildCall(r[0] as Expr, String(tokVal(r[2]!)), r[4] as ExprList, true, (r[2] as Token).pos),
  // 30: Postfix → Postfix [ Expr ]          (index)
  30: (r) => ({ kind: 'member', obj: r[0] as Expr, key: r[2] as Expr }),
  // 31: Postfix → Postfix ?[ Expr ]         (null-safe index)
  31: (r) => ({ kind: 'nullSafeMember', obj: r[0] as Expr, key: r[2] as Expr }),

  // 32..35: literals
  32: (r) => ({ kind: 'literal', value: tokVal(r[0]!) as number }),
  33: (r) => ({ kind: 'literal', value: tokVal(r[0]!) as string }),
  34: (r) => ({ kind: 'literal', value: tokVal(r[0]!) as boolean }),
  35: () => ({ kind: 'literal', value: null }),
  // 36: Primary → IDENT
  36: (r) => ({ kind: 'ident', name: String(tokVal(r[0]!)) }),
  // 37: Primary → IDENT ( Args )            (function call)
  37: (r) => ({ kind: 'call', fn: String(tokVal(r[0]!)), args: r[2] as ExprList }),
  // 38: Primary → ( Expr )
  38: (r) => r[1]!,
  // 39: Primary → [ Elems ]
  39: (r) => ({ kind: 'array', elements: r[1] as ExprList }),
  // 40: Primary → { Entries }
  40: (r) => ({ kind: 'object', entries: r[1] as EntryList }),

  // 41,42,43: Args
  41: () => [],
  42: (r) => r[0]!,
  43: (r) => r[0]!,                                       // trailing comma — ignore
  // 44,45: ArgList
  44: (r) => [r[0] as Expr],
  45: (r) => [...(r[0] as ExprList), r[2] as Expr],

  // 46,47,48: Elems
  46: () => [],
  47: (r) => r[0]!,
  48: (r) => r[0]!,
  // 49,50: ElemList
  49: (r) => [r[0] as Expr],
  50: (r) => [...(r[0] as ExprList), r[2] as Expr],

  // 51,52,53: Entries
  51: () => [],
  52: (r) => r[0]!,
  53: (r) => r[0]!,
  // 54,55: EntryList
  54: (r) => [r[0] as EntryVal],
  55: (r) => [...(r[0] as EntryList), r[2] as EntryVal],
  // 56: Entry → Expr : Expr
  56: (r) => ({ key: r[0] as Expr, value: r[2] as Expr }),
};

/**
 * Build the AST for `recv.name(args)`, mirroring the legacy parser's decision:
 * comprehension macro, receiver method, or — for an unknown method name — a
 * parse error (the legacy parser never built a call node for unknown method
 * names, so the shape `recv.unknown(...)` was a parse error there too).
 */
function buildCall(
  receiver: Expr,
  name: string,
  args: ExprList,
  nullSafe: boolean,
  pos: Position,
): Expr {
  if (COMPREHENSION_METHODS.has(name as ComprehensionKind)) {
    // Comprehension: first arg must be a bare identifier, second its body.
    if (args.length !== 2) {
      throw new ParseError(
        `CEL_PARSE: comprehension expects identifier as first argument`, pos,
      );
    }
    const varExpr = args[0]!;
    if (varExpr.kind !== 'ident') {
      throw new ParseError(
        `CEL_PARSE: comprehension expects identifier as first argument`, pos,
      );
    }
    return {
      kind: 'comprehension',
      kind2: name as ComprehensionKind,
      receiver,
      varName: varExpr.name,
      body: args[1]!,
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
    const state = stateStack[stateStack.length - 1]!;
    const tok = tokens[tp]!;
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
      const prod = TABLES.productions[act.production]!;
      const n = prod.length;
      const rhs = n > 0 ? valueStack.splice(valueStack.length - n, n) : [];
      if (n > 0) stateStack.splice(stateStack.length - n, n);

      const action = ACTIONS[act.production];
      /* istanbul ignore next — every production has an action */
      if (!action) throw new ParseError(`CEL_PARSE: no action for production ${act.production}`, tok.pos);
      const value = action(rhs);
      valueStack.push(value);

      const gotoState = TABLES.goto[stateStack[stateStack.length - 1]!]?.[prod.lhs];
      /* istanbul ignore next — a successful reduce always has a GOTO entry */
      if (gotoState === undefined) {
        throw new ParseError(`CEL_PARSE: no goto for ${prod.lhs} from state ${stateStack[stateStack.length - 1]}`, tok.pos);
      }
      stateStack.push(gotoState);
      continue;
    }

    // accept
    return valueStack[valueStack.length - 1] as Expr;
  }
}
