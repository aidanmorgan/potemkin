# CEL + DSL-template formal grammar

This document is the single source of truth for the grammar driving the
table-driven LALR(1) parser in `src/cel/grammar/`. The machine-readable form of
this grammar lives in `src/cel/grammar/grammar.ts`; the LALR(1) ACTION/GOTO
tables are generated from it by `scripts/gen-cel-tables.ts` and committed as
`src/cel/grammar/tables.generated.ts`. There is no runtime code generation.

The grammar deliberately encodes operator precedence and associativity as
**precedence declarations** (yacc/bison style) rather than as a precedence
cascade of nonterminals. Conflicts in the LALR(1) tables are resolved using
those declarations; any conflict the declarations do not resolve is a hard error
at table-generation time.

---

## 1. Lexical grammar (the lexer)

The lexer (`src/cel/grammar/lexer.ts`) is a real tokenizer: it produces a stream
of typed tokens, each carrying a 1-based `line`/`col` and absolute `offset`.
Regular expressions are used ONLY to recognise individual lexeme classes
(numbers, identifiers, the body of a string), never to parse structure.

Token classes:

```
NUMBER   = '-'? DIGIT+ ('.' DIGIT*)?          ; '-' only when it directly
                                                ; precedes a digit (see §1.1)
STRING   = '"' (ESC | [^"\])* '"'
         | "'" (ESC | [^'\])* "'"
         | 'r' '"' [^"]*  '"'                  ; raw string, no escapes
         | "r" "'" [^']*  "'"
ESC      = '\' ('n'|'t'|'r'|'\'|'"'|"'"| ANY)  ; unknown escape → the char itself
IDENT    = [A-Za-z_$] [A-Za-z0-9_$]*
BOOL     = 'true' | 'false'                    ; keyword carved out of IDENT
NULL     = 'null'                              ; keyword carved out of IDENT
```

Punctuation / operators (longest match first):

```
'==' '!=' '<=' '>=' '&&' '||' '?.' '?['        ; two-char tokens
'<' '>' '+' '-' '*' '/' '%' '!'                ; single-char operator tokens
'(' ')' '[' ']' '{' '}' ',' '.' ':' '?'        ; structural punctuation
```

Whitespace separates tokens and is otherwise insignificant. The token stream is
terminated by an end-of-input marker `$`.

### 1.1 Negative-number lexeme rule (compatibility quirk)

A `-` is lexed as part of a NUMBER lexeme **only when the character immediately
following the `-` is a digit**. Otherwise `-` is the operator token `-`. This
exactly reproduces the legacy tokenizer:

- `-42`   → one NUMBER token `-42`
- `1 - 2` → NUMBER `1`, op `-`, NUMBER `2`   (space after `-`)
- `a -2`  → IDENT `a`, NUMBER `-2`            (digit immediately after `-`)
- `-`     → op `-`                            (nothing follows)

This is a lexer-level rule, so the grammar never sees a unary-minus-on-literal
ambiguity for the common `-42` case; `-x` and `-(…)` still go through the unary
`-` production.

---

## 2. Syntactic grammar (the parser)

Start symbol `Expr`. Terminals are the token classes from §1.

```
Expr        → Cond

Cond        → Or
            | Or '?' Expr ':' Expr               ; ternary, right-assoc

Or          → Or '||' Or
            | And
And         → And '&&' And
            | Rel
Rel         → Rel '==' Rel  | Rel '!=' Rel
            | Rel '<'  Rel  | Rel '<=' Rel
            | Rel '>'  Rel  | Rel '>=' Rel
            | Rel 'in' Rel
            | Add
Add         → Add '+' Add | Add '-' Add
            | Mul
Mul         → Mul '*' Mul | Mul '/' Mul | Mul '%' Mul
            | Unary
Unary       → '!' Unary
            | '-' Unary
            | Postfix

Postfix     → Primary
            | Postfix '.' IDENT                          ; member
            | Postfix '.' IDENT '(' Args ')'             ; method / comprehension
            | Postfix '?.' IDENT                         ; null-safe member
            | Postfix '?.' IDENT '(' Args ')'            ; null-safe method/compr.
            | Postfix '[' Expr ']'                       ; index
            | Postfix '?[' Expr ']'                      ; null-safe index

Primary     → NUMBER | STRING | BOOL | NULL
            | IDENT                                      ; bare identifier
            | IDENT '(' Args ')'                         ; function call
            | '(' Expr ')'                               ; grouping
            | '[' Elems ']'                              ; list literal
            | '{' Entries '}'                            ; map literal

Args        → ε | ArgList | ArgList ','                  ; trailing comma allowed
ArgList     → Expr | ArgList ',' Expr

Elems       → ε | ElemList | ElemList ','                ; trailing comma allowed
ElemList    → Expr | ElemList ',' Expr

Entries     → ε | EntryList | EntryList ','              ; trailing comma allowed
EntryList   → Entry | EntryList ',' Entry
Entry       → Expr ':' Expr
```

