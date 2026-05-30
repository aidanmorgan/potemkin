# Implementation Plan: LALR(1) parser for CEL + DSL templates (potemkin-57e)

Replace the hand-rolled recursive-descent CEL parser and the regex/char-scan
`${...}` template parsing with a formal-grammar-driven, table-driven LALR(1)
parser. Behaviour must be IDENTICAL.

## Stage 1: Grammar doc + real lexer
**Goal**: Formal grammar document; a positioned lexer (token types + line/col).
**Success**: lexer reproduces every token the old `tokenize()` produced, incl. the
negative-number quirk (`-42` is one number token only when `-` directly precedes a
digit) and raw strings; carries line/col; lexer unit tests green.
**Status**: Complete

## Stage 2: LALR(1) generator + committed tables
**Goal**: Grammar as productions+precedence; an LALR(1) generator (dev-time) that
emits ACTION/GOTO tables; commit generated tables to src/.
**Success**: generator builds conflict-free tables (precedence-resolved); codegen
script writes `tables.generated.ts`; generator unit tests green.
**Status**: Complete

## Stage 3: Table-driven parser → typed AST
**Goal**: LR driver consuming tables, producing the existing `Expr` AST via
per-production reduce actions. Parse errors carry line/col.
**Success**: parser produces ASTs structurally identical to the old parser for the
whole behaviour surface.
**Status**: Complete

## Stage 4: Evaluator integration
**Goal**: evaluator.ts uses the new parser; delete old tokenize/Parser; keep
evalExpr/builtins untouched.
**Success**: all existing cel unit/integration/property tests green.
**Status**: Complete

## Stage 5: DSL template grammar + remove regex
**Goal**: `${expr}` / `prefix-${e}-suffix` / `$${literal}` parsed by a template
lexer+grammar (not regex structural scan). celInterpolation bare-reference scan
rebuilt on the lexer (lexeme regex only).
**Success**: evaluateDslValue + celInterpolation tests green; no structural regex
remains.
**Status**: Complete

## Stage 6: Grammar-level tests + final gates
**Goal**: add tests for precedence, associativity, nested `${}`, quoted-literal
tokens, error line/col.
**Success**: `npx jest` green, `npm run test:bdd` green, `npx tsc --noEmit` clean.
**Status**: Complete
