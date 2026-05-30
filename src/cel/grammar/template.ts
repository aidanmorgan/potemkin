/**
 * DSL value-template parser.
 *
 * Parses a template string (the `${expr}` micro-syntax) into a typed plan,
 * driven by the template grammar (docs/grammar/cel.grammar.md §3) over the
 * tokens from `templateLexer.ts`. This replaces the legacy regex/char-scan
 * `planDslValue` while preserving its semantics exactly.
 */

import { lexTemplate, type TemplateToken } from './templateLexer.js';

/** Typed template AST: a sequence of parts. */
export type TemplatePart =
  | { kind: 'text'; text: string }   // literal text (incl. unescaped $${...})
  | { kind: 'expr'; src: string };   // CEL source to evaluate

/**
 * Evaluation plan, identical in meaning to the legacy `DslPlan`:
 *  - `literal`: emit the value as-is (non-string, or a string with no EXPR part)
 *  - `whole`:   evaluate `expr` and preserve its CEL return type
 *  - `interp`:  evaluate each EXPR part, coerce to string, concatenate
 */
export type TemplatePlan =
  | { kind: 'literal'; value: unknown }
  | { kind: 'whole'; expr: string }
  | { kind: 'interp'; parts: TemplatePart[] };

/**
 * Parse a DSL value into a {@link TemplatePlan}.
 *
 * Non-strings pass through as `literal`. A string containing neither `${` nor
 * `$${` is treated as a bare CEL expression (`whole`) for backward
 * compatibility — matching the legacy behaviour.
 */
export function parseTemplate(value: unknown): TemplatePlan {
  if (typeof value !== 'string') return { kind: 'literal', value };
  const s = value;

  // Backward-compat: bare strings without ${} / $${} are whole CEL expressions.
  if (!s.includes('${') && !s.includes('$${')) return { kind: 'whole', expr: s };

  const tokens = lexTemplate(s);
  const parts = toParts(tokens);

  if (parts.length === 1 && parts[0]!.kind === 'expr') {
    return { kind: 'whole', expr: parts[0]!.src };
  }
  if (parts.every(p => p.kind === 'text')) {
    return {
      kind: 'literal',
      value: parts.map(p => (p.kind === 'text' ? p.text : '')).join(''),
    };
  }
  return {
    kind: 'interp',
    parts: parts.map(p =>
      p.kind === 'expr'
        ? { kind: 'expr' as const, src: p.src }
        : { kind: 'text' as const, text: p.text },
    ),
  };
}

/** Internal part shape carrying the EXPR source. */
type InternalPart = { kind: 'text'; text: string } | { kind: 'expr'; src: string };

/**
 * Reduce template tokens into parts (the `Template → Part*` production). ESCAPED
 * tokens become literal text `"${body}"` and are coalesced with adjacent text.
 */
function toParts(tokens: TemplateToken[]): InternalPart[] {
  const parts: InternalPart[] = [];
  const pushText = (text: string): void => {
    const last = parts[parts.length - 1];
    if (last && last.kind === 'text') last.text += text;
    else parts.push({ kind: 'text', text });
  };
  for (const t of tokens) {
    switch (t.type) {
      case 'TEXT':    pushText(t.text); break;
      case 'ESCAPED': pushText('${' + t.text + '}'); break;
      case 'EXPR':    parts.push({ kind: 'expr', src: t.src }); break;
    }
  }
  return parts;
}
