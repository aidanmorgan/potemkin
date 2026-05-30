/**
 * Machine-readable CEL grammar: productions + operator precedence.
 *
 * This is the formal grammar (mirroring docs/grammar/cel.grammar.md §2). It is
 * consumed by the LALR(1) table generator (`lalr.ts`) and the codegen script
 * (`scripts/gen-cel-tables.ts`). The runtime parser uses the *generated* tables
 * plus the per-production reduce actions in `parser.ts` — it does not re-read
 * this grammar at runtime, but the production list here is the authority the
 * tables and the actions are keyed against (by production index).
 */

/** A grammar symbol is either a terminal (token type) or a nonterminal name. */
export type Sym = string;

export interface Production {
  /** Left-hand side nonterminal. */
  readonly lhs: Sym;
  /** Right-hand side symbols (terminals + nonterminals), possibly empty. */
  readonly rhs: readonly Sym[];
  /**
   * Optional explicit precedence terminal for this production (yacc `%prec`).
   * Used to give the unary-minus production a precedence distinct from binary
   * `-`. When absent, the production's precedence is that of its rightmost
   * terminal (standard yacc rule).
   */
  readonly prec?: Sym;
}

export type Assoc = 'left' | 'right' | 'nonassoc';

/** Precedence levels, lowest binding first (index 0 = loosest). */
export interface PrecLevel {
  readonly assoc: Assoc;
  readonly terminals: readonly Sym[];
}

/**
 * Nonterminals of the grammar. The augmented start `S'` → `Expr $end` is added
 * by the generator.
 */
export const START: Sym = 'Expr';

/**
 * Production list. Indices are STABLE — the generated tables and the reduce
 * actions in parser.ts reference productions by their position in this array.
 * Do not reorder; append only.
 */
