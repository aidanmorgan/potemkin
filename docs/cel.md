# CEL Language Reference

## 1. What Is CEL?

CEL is the expression language embedded throughout the Specmatic Stateful Simulation Engine. Wherever the DSL accepts a quoted string that will be interpreted at runtime — match conditions, event payload templates, reducer `assign`/`append` values, `query_mapping` filters — that string is a CEL expression.

```yaml
# match condition
condition: "command.payload.amount > 0 && state.status != 'SETTLED'"

# payload template field
openedAt: "$now()"

# reducer assign
status: "state.balance - event.payload.amount == 0 ? 'SETTLED' : 'ACTIVE'"
```

This implementation is based on [Google Common Expression Language](https://github.com/google/cel-spec) but is a hand-rolled recursive-descent interpreter specific to this engine. It operates on JSON-native values (`string`, `number`, `bool`, `null`, `list`, `map`) rather than proto messages. Several extensions have been added and several upstream features have been intentionally omitted. Divergences are called out throughout this document and summarised in [Section 15](#15-compatibility-with-upstream-google-cel).

### Where CEL appears in the DSL

See `docs/dsl.md` for the full list of DSL fields that accept CEL strings. Key locations:

| DSL field | CEL phase |
|---|---|
| `behaviors[].match.condition` | Behavior |
| `behaviors[].match.requires[].expression` | Behavior |
| `behaviors[].postcondition` | Behavior |
| `behaviors[].dispatch_commands[].condition` | Behavior |
| `event_catalog[].payload_template.*` | EventHydration |
| `identity.creation.generate` | EventHydration |
| `reducers[].assign.*` | Reducer |
| `reducers[].append.*` | Reducer |

---

## 2. Lexical Structure

### 2.1 Whitespace and Line Endings

All Unicode whitespace characters (space, tab, newline, carriage return) are ignored between tokens. CEL expressions in the DSL are single-line YAML strings, but the evaluator itself accepts multi-line input.

### 2.2 Comments

This implementation does **not** support comments inside CEL expressions. The `//` character sequence is a tokenizer error. CEL strings in YAML may have YAML comments (`#`) outside the string value.

### 2.3 Identifiers

An identifier starts with `[a-zA-Z_$]` and continues with `[a-zA-Z0-9_$]`. The `$` prefix is used exclusively for engine-provided builtins (`$uuidv7`, `$now`, `$concat`).

Reserved words that cannot be used as identifiers: `true`, `false`, `null`, `in`.

### 2.4 Literals

#### Integer

Decimal integer sequences: `42`, `0`, `100`. The tokenizer parses all numeric literals through `parseFloat` — the type `int` vs `double` is determined at runtime by `Number.isInteger`.

Negative integer literals: the unary `-` operator applied to a positive literal, e.g. `-7`. This is **not** a separate token; see [Section 4](#4-operators).

#### Double

Any numeric literal containing a decimal point: `3.14`, `-0.5`, `1.0`.

#### String

Single-quoted or double-quoted. Both forms accept the same escape sequences:

| Escape | Meaning |
|---|---|
| `\n` | newline |
| `\t` | tab |
| `\r` | carriage return |
| `\\` | backslash |
| `\"` | double quote |
| `\'` | single quote |
| `\x` (other) | literal `x` |

```cel
"hello\nworld"
'it\'s fine'
```

#### Raw Strings

Prefixed with `r` before the opening quote. Backslash sequences are not interpreted:

```cel
r"[0-9]+"          // regex pattern — backslashes not doubled
r'\path\to\file'   // literal backslashes
```

Raw strings are an extension not present in upstream CEL.

#### Boolean

`true` and `false` (lowercase only).

#### Null

`null` (lowercase only).

#### List Literals

```cel
[1, 2, 3]
["a", "b", "c"]
[]
[[1, 2], [3, 4]]   // nested
[1, 2, 3,]         // trailing comma allowed
```

#### Map Literals

Keys must be expressions that evaluate to strings. Bare identifiers as keys are **not** supported; use quoted strings.

```cel
{"status": "ACTIVE", "balance": 0}
{}
{"outer": {"inner": 99}}
{"a": 1, "b": 2,}    // trailing comma allowed
```

> ⚠️ `{status: "ACTIVE"}` is a parse error. Map keys must be quoted string expressions.

---

## 3. Type System

### 3.1 Type Names

The `type(x)` function returns a `string` identifying the runtime type:

| CEL type name | JavaScript backing | Notes |
|---|---|---|
| `"null"` | `null` or `undefined` | |
| `"bool"` | `boolean` | |
| `"int"` | `number` where `Number.isInteger` is true | |
| `"double"` | `number` where `Number.isInteger` is false | |
| `"string"` | `string` | |
| `"bytes"` | `number[]` with all elements 0–255 and integer | Returned by `bytes()` |
| `"list"` | `Array` (not bytes) | |
| `"map"` | non-array, non-null `object` | |
| `"unknown"` | anything else | Should not arise in practice |

### 3.2 No Implicit Coercion

CEL does not coerce types. A number is never equal to its string representation. The arithmetic operators do not coerce operands.

```cel
1 == "1"      // false — different types
1 == 1.0      // false — int vs double (different Number.isInteger result)
```

> ⚠️ `1 == 1.0` evaluates to `false`. Both sides must be the same numeric type. Use `double(1) == 1.0` or `int(1.0) == 1` to compare across numeric kinds.

The single exception: the `+` operator concatenates strings when **either** operand is a string:

```cel
"count: " + string(42)   // "count: 42"
```

### 3.3 Deep Structural Equality

The `==` and `!=` operators implement deep structural equality. See [Section 4](#4-operators) for details.

---

## 4. Operators

### 4.1 Operator Table

| Operator | Arity | Precedence (high = binds tighter) | Associativity | Example |
|---|---|---|---|---|
| `!` | unary prefix | 8 | right | `!active` |
| `-` | unary prefix | 8 | right | `-amount` |
| `*` `/` `%` | binary | 7 | left | `a * b` |
| `+` `-` | binary | 6 | left | `a + b` |
| `<` `<=` `>` `>=` | binary | 5 | left | `x > 0` |
| `==` `!=` | binary | 4 | left | `x == y` |
| `in` | binary | 4 | left | `"k" in m` |
| `&&` | binary | 3 | left | `a && b` |
| `\|\|` | binary | 2 | left | `a \|\| b` |
| `?:` | ternary | 1 | right | `c ? a : b` |

### 4.2 Arithmetic Operators

`+`, `-`, `*`, `/`, `%` operate on numbers. `+` additionally performs string concatenation when either operand is a string.

**Division by zero** throws `CEL_RUNTIME_ERROR: divide by zero`.

**Modulo sign** follows JavaScript's truncated-division semantics, which matches the CEL specification: the result has the same sign as the dividend.

```cel
10 % 3    // 1
-7 % 3    // -1  (sign follows dividend)
7 % -3    // 1   (sign follows dividend)
```

### 4.3 Comparison Operators

`<`, `<=`, `>`, `>=` operate on numbers via JavaScript's native comparison. String ordering is not directly supported by these operators; use `str.lowerAscii()` or explicit index checks.

### 4.4 Equality Operators

`==` and `!=` use deep structural equality:

1. If `a === b` (JavaScript strict identity), they are equal.
2. If either is `null` or `undefined`, they are only equal if both are.
3. If both are arrays of the same length with pairwise equal elements, they are equal.
4. If both are non-null, non-array objects with identical key sets and pairwise equal values, they are equal.

```cel
[1, 2] == [1, 2]         // true
{"a": 1} == {"a": 1}     // true
{"a": 1} != {"a": 2}     // true
1 == 1.0                 // false — int vs double
```

### 4.5 The `in` Operator

`value in collection` — tests membership.

- When `collection` is a **list**: returns `true` if any element deep-equals `value`.
- When `collection` is a **map**: returns `true` if `value` (must be a string) is a key.
- Other right-hand types throw `CEL_EVAL`.

```cel
"a" in ["a", "b"]        // true
"key" in {"key": 1}      // true
3 in [1, 2, 3, 4]        // true
```

`in` is not an iteration construct. For iteration use comprehensions (Section 7).

### 4.6 Logical Short-Circuit

`&&` evaluates the right operand only when the left is truthy. `||` evaluates the right operand only when the left is falsy. This means a failing expression on the non-evaluated side does not cause an error:

```cel
false && (1/0 > 0)    // false — right side never evaluated
true  || (1/0 > 0)    // true  — right side never evaluated
```

### 4.7 Ternary Operator

`condition ? then_expr : else_expr`

Only the selected branch is evaluated:

```cel
state.balance == 0 ? "SETTLED" : "ACTIVE"
x > 0 ? x : -x
```

Ternary is right-associative, allowing chaining:

```cel
x == 1 ? "one" : x == 2 ? "two" : "other"
```

---

## 5. Member Access

### 5.1 Dot Access

`a.b` accesses the field `b` of map `a`. Throws `CEL_EVAL` if `a` is not a map or if `b` is not a string key.

```cel
command.payload.amount
state.transactions
event.payload.customerId
```

### 5.2 Index Access

`a[expr]` indexes into a list or map.

- **List**: `expr` must evaluate to a non-negative integer within bounds. Out-of-bounds throws `CEL_RUNTIME_ERROR: index out of range`.
- **Map**: `expr` must evaluate to a string key.

```cel
tags[0]
headers["x-trace-id"]
state.transactions[0].amount
```

Negative indices are not supported and throw a range error.

### 5.3 Null-Safe Dot Access `?.`

`a?.b` returns `null` if `a` is `null` or `undefined`; otherwise evaluates to `a.b`. When `a` is a non-null map but `b` is absent, the result is `null` (not an error).

```cel
state?.metadata?.tags     // null if metadata or tags is absent
command?.headers?.["x-trace-id"]   // chained
```

### 5.4 Null-Safe Index Access `?[`

`a?[expr]` returns `null` if `a` is `null` or `undefined`, or if the index is out of bounds. Otherwise evaluates to `a[expr]`.

```cel
tags?[0]             // null if tags is null or empty
headers?["x-trace-id"]   // null if headers is null or key absent
```

### 5.5 Chaining

Null-safe and regular access can be combined freely:

```cel
state?.metadata?.tags?[0]
command.payload?.address?.street
```

Once a null-safe step produces `null`, all subsequent `?.` and `?[` steps on that result also short-circuit to `null`. However, a plain `.` or `[` after a `null` will throw.

> ⚠️ `state?.foo.bar` — if `foo` is absent, `state?.foo` returns `null`, and then `.bar` on `null` throws `CEL_EVAL`. Use `state?.foo?.bar` for fully null-safe chaining.

---

## 6. Function and Method Calls

### 6.1 Free Function Call Syntax

Top-level functions are called with parentheses:

```cel
size(items)
int("42")
coalesce(a, b, 0)
$uuidv7()
```

### 6.2 Receiver Method Call Syntax

Methods are called on a receiver via dot notation:

```cel
"hello".startsWith("h")
state.transactions.filter(t, t.amount > 0)
[1, 2, 3].sort()
```

### 6.3 Null-Safe Method Call `?.method(...)`

If the receiver is `null` or `undefined`, the method call short-circuits to `null`:

```cel
state?.metadata?.tags?.contains("vip")   // null if chain is broken
lst?.size()                               // null if lst is null
```

---

## 7. Comprehensions (Macros)

Comprehensions are special method calls that introduce a scoped iteration variable. The receiver must be a list or map.

**When the receiver is a map**, iteration is over the map's **keys** (strings), not its values.

### 7.1 Macro Reference

| Macro | Signature | Returns | Empty input |
|---|---|---|---|
| `all` | `lst.all(x, predicate)` | `bool` | `true` (vacuous truth) |
| `exists` | `lst.exists(x, predicate)` | `bool` | `false` |
| `exists_one` | `lst.exists_one(x, predicate)` | `bool` | `false` |
| `filter` | `lst.filter(x, predicate)` | `list` | `[]` |
| `map` | `lst.map(x, transform)` | `list` | `[]` |

### 7.2 `all`

Returns `true` if `predicate` is truthy for every element. Returns `true` on an empty list (vacuous truth). Short-circuits on the first falsy element.

```cel
[1, 2, 3].all(x, x > 0)                          // true
state.transactions.all(t, t.amount < 1000)        // true if all amounts < 1000
[1, -1, 3].all(x, x > 0)                         // false — short-circuits at -1
```

### 7.3 `exists`

Returns `true` if `predicate` is truthy for at least one element. Short-circuits on the first truthy element.

```cel
state.tags.exists(t, t == "vip")
state.transactions.exists(tx, tx.kind == "DISBURSEMENT" && tx.amount > 1000)
```

### 7.4 `exists_one`

Returns `true` if `predicate` is truthy for **exactly one** element.

```cel
state.transactions.exists_one(t, t.kind == "DISBURSEMENT")
```

### 7.5 `filter`

Returns a new list containing only elements for which `predicate` is truthy. Preserves order.

```cel
state.transactions.filter(t, t.kind == "DISBURSEMENT")
items.filter(x, x > threshold)
```

### 7.6 `map`

Returns a new list where each element is the result of evaluating `transform` with the iteration variable bound to each source element.

```cel
state.transactions.map(t, t.amount)
command.payload.tags.map(tag, tag.lowerAscii())
[1, 2, 3].map(x, x * x)
```

### 7.7 Scoping and Shadowing

The iteration variable is bound in a new inner scope for the duration of the comprehension body. It shadows any identically named outer variable.

```cel
// 'x' in the inner body shadows any outer 'x' in ctx
items.map(x, x * 2)
```

Nested comprehensions each introduce their own scope:

```cel
[[1, 2], [3, 4]].map(row, row.map(x, x * 10))
// 'row' bound in outer; 'x' bound in inner; no collision
```

### 7.8 Null-Safe Comprehensions

Prefix the receiver access with `?.` to short-circuit the entire comprehension to `null` when the receiver is `null`:

```cel
lst?.filter(x, x > 0)     // null if lst is null; filtered list otherwise
lst?.map(x, x * 2)        // null if lst is null
lst?.all(x, x > 0)        // null if lst is null
lst?.exists(x, x > 5)     // null if lst is null
lst?.exists_one(x, x == 2) // null if lst is null
```

Combine with `coalesce` to get a safe default:

```cel
coalesce(lst?.filter(x, x > 0), [])   // empty list when lst is null
```

---

## 8. Built-in Standard Library

Phase abbreviations used throughout: **B** = Behavior, **H** = EventHydration, **R** = Reducer.

### 8.1 Type Conversions

Source: `src/cel/builtins.ts`

| Function | Signature | Returns | Phases | Notes |
|---|---|---|---|---|
| `int` | `int(x)` | `int` | B, H, R | Truncates doubles; parses strings; `bool` → 0/1. Throws `CEL_TYPE_ERROR` for unconvertible input. |
| `double` | `double(x)` | `double` | B, H, R | Converts number or parses string. `bool` → 0/1. |
| `string` | `string(x)` | `string` | B, H, R | Converts any value. `null` → `"null"`. |
| `bool` | `bool(x)` | `bool` | B, H, R | Parses `"true"`/`"false"` strings; number `0` → `false`, non-zero → `true`. Throws on other strings. |
| `bytes` | `bytes(x)` | `list[int]` | B, H, R | Returns UTF-16 code units (0–255) for each character. Throws if not a string. |

```cel
int("42")        // 42
int(3.7)         // 3  (truncated)
int(true)        // 1
double("3.14")   // 3.14
string(42)       // "42"
string(null)     // "null"
bool("true")     // true
bool(0)          // false
bytes("abc")     // [97, 98, 99]
```

### 8.2 Math

Source: `src/cel/builtins.ts`

| Function | Signature | Returns | Phases | Notes |
|---|---|---|---|---|
| `abs` | `abs(x)` | `number` | B, H, R | Absolute value. |
| `min` | `min(a, b, ...)` or `min(list)` | `number` | B, H, R | Minimum of arguments or a single list. |
| `max` | `max(a, b, ...)` or `max(list)` | `number` | B, H, R | Maximum of arguments or a single list. |
| `floor` | `floor(x)` | `int` | B, H, R | Floor toward negative infinity. |
| `ceil` | `ceil(x)` | `int` | B, H, R | Ceiling toward positive infinity. |
| `round` | `round(x)` | `int` | B, H, R | Round to nearest integer (half-up). |
| `pow` | `pow(a, b)` | `number` | B, H, R | `a` raised to the power `b`. |
| `sqrt` | `sqrt(x)` | `number` | B, H, R | Square root. Throws `CEL_RUNTIME_ERROR` for negative input. |

```cel
abs(-5)          // 5
min(3, 1, 2)     // 1
max([10, 20, 5]) // 20  (list form)
floor(3.9)       // 3
ceil(3.1)        // 4
round(3.5)       // 4
pow(2, 8)        // 256
sqrt(9)          // 3
```

### 8.3 Collections

Source: `src/cel/builtins.ts`

| Function | Signature | Returns | Phases | Notes |
|---|---|---|---|---|
| `size` | `size(x)` | `int` | B, H, R | Length of string, list, or key count of map. |
| `keys` | `keys(m)` | `list[string]` | B, H, R | Keys of map `m` as a list. |
| `values` | `values(m)` | `list` | B, H, R | Values of map `m` as a list. |
| `range` | `range(end)` | `list[int]` | B, H, R | `[0, 1, ..., end-1]`. |
| `range` | `range(start, end)` | `list[int]` | B, H, R | `[start, ..., end-1]`. |

```cel
size("hello")           // 5
size([1, 2, 3])         // 3
size({"a": 1, "b": 2}) // 2
keys({"a": 1, "b": 2}) // ["a", "b"]
values({"a": 1})        // [1]
range(5)                // [0, 1, 2, 3, 4]
range(2, 5)             // [2, 3, 4]
range(0)                // []
```

### 8.4 String Methods

All string methods are called as receiver methods: `str.method(...)`.

Source: `src/cel/evaluator.ts` (`evalStringMethod`)

| Method | Signature | Returns | Phases | Notes |
|---|---|---|---|---|
| `startsWith` | `str.startsWith(prefix)` | `bool` | B, H, R | True if `str` begins with `prefix`. |
| `endsWith` | `str.endsWith(suffix)` | `bool` | B, H, R | True if `str` ends with `suffix`. |
| `contains` | `str.contains(sub)` | `bool` | B, H, R | True if `sub` appears anywhere in `str`. |
| `size` | `str.size()` | `int` | B, H, R | Length in UTF-16 code units. |
| `matches` | `str.matches(pattern)` | `bool` | B, H, R | True if `str` matches regex `pattern`. See note below. |
| `replace` | `str.replace(old, new)` | `string` | B, H, R | Replaces all occurrences of `old` with `new`. |
| `replace` | `str.replace(old, new, n)` | `string` | B, H, R | Replaces up to `n` occurrences (integer). |
| `split` | `str.split(sep)` | `list[string]` | B, H, R | Splits on literal separator `sep`. |
| `substring` | `str.substring(start)` | `string` | B, H, R | Returns suffix from `start` (inclusive). |
| `substring` | `str.substring(start, end)` | `string` | B, H, R | Returns `str[start..end)`. |
| `indexOf` | `str.indexOf(sub)` | `int` | B, H, R | First index of `sub`, or `-1`. |
| `lastIndexOf` | `str.lastIndexOf(sub)` | `int` | B, H, R | Last index of `sub`, or `-1`. |
| `lowerAscii` | `str.lowerAscii()` | `string` | B, H, R | Converts to lowercase. |
| `upperAscii` | `str.upperAscii()` | `string` | B, H, R | Converts to uppercase. |
| `trim` | `str.trim()` | `string` | B, H, R | Strips leading and trailing whitespace. |
| `trimStart` | `str.trimStart()` | `string` | B, H, R | Strips leading whitespace only. |
| `trimEnd` | `str.trimEnd()` | `string` | B, H, R | Strips trailing whitespace only. |
| `charAt` | `str.charAt(i)` | `string` | B, H, R | Character at index `i`. Throws if out of range. |

**Regex format for `matches`**: the `pattern` argument is passed directly to JavaScript's `RegExp` constructor. Use standard JS regex syntax without delimiters (`[0-9]+`, not `/[0-9]+/`). Use raw strings (`r"..."`) to avoid double-escaping backslashes in YAML:

```cel
"LOAN-12345".matches("^LOAN-[0-9]+")        // true
state.label.matches(r"^LOAN-\d+$")          // raw string — no double-escaping
"user@example.com".matches(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")  // true
"ACTIVE".matches("ACTIVE|DRAFT|SETTLED")    // true
```

```cel
"hello".startsWith("hel")           // true
"world".endsWith("ld")              // true
"hello world".contains("world")     // true
"hello".size()                      // 5
"aabbcc".replace("b", "X")         // "aaXXcc"
"aaaa".replace("a", "b", 2)        // "bbaa"
"a,b,c".split(",")                  // ["a", "b", "c"]
"hello world".substring(6)          // "world"
"hello world".substring(0, 5)       // "hello"
"abcabc".indexOf("b")              // 1
"abcabc".lastIndexOf("b")          // 4
"HELLO".lowerAscii()               // "hello"
"hello".upperAscii()               // "HELLO"
"  hello  ".trim()                 // "hello"
"  hello  ".trimStart()            // "hello  "
"  hello  ".trimEnd()              // "  hello"
"hello".charAt(1)                  // "e"
```

### 8.5 List Methods

All list methods are called as receiver methods: `lst.method(...)`.

Source: `src/cel/evaluator.ts` (`evalListMethod`)

| Method | Signature | Returns | Phases | Notes |
|---|---|---|---|---|
| `size` | `lst.size()` | `int` | B, H, R | Number of elements. |
| `contains` | `lst.contains(v)` | `bool` | B, H, R | True if any element deep-equals `v`. |
| `indexOf` | `lst.indexOf(v)` | `int` | B, H, R | First index of `v` (deep equality), or `-1`. |
| `lastIndexOf` | `lst.lastIndexOf(v)` | `int` | B, H, R | Last index of `v` (deep equality), or `-1`. |
| `sort` | `lst.sort()` | `list` | B, H, R | Sorted copy. Numbers by value; strings lexicographically; booleans false < true. Non-destructive. |
| `reverse` | `lst.reverse()` | `list` | B, H, R | Reversed copy. Non-destructive. |
| `join` | `lst.join(sep)` | `string` | B, H, R | Joins string elements with separator `sep`. Elements are coerced via `String(v)`. |
| `flatten` | `lst.flatten()` | `list` | B, H, R | One level of nesting removed. Does not recurse. |
| `distinct` | `lst.distinct()` | `list` | B, H, R | Removes duplicates (deep equality), preserving first occurrence. |

```cel
[1, 2, 3].size()                  // 3
[1, 2, 3].contains(2)             // true
[10, 20, 10].indexOf(10)          // 0
[10, 20, 10].lastIndexOf(10)      // 2
[3, 1, 2].sort()                  // [1, 2, 3]
["c", "a", "b"].sort()            // ["a", "b", "c"]
[1, 2, 3].reverse()               // [3, 2, 1]
["a", "b", "c"].join(",")         // "a,b,c"
[[1, 2], [3, 4]].flatten()        // [1, 2, 3, 4]
[1, 2, 1, 3, 2].distinct()        // [1, 2, 3]
```

### 8.6 Map Methods

All map methods are called as receiver methods: `m.method(...)`.

Source: `src/cel/evaluator.ts` (`evalMapMethod`)

| Method | Signature | Returns | Phases | Notes |
|---|---|---|---|---|
| `size` | `m.size()` | `int` | B, H, R | Number of keys. |
| `has` | `m.has(key)` | `bool` | B, H, R | True if string `key` is present. |
| `keys` | `m.keys()` | `list[string]` | B, H, R | List of key strings. |
| `values` | `m.values()` | `list` | B, H, R | List of values. |

```cel
{"a": 1, "b": 2}.size()           // 2
{"a": 1}.has("a")                 // true
{"a": 1}.has("z")                 // false
{"x": 1, "y": 2}.keys()           // ["x", "y"]
{"x": 1, "y": 2}.values()         // [1, 2]
```

**`has` as a free macro**: `has(obj.field)` checks for field presence without evaluating the field. This is the only form supported and the argument must be a field access expression.

```cel
has(command.payload.amount)    // true if 'amount' key exists in payload
has(state.metadata)            // true if 'metadata' key exists in state
```

### 8.7 Date and Time

Source: `src/cel/builtins.ts`

> ⚠️ `timestamp()`, `now()`, and `$now()` are **banned in the Reducer phase**. See Section 9.

| Function | Signature | Returns | Phases | Notes |
|---|---|---|---|---|
| `timestamp` | `timestamp(s)` | `string` | B, H | Validates ISO-8601 string and returns canonical UTC ISO-8601 (e.g. `"2024-01-15T10:00:00.000Z"`). Throws if unparseable. |
| `duration` | `duration(s)` | `int` (ms) | B, H, R | Parses ISO 8601 duration or shorthand to milliseconds. |
| `now` | `now()` | `string` | B, H | Current UTC time as ISO-8601 string. |

**Duration formats** accepted by `duration()`:

| Format | Example | Milliseconds |
|---|---|---|
| ISO 8601 | `"P1D"` | 86,400,000 |
| ISO 8601 full | `"P1DT2H3M4S"` | 93,784,000 |
| Shorthand seconds | `"30s"` | 30,000 |
| Shorthand minutes | `"1m"` | 60,000 |
| Shorthand hours | `"2h"` | 7,200,000 |
| Shorthand days | `"3d"` | 259,200,000 |

```cel
timestamp("2024-01-15T10:00:00Z")   // "2024-01-15T10:00:00.000Z"
duration("30s")                      // 30000
duration("P1D")                      // 86400000
now()                                // "2024-01-15T10:00:00.123Z" (current time)
```

### 8.8 Null Helpers

Source: `src/cel/builtins.ts`

| Function | Signature | Returns | Phases | Notes |
|---|---|---|---|---|
| `coalesce` | `coalesce(a, b, c, ...)` | `any` | B, H, R | Returns first non-null argument. Returns `null` if all arguments are null. |
| `default` | `default(a, fallback)` | `any` | B, H, R | Returns `a` if non-null, otherwise `fallback`. |

```cel
coalesce(null, "b", "c")              // "b"
coalesce(null, null, 42)              // 42
coalesce(null, null)                  // null
default(null, "fallback")             // "fallback"
default("value", "fallback")          // "value"
coalesce(state?.score, 0)            // 0 when state.score is absent
```

### 8.9 Type Introspection

| Function | Signature | Returns | Phases | Notes |
|---|---|---|---|---|
| `type` | `type(x)` | `string` | B, H, R | Returns the CEL type name (see Section 3.1). |

```cel
type("hello")   // "string"
type(42)        // "int"
type(3.14)      // "double"
type(true)      // "bool"
type(null)      // "null"
type([])        // "list"
type({})        // "map"
```

### 8.10 Engine Builtins (`$`-prefixed)

These functions are engine-provided and are prefixed with `$` to distinguish them from standard library functions.

Source: `src/cel/builtins.ts`; phase rules in `src/cel/phases.ts`

| Function | Signature | Returns | Phases | Notes |
|---|---|---|---|---|
| `$uuidv7` | `$uuidv7()` | `string` | B, H | Generates a time-ordered UUIDv7. **Banned in Reducer.** |
| `$now` | `$now()` | `string` | B, H | Current UTC time as ISO-8601. Alias for `now()`. **Banned in Reducer.** |
| `$concat` | `$concat(a, b, ...)` | `string` | B, H, R | Concatenates all arguments as strings. `null`/`undefined` arguments become `""`. |

```cel
$uuidv7()                    // "0190abcd-1234-7xxx-xxxx-xxxxxxxxxxxx"
$now()                       // "2024-01-15T10:00:00.123Z"
$concat("LOAN-", id)         // "LOAN-abc123"
$concat('/loans/', command.targetId, '/disburse')
```

`$concat` is safe to use in reducers. It is especially useful for constructing path-matching strings in behavior conditions:

```cel
command.path == $concat('/loans/', command.targetId, '/disburse')
```

---

## 9. Phase Enforcement

### 9.1 The Three Phases

Every CEL expression is evaluated in one of three phases, determined by where in the DSL it appears:

| Phase | Description | Typical DSL fields |
|---|---|---|
| **Behavior** | Pattern matching and rule selection | `match.condition`, `match.requires[].expression`, `postcondition`, `dispatch_commands[].condition` |
| **EventHydration** | Building the domain event payload | `event_catalog[].payload_template.*`, `identity.creation.generate` |
| **Reducer** | Projecting events onto state | `reducers[].assign.*`, `reducers[].append.*` |

Phase values are defined in `src/cel/phases.ts` as `CelPhase.Behavior`, `CelPhase.EventHydration`, `CelPhase.Reducer`.

### 9.2 Why Phases Exist

The engine follows an event-sourcing architecture. The event log is the source of truth and must be **replayable**: replaying the log must always produce the same state. Non-deterministic operations — generating a new UUID, reading the current clock — are therefore forbidden in reducers. If a reducer called `$uuidv7()`, each replay would generate a different ID, corrupting the state.

Non-deterministic functions are allowed in **Behavior** and **EventHydration** phases because those expressions run only once when processing a command, and their results are captured in the immutable event record. Reducers consume that record without re-generating anything.

### 9.3 Phase Enforcement Matrix

| Function | Behavior | EventHydration | Reducer |
|---|---|---|---|
| `$uuidv7` | allowed | allowed | **BANNED** |
| `$now` | allowed | allowed | **BANNED** |
| `now` | allowed | allowed | **BANNED** |
| `timestamp` | allowed | allowed | **BANNED** |
| All other builtins | allowed | allowed | allowed |

Source: `REDUCER_BANNED` set in `src/cel/builtins.ts:11`.

### 9.4 Phase Ban Error

Calling a banned function in the Reducer phase throws:

```
CEL_PHASE_BANNED: '$uuidv7' is not allowed in phase 'reducer' because it is non-deterministic
```

This error propagates up and aborts the Unit of Work.

### 9.5 Logging

Set `LOG_LEVEL=trace` to see CEL parse and evaluation diagnostics in the `cel` logger. The first 120 characters of the expression source and the context keys are logged on error.

---

## 10. Error Model

All errors from the CEL evaluator are JavaScript `Error` instances whose message begins with a machine-readable prefix.

| Prefix | When thrown |
|---|---|
| `CEL_PARSE_ERROR` | Unclosed string literal |
| `CEL_TOKENIZE` | Unexpected character in source |
| `CEL_PARSE` | Structural parse error (unexpected token, missing `)`, etc.) |
| `CEL_EVAL` | Runtime evaluation error (undefined identifier, wrong type for operator, unknown method) |
| `CEL_RUNTIME_ERROR` | Arithmetic errors (divide by zero, sqrt of negative, out-of-range index) |
| `CEL_TYPE_ERROR` | Type mismatch in builtin arguments |
| `CEL_UNKNOWN_BUILTIN` | Call to an unrecognised top-level function name |
| `CEL_PHASE_BANNED` | Non-deterministic function called in Reducer phase |

### Error Propagation

Parse errors are thrown at **compile time** when the engine boots (DSL is compiled eagerly). Runtime errors abort the current Unit of Work with HTTP 500.

Source: `src/cel/evaluator.ts` (the `evaluate` method wraps evaluation in a try/catch and logs before re-throwing).

---

## 11. Examples

### 11.1 Simple Match Condition

From `tests/fixtures/dsl/loan-account.yaml`:

```cel
// Disburse behavior — only fires on the correct path with a positive amount
command.path == $concat('/loans/', command.targetId, '/disburse')
  && command.payload.amount > 0
  && state.status != 'SETTLED'
```

### 11.2 Conditional Status Assignment in Reducer

```cel
// Assign 'SETTLED' if balance reaches zero, otherwise keep 'ACTIVE'
state.balance - event.payload.amount == 0 ? 'SETTLED' : 'ACTIVE'
```

### 11.3 Comprehension over Transactions

```cel
// Check that a disbursement exists for amounts over 1000
state.transactions.exists(t, t.kind == 'DISBURSEMENT' && t.amount > 1000)

// Count disbursement transactions
state.transactions.filter(t, t.kind == 'DISBURSEMENT').size()

// Sum disbursement amounts (reduce via map + manual sum is not available;
// use state tracking via reducer assign instead)
```

### 11.4 Multi-Step String Transform

```cel
// Normalise a space-separated label: upper-case each word, join with hyphens
state.label.split(" ").map(s, s.upperAscii()).join("-")
// "hello world" → "HELLO-WORLD"

// Deduplicate and sort tags
command.payload.tags.map(t, t.lowerAscii()).distinct().sort()
// ["VIP", "Standard", "VIP"] → ["standard", "vip"]
```

### 11.5 Null-Safe Deep Access

```cel
// Safely extract a header; fall back to "unknown" if absent
coalesce(command.headers?["x-trace-id"], "unknown")

// Conditional on a nullable nested field
state?.metadata?.tags?.contains("vip") == true
```

> ⚠️ CEL does not have a `??` null-coalescing operator. Use `coalesce(expr, fallback)` or `default(expr, fallback)` instead.

### 11.6 Complex Condition with Multiple Comprehensions

```cel
// All transactions within limit AND at least one is a disbursement
state.transactions.all(t, t.amount < 10000)
  && state.transactions.exists(t, t.kind == 'DISBURSEMENT')
```

### 11.7 Append a Map Literal in a Reducer

From `tests/fixtures/dsl/loan-account.yaml`:

```yaml
append:
  transactions: "{'txId': event.payload.txId, 'kind': 'DISBURSEMENT', 'amount': event.payload.amount, 'at': event.payload.at}"
```

The value is a CEL map literal constructed from event payload fields.

### 11.8 Regex Pattern Matching

```cel
// Full string match with anchors
state.label.matches("^LOAN-[0-9]+$")

// Enum membership test (alternative to `in`)
state.status.matches("ACTIVE|DRAFT|SETTLED")
```

---

## 12. Common Pitfalls

### 12.1 `1 == 1.0` Is `false`

```cel
1 == 1.0      // false — int vs double
```

**Workaround**: coerce both sides to the same type before comparing.

```cel
double(state.balance) == 1.0
int(event.payload.amount) == 100
```

### 12.2 Map Literal Keys Must Be Quoted

```cel
{status: "ACTIVE"}    // PARSE ERROR — bare identifier key
{"status": "ACTIVE"}  // correct
```

### 12.3 No `??` Null-Coalescing Operator

There is no `??` operator. Use `coalesce` or `default`:

```cel
// Wrong — CEL_TOKENIZE: unexpected character '?'
command.headers?["x-trace-id"] ?? "unknown"

// Correct
coalesce(command.headers?["x-trace-id"], "unknown")
default(command.headers?["x-trace-id"], "unknown")
```

### 12.4 Phase Ban Surprises

`now()`, `timestamp()`, `$uuidv7()`, and `$now()` may not be called in reducer fields. If you need a timestamp in state, read it from the event payload (which was set during EventHydration):

```yaml
# Correct: capture time in the event payload template (EventHydration phase)
payload_template:
  at: "$now()"

# Correct: read it back in the reducer (Reducer phase)
reducers:
  - on: LoanDisbursed
    assign:
      lastDisbursedAt: "event.payload.at"   # safe: reading, not generating
```

### 12.5 Regex Is JavaScript `RegExp`, Not RE2

The `matches()` method uses JavaScript's `RegExp` constructor, not Google RE2. This means:

- Backtracking is possible (no worst-case linear-time guarantee).
- Supported: lookahead `(?=...)`, non-capturing groups `(?:...)`.
- Not supported: RE2 features like possessive quantifiers.
- Patterns are **not anchored** by default — use `^...$` for full-string matching.

### 12.6 `in` Is Not Iteration

`x in list` is a membership test, not a for-each. Use comprehensions for iteration.

```cel
"vip" in state.tags            // membership test — correct
state.tags.exists(t, t == "vip")  // equivalent, but more composable
```

### 12.7 Comprehension Variable Shadowing

If a comprehension variable has the same name as a context variable, the comprehension variable takes precedence inside the body:

```cel
// 'x' in ctx is shadowed; 'x' inside filter body is the list element
items.filter(x, x > 0)   // ctx.x is invisible inside the filter body
```

### 12.8 `has()` Takes a Field Access, Not an Identifier

```cel
has(state.balance)     // correct — checks if 'balance' key exists in state
has("balance")         // CEL_EVAL: argument must be a field access expression
has(balance)           // CEL_EVAL: argument must be a field access expression
```

### 12.9 `+` With Mixed Types Coerces to String

```cel
"value: " + 42     // "value: 42" — string concatenation, not error
1 + "2"            // "12" — number coerced to string when other side is string
```

If you want numeric addition, ensure both sides are numbers first.

---

## 13. Inline TypeScript Fallback

When a CEL expression becomes unreasonably complex, the engine supports an inline TypeScript escape hatch. Any DSL field that accepts a CEL string also accepts `ts:<scriptName>` to delegate evaluation to a named TypeScript module declared in the top-level `scripts:` block.

See `docs/dsl.md#inline-typescript-scripts` for the full API.

> ⚠️ TypeScript scripts (`ts:`) are **banned in all Reducer-phase fields** by the DSL schema, for the same determinism reasons as `now()` and `$uuidv7()`.

Example: a CEL expression that computes a running IRR would require iterative numeric methods not available in CEL. A TypeScript script handles this cleanly:

```yaml
scripts:
  computeIrr: ./scripts/compute-irr.ts

reducers:
  - on: LoanRepaid
    assign:
      irr: "ts:computeIrr"   # NOT valid in reducers; shown for illustration only
```

---

## 14. Grammar Reference (EBNF)

The complete grammar as implemented in `src/cel/evaluator.ts` (lines 1–51):

```ebnf
expression  = ternary

ternary     = or ( '?' ternary ':' ternary )?

or          = and ( '||' and )*

and         = equality ( '&&' equality )*

equality    = in_expr ( ( '==' | '!=' ) in_expr )*

in_expr     = comparison ( 'in' comparison )*

comparison  = addSub ( ( '<' | '<=' | '>' | '>=' ) addSub )*

addSub      = mulDiv ( ( '+' | '-' ) mulDiv )*

mulDiv      = unary ( ( '*' | '/' | '%' ) unary )*

unary       = ( '!' | '-' ) unary
            | postfix

postfix     = primary
              ( '.'  ident ( '(' args ')' )?
              | '?.' ident ( '(' args ')' )?
              | '['  expression ']'
              | '?[' expression ']'
              )*

primary     = string_literal
            | number_literal
            | bool_literal
            | null_literal
            | ident ( '(' args ')' )?
            | '(' expression ')'
            | '[' ( expression ( ',' expression )* ','? )? ']'
            | '{' ( entry ( ',' entry )* ','? )? '}'

entry       = expression ':' expression

args        = ( expression ( ',' expression )* )?

comprehension_call
            = receiver '.'  comprehension_method '(' ident ',' expression ')'
            | receiver '?.' comprehension_method '(' ident ',' expression ')'

comprehension_method
            = 'all' | 'exists' | 'exists_one' | 'filter' | 'map'

string_literal
            = '"' char* '"'
            | "'" char* "'"
            | 'r' '"' raw_char* '"'
            | 'r' "'" raw_char* "'"

number_literal
            = '-'? [0-9]+ ( '.' [0-9]+ )?

bool_literal   = 'true' | 'false'
null_literal   = 'null'
ident          = [a-zA-Z_$] [a-zA-Z0-9_$]*
```

**Operator precedence** (highest to lowest): `! -` (unary), `* / %`, `+ -`, `< <= > >=`, `== != in`, `&&`, `||`, `?:`.

**Notes**:
- Comprehension calls are parsed by the postfix rule: `postfix` recognises `all`, `exists`, `exists_one`, `filter`, `map` as special method names and switches to `parseComprehensionArgs` which expects `ident ',' expression` rather than a standard argument list.
- Trailing commas are permitted in list literals, map literals, and function argument lists.
- The `has(obj.field)` form is handled as a special case in the `call` evaluator node, not in the grammar.

---

## 15. Compatibility with Upstream Google CEL

### 15.1 Supported Features (Compatible with Upstream)

- All arithmetic operators
- All comparison operators
- Logical `&&`, `||`, `!`
- Ternary `?:`
- `in` operator for list membership and map key presence
- String, number, boolean, null literals
- List literals and map literals
- Dot member access
- Index access `a[expr]`
- `size()`, `type()`, `has()` macros
- String methods: `startsWith`, `endsWith`, `contains`, `matches`, `size`
- Comprehension macros: `all`, `exists`, `filter`, `map` (plus `exists_one` as an extension)

### 15.2 Extensions (Not in Upstream CEL)

| Extension | Description |
|---|---|
| `?.` null-safe dot | Short-circuits to `null` instead of erroring |
| `?[` null-safe bracket | Short-circuits to `null` instead of erroring |
| Raw string literals `r"..."` | Backslash not interpreted |
| `coalesce(a, b, ...)` | Multi-argument null fallback |
| `default(a, fallback)` | Two-argument null fallback |
| `$uuidv7()` | Engine-provided UUIDv7 generator |
| `$now()` | Engine-provided wall-clock alias |
| `$concat(...)` | Variadic string concatenation |
| `duration()` shorthand | `"30s"`, `"1m"`, `"2h"`, `"3d"` formats |
| Extended string methods | `replace`, `split`, `substring`, `indexOf`, `lastIndexOf`, `lowerAscii`, `upperAscii`, `trim`, `trimStart`, `trimEnd`, `charAt` |
| Extended list methods | `indexOf`, `lastIndexOf`, `sort`, `reverse`, `join`, `flatten`, `distinct` |
| Map receiver methods | `has`, `keys`, `values`, `size` as receiver methods |
| `exists_one` macro | Not in all upstream implementations |
| Null-safe comprehensions `?.macro(...)` | Short-circuit to null on null receiver |

### 15.3 Omissions (Present in Upstream, Not Here)

| Upstream feature | Status in this engine |
|---|---|
| Protobuf message types | Not applicable — all values are JSON-native |
| `bytes` literal syntax (`b"..."`) | Not supported; use `bytes("...")` function instead |
| Timestamp arithmetic (`timestamp + duration`) | Not supported; `duration()` returns milliseconds for manual arithmetic |
| Numeric overflow errors | JavaScript `number` does not overflow; returns `Infinity` |
| Multi-line string literals | Not tested; expressions are embedded in single-line YAML values |
| Block comments | Not supported |
| Namespaced functions (`pkg.func()`) | Not supported |
| `select` operator (proto field presence) | Replaced by `has()` macro |

### 15.4 Design Scope Note

This CEL implementation is purpose-built for writing declarative business rules in a stateful HTTP simulator. It is not intended as a general-purpose or production CEL runtime. For environment-specific policy enforcement, Rego/OPA may be more appropriate. For complex algorithmic logic, use the `ts:` script escape hatch (see Section 13).
