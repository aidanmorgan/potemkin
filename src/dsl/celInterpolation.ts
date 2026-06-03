// Detection of bare CEL references in reducer patch values.
//
// Reducer patch `value:` fields are string templates: literal text with CEL
// embedded via `${ ... }` interpolation. A CEL context reference (`state.`,
// `event.`, `command.`) or a `$builtin` (e.g. `$now`, `$uuidv7`) that appears
// OUTSIDE a `${...}` span is almost certainly an authoring mistake — the author
// meant to interpolate it. The boot validator rejects such values with
// BOOT_ERR_CEL_NEEDS_INTERP so the canonical `${...}` form is enforced.
//
// This is driven by the same lexers as the parser: the template lexer splits
// `${...}` interpolations from literal text, and the CEL lexer recognises
// quoted-string literals so a string such as `'event happened'` is not flagged.
// No regex parses structure; the only regex is the lexeme-level identifier
// classifier inside the CEL lexer.

import { lexTemplate } from '../cel/grammar/templateLexer.js';
import { lex, type Token } from '../cel/grammar/lexer.js';

/** Context-object names whose `name.` reference must be interpolated. */
const CONTEXT_OBJECTS = new Set(['state', 'event', 'command']);

/**
 * Scan one literal-text chunk (outside any `${...}`) for the first bare CEL
 * reference, skipping quoted-string literals (which the CEL lexer recognises as
 * STRING tokens). Returns the reference text (`state.`, `event.`, `command.`,
 * or a `$builtin` token) or null.
 *
 * If the chunk is not lexable as CEL (arbitrary literal text can contain
 * characters CEL rejects), the unlexable tail cannot contain a *valid* CEL
 * reference, so we simply report whatever the lexer found before stopping.
 */
function firstBareRefInText(text: string): string | null {
  let tokens: Token[];
  try {
    tokens = lex(text);
  } catch {
    // Re-lex the longest CEL-lexable prefix so a trailing stray character
    // (e.g. a '%' in free text) does not mask a real reference before it.
    tokens = lexLongestPrefix(text);
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type === 'IDENT') {
      const name = String(t.value);
      // `$builtin`: a `$` followed by a letter or underscore (e.g. `$now`).
      // A `$` followed by anything else (e.g. `$5`) is not a builtin token.
      if (/^\$[A-Za-z_]/.test(name)) return name;
      // `state.` / `event.` / `command.` — a context object followed by `.`.
      if (CONTEXT_OBJECTS.has(name) && tokens[i + 1]?.type === '.') {
        return `${name}.`;
      }
    }
  }
  return null;
}

/** Lex the longest prefix of `text` that the CEL lexer accepts. */
function lexLongestPrefix(text: string): Token[] {
  for (let end = text.length - 1; end >= 0; end--) {
    try {
      return lex(text.slice(0, end));
    } catch {
      // keep shrinking
    }
  }
  return [];
}

/**
 * Return the first bare CEL reference (e.g. `state.`, `event.`, `command.`,
 * `$now`) found OUTSIDE a `${...}` interpolation and outside any quoted string
 * literal, or `null` when the value is clean. A clean value is one whose CEL
 * references are all wrapped in `${...}` (or absent).
 */
export function firstBareCelReference(value: string): string | null {
  for (const tok of lexTemplate(value)) {
    // Only literal text outside ${...} is scanned. EXPR parts are interpolated
    // (the desired form) and ESCAPED ($${...}) parts are literal output, not CEL.
    if (tok.type !== 'TEXT') continue;
    const ref = firstBareRefInText(tok.text);
    if (ref !== null) return ref;
  }
  return null;
}

