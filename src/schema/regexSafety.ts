/**
 * Detect a catastrophic-backtracking shape in a regular-expression source.
 *
 * This is a conservative, synchronous guard shared by schema pattern
 * validation and the YAML expression evaluator. Keeping it here avoids making
 * source-neutral schema validation depend on CEL implementation modules.
 */
export function detectCatastrophicRegexShape(pattern: string): string | null {
  const groupRepeat = /\)\s*(?:[+*]|\{\d+,\}?)/;
  const groupRe = /\(([^()]*)\)\s*([+*]|\{\d+,?\d*\}?)?/g;
  let match: RegExpExecArray | null;
  while ((match = groupRe.exec(pattern)) !== null) {
    const body = match[1] ?? "";
    const outerQuantifier = match[2] ?? "";
    const outerUnbounded =
      outerQuantifier === "+" || outerQuantifier === "*" || /^\{\d+,\}?$/.test(outerQuantifier);
    if (!outerUnbounded) continue;

    if (/[+*]|\{\d+,/.test(body)) {
      return `nested-quantifier shape /(${body})${outerQuantifier}/`;
    }
    if (body.includes("|")) {
      return `overlapping-alternation shape /(${body})${outerQuantifier}/`;
    }
  }

  if (groupRepeat.test(pattern) && /\([^)]*[+*]/.test(pattern)) {
    return "nested-quantifier shape (nested groups)";
  }

  const tokenRe = /(\[[^\]]*\]|\\.|[^\\])/g;
  let sequenceAtom: string | null = null;
  let sequenceCount = 0;
  const tokens: string[] = [];
  let tokenMatch: RegExpExecArray | null;
  while ((tokenMatch = tokenRe.exec(pattern)) !== null) {
    tokens.push(tokenMatch[1] ?? "");
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const next = tokens[index + 1] ?? "";
    const isUnboundedQuantifier = next === "+" || next === "*" || /^\{\d+,\d*\}$/.test(next);
    if (isUnboundedQuantifier) {
      const normalized = token.startsWith("[") ? "CLS" : token;
      if (normalized === sequenceAtom) {
        sequenceCount += 1;
        if (sequenceCount >= 3) {
          return "sequential-unbounded-quantifier shape (>= 3 adjacent unbounded quantifiers on overlapping atoms)";
        }
      } else {
        sequenceAtom = normalized;
        sequenceCount = 1;
      }
      index += 1;
    } else {
      sequenceAtom = null;
      sequenceCount = 0;
    }
  }

  return null;
}