export const PRODUCTIONS: readonly Production[] = [
  // 0: Expr → Cond
  { lhs: 'Expr', rhs: ['Cond'] },

  // 1: Cond → Or
  { lhs: 'Cond', rhs: ['Or'] },
  // 2: Cond → Or ? Expr : Expr        (ternary)
  { lhs: 'Cond', rhs: ['Or', '?', 'Expr', ':', 'Expr'] },

  // 3: Or → Or || Or
  { lhs: 'Or', rhs: ['Or', '||', 'Or'] },
  // 4: Or → And
  { lhs: 'Or', rhs: ['And'] },

  // 5: And → And && And
  { lhs: 'And', rhs: ['And', '&&', 'And'] },
  // 6: And → Rel
  { lhs: 'And', rhs: ['Rel'] },

  // 7..13: Rel → Rel <op> Rel  (==, !=, <, <=, >, >=, in)
  { lhs: 'Rel', rhs: ['Rel', '==', 'Rel'] },   // 7
  { lhs: 'Rel', rhs: ['Rel', '!=', 'Rel'] },   // 8
  { lhs: 'Rel', rhs: ['Rel', '<',  'Rel'] },   // 9
  { lhs: 'Rel', rhs: ['Rel', '<=', 'Rel'] },   // 10
  { lhs: 'Rel', rhs: ['Rel', '>',  'Rel'] },   // 11
  { lhs: 'Rel', rhs: ['Rel', '>=', 'Rel'] },   // 12
  { lhs: 'Rel', rhs: ['Rel', 'in', 'Rel'] },   // 13
  // 14: Rel → Add
  { lhs: 'Rel', rhs: ['Add'] },

  // 15,16: Add → Add +|- Add
  { lhs: 'Add', rhs: ['Add', '+', 'Add'] },    // 15
  { lhs: 'Add', rhs: ['Add', '-', 'Add'] },    // 16
  // 17: Add → Mul
  { lhs: 'Add', rhs: ['Mul'] },

  // 18,19,20: Mul → Mul *|/|% Mul
  { lhs: 'Mul', rhs: ['Mul', '*', 'Mul'] },    // 18
  { lhs: 'Mul', rhs: ['Mul', '/', 'Mul'] },    // 19
  { lhs: 'Mul', rhs: ['Mul', '%', 'Mul'] },    // 20
  // 21: Mul → Unary
  { lhs: 'Mul', rhs: ['Unary'] },

  // 22: Unary → ! Unary
  { lhs: 'Unary', rhs: ['!', 'Unary'], prec: 'UNOT' },
  // 23: Unary → - Unary
  { lhs: 'Unary', rhs: ['-', 'Unary'], prec: 'UMINUS' },
  // 24: Unary → Postfix
  { lhs: 'Unary', rhs: ['Postfix'] },

  // 25: Postfix → Primary
  { lhs: 'Postfix', rhs: ['Primary'] },
  // 26: Postfix → Postfix . IDENT                 (member)
  { lhs: 'Postfix', rhs: ['Postfix', '.', 'IDENT'] },
  // 27: Postfix → Postfix . IDENT ( Args )         (method / comprehension)
  { lhs: 'Postfix', rhs: ['Postfix', '.', 'IDENT', '(', 'Args', ')'] },
  // 28: Postfix → Postfix ?. IDENT                 (null-safe member)
  { lhs: 'Postfix', rhs: ['Postfix', '?.', 'IDENT'] },
  // 29: Postfix → Postfix ?. IDENT ( Args )         (null-safe method/compr.)
  { lhs: 'Postfix', rhs: ['Postfix', '?.', 'IDENT', '(', 'Args', ')'] },
  // 30: Postfix → Postfix [ Expr ]                 (index)
  { lhs: 'Postfix', rhs: ['Postfix', '[', 'Expr', ']'] },
  // 31: Postfix → Postfix ?[ Expr ]                (null-safe index)
  { lhs: 'Postfix', rhs: ['Postfix', '?[', 'Expr', ']'] },

  // 32..35: Primary literals
  { lhs: 'Primary', rhs: ['NUMBER'] },   // 32
  { lhs: 'Primary', rhs: ['STRING'] },   // 33
  { lhs: 'Primary', rhs: ['BOOL'] },     // 34
  { lhs: 'Primary', rhs: ['NULL'] },     // 35
  // 36: Primary → IDENT                  (bare identifier)
  { lhs: 'Primary', rhs: ['IDENT'] },
  // 37: Primary → IDENT ( Args )          (function call)
  { lhs: 'Primary', rhs: ['IDENT', '(', 'Args', ')'] },
  // 38: Primary → ( Expr )                (grouping)
  { lhs: 'Primary', rhs: ['(', 'Expr', ')'] },
  // 39: Primary → [ Elems ]               (list literal)
  { lhs: 'Primary', rhs: ['[', 'Elems', ']'] },
  // 40: Primary → { Entries }             (map literal)
  { lhs: 'Primary', rhs: ['{', 'Entries', '}'] },

  // 41,42,43: Args
  { lhs: 'Args', rhs: [] },                       // 41 (empty)
  { lhs: 'Args', rhs: ['ArgList'] },              // 42
  { lhs: 'Args', rhs: ['ArgList', ','] },         // 43 (trailing comma)
  // 44,45: ArgList
  { lhs: 'ArgList', rhs: ['Expr'] },              // 44
  { lhs: 'ArgList', rhs: ['ArgList', ',', 'Expr'] }, // 45

  // 46,47,48: Elems
  { lhs: 'Elems', rhs: [] },                      // 46 (empty)
  { lhs: 'Elems', rhs: ['ElemList'] },            // 47
  { lhs: 'Elems', rhs: ['ElemList', ','] },       // 48 (trailing comma)
  // 49,50: ElemList
  { lhs: 'ElemList', rhs: ['Expr'] },             // 49
  { lhs: 'ElemList', rhs: ['ElemList', ',', 'Expr'] }, // 50

  // 51,52,53: Entries
  { lhs: 'Entries', rhs: [] },                    // 51 (empty)
  { lhs: 'Entries', rhs: ['EntryList'] },         // 52
  { lhs: 'Entries', rhs: ['EntryList', ','] },    // 53 (trailing comma)
  // 54,55: EntryList
  { lhs: 'EntryList', rhs: ['Entry'] },           // 54
  { lhs: 'EntryList', rhs: ['EntryList', ',', 'Entry'] }, // 55
  // 56: Entry → Expr : Expr
  { lhs: 'Entry', rhs: ['Expr', ':', 'Expr'] },   // 56
];

/**
 * Operator precedence, loosest (index 0) → tightest. Mirrors §2.1 of the
 * grammar doc. `UMINUS`/`UNOT` are pseudo-terminals used only as `%prec` tags.
 */
export const PRECEDENCE: readonly PrecLevel[] = [
  { assoc: 'right', terminals: ['?', ':'] },
  { assoc: 'left',  terminals: ['||'] },
  { assoc: 'left',  terminals: ['&&'] },
  { assoc: 'left',  terminals: ['==', '!=', '<', '<=', '>', '>=', 'in'] },
  { assoc: 'left',  terminals: ['+', '-'] },
  { assoc: 'left',  terminals: ['*', '/', '%'] },
  { assoc: 'right', terminals: ['UMINUS', 'UNOT', '!'] },
  { assoc: 'left',  terminals: ['.', '?.', '[', '?[', '('] },
];