### 2.1 Precedence & associativity (highest binds tightest, listed lowest→highest)

```
%right  '?' ':'                         ; ternary
%left   '||'
%left   '&&'
%left   '==' '!=' '<' '<=' '>' '>=' 'in'
%left   '+' '-'
%left   '*' '/' '%'
%right  UMINUS UNOT                     ; unary - and !
%left   '.' '?.' '[' '?[' '('          ; postfix
```

`'in'` shares the precedence/level of the relational/equality operators (this
matches the legacy cascade where `in` sat just below equality and was
left-associative). All comparison/equality/in operators are left-associative and
share one level, so `5 > 3 == true` parses as `(5 > 3) == true`.

### 2.2 Method calls, comprehensions, member access

`Postfix '.' IDENT '(' Args ')'` is reduced to one of three AST shapes by the
reduce action, exactly as the legacy parser decided at parse time:

- IDENT ∈ {`all`,`exists`,`exists_one`,`filter`,`map`} → `comprehension`
  (its `Args` must be `IDENT , Expr`; otherwise a parse error is raised).
- IDENT ∈ the receiver-method set (string/list/map methods) → `method`.
- otherwise → `member` on the result of the call's parenthesised form is **not**
  produced; an unknown `name(...)` after a `.` is still built as a `method`
  node so the evaluator can raise its existing "unknown … method" runtime error.
  (The legacy parser only built a `method` node for known method names and would
  otherwise treat `.name` as member access; to preserve identical evaluator
  errors the reduce action mirrors that decision: a `(` after `.IDENT` with an
  unknown method name is a parse error, matching the legacy "unexpected token"
  behaviour for that shape.)

`has(Expr)` is an ordinary `IDENT '(' Args ')'` call node at parse time; the
`has(...)` macro semantics are applied by the evaluator, unchanged.

---

## 3. DSL value-template grammar

A DSL value is any YAML scalar. Only **strings** are templated; non-strings pass
through unchanged. The template is tokenised by a dedicated template lexer
(`src/cel/grammar/templateLexer.ts`) into three lexeme classes and parsed by the
template grammar (no regex structural scan):

```
TextChunk  = run of characters containing no '${' and no '$${'
ExprOpen   = '${'      ; opens a CEL interpolation; the matching '}' is found by
                         brace-depth counting in the lexer (so '${' may contain
                         nested '{' '}' and quoted strings)
EscOpen    = '$${'     ; opens an escaped literal; emits literal '${' + body + '}'
```

Template grammar:

```
Template   → Part*
Part       → TEXT                       ; literal text
           | EXPR                       ; ${ CEL-source } → evaluate, splice
           | ESCAPED                    ; $${ body }      → literal "${body}"
```

Evaluation (identical to legacy `planDslValue` semantics):

- No `${` and no `$${` in the string → the **whole string** is treated as a bare
  CEL expression and evaluated (backward compatibility).
- Exactly one `EXPR` part and nothing else → evaluate it and **preserve the CEL
  return type** (number stays number, etc.).
- All parts are TEXT/ESCAPED (no EXPR) → concatenate into a literal string.
- Mixed → evaluate each EXPR, coerce to string (`null`/`undefined` → `''`),
  concatenate with the literal text in order.

The CEL source inside an `EXPR` part is handed to the CEL parser of §2.

---

## 4. Files

| File | Role |
| --- | --- |
| `docs/grammar/cel.grammar.md` | this document (the formal grammar) |
| `src/cel/grammar/lexer.ts` | CEL lexer (positioned tokens) |
| `src/cel/grammar/grammar.ts` | machine-readable grammar + precedence |
| `src/cel/grammar/lalr.ts` | LALR(1) table generator (dev/codegen use) |
| `scripts/gen-cel-tables.ts` | writes `tables.generated.ts` from the grammar |
| `src/cel/grammar/tables.generated.ts` | committed ACTION/GOTO tables |
| `src/cel/grammar/parser.ts` | table-driven LR driver → typed AST |
| `src/cel/grammar/ast.ts` | typed AST node definitions |
| `src/cel/grammar/templateLexer.ts` | DSL `${}` template lexer |
| `src/cel/grammar/template.ts` | DSL template parse → typed template AST |
