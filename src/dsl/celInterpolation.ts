// Detection of bare CEL references in reducer patch values.
//
// Reducer patch `value:` fields are string templates: literal text with CEL
// embedded via `${ ... }` interpolation. A CEL context reference (`state.`,
// `event.`, `command.`) or a `$builtin` (e.g. `$now`, `$uuidv7`) that appears
// OUTSIDE a `${...}` span is almost certainly an authoring mistake — the author
// meant to interpolate it. The boot validator rejects such values with
// BOOT_ERR_CEL_NEEDS_INTERP so the canonical `${...}` form is enforced.
//
// String literals are excluded so a CEL string such as `'event happened'`
// (a literal that merely contains the substring `event.`) is not flagged.

/** CEL context-object references and `$builtin` tokens that must be interpolated. */
const BARE_REFERENCE = /(?:\b(?:state|event|command)\.)|(?:\$[A-Za-z_]\w*)/;

/**
 * Replace every `${...}` interpolation span and every quoted string literal in
 * `value` with spaces of equal length, so only the un-interpolated, non-literal
 * text remains for reference scanning. Length is preserved so any reported
 * index still lines up with the original string.
 */
function blankInterpolationsAndLiterals(value: string): string {
  let out = '';
  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    // `${ ... }` interpolation span — blank through the closing brace.
    if (ch === '$' && value[i + 1] === '{') {
      const end = value.indexOf('}', i + 2);
      const stop = end === -1 ? value.length : end + 1;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    // Quoted string literal (single or double) — blank through the close quote,
    // honouring backslash escapes.
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < value.length) {
        if (value[j] === '\\') {
          j += 2;
          continue;
        }
        if (value[j] === ch) break;
        j++;
      }
      const stop = Math.min(j + 1, value.length);
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Return the first bare CEL reference (e.g. `state.`, `event.`, `command.`,
 * `$now`) found OUTSIDE a `${...}` interpolation and outside any quoted string
 * literal, or `null` when the value is clean. A clean value is one whose CEL
 * references are all wrapped in `${...}` (or absent).
 */
export function firstBareCelReference(value: string): string | null {
  const scanned = blankInterpolationsAndLiterals(value);
  const m = BARE_REFERENCE.exec(scanned);
  return m ? m[0] : null;
}

/** True when `value` carries a CEL reference that is not wrapped in `${...}`. */
export function hasBareCelReference(value: string): boolean {
  return firstBareCelReference(value) !== null;
}
