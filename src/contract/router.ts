import type { OpenApiDoc, OpenApiOperation } from './loader.js';

export interface MatchedRoute {
  readonly contractPath: string;
  readonly pathParams: Record<string, string>;
  readonly operation: OpenApiOperation;
}

/**
 * Count the number of literal (non-parameter) segments in a path template.
 * Used to sort templates so more-specific paths win over wildcard ones.
 */
function staticPrefixLength(pathTemplate: string): number {
  return pathTemplate
    .split('/')
    .filter((seg) => seg.length > 0 && !seg.startsWith('{'))
    .join('/').length;
}

/**
 * Convert an OpenAPI path template like /loans/{id}/items/{itemId}
 * into a named-capture-group regex: /^\/loans\/(?<id>[^/]+)\/items\/(?<itemId>[^/]+)$/
 */
function templateToRegex(template: string): RegExp {
  const escaped = template
    .split('/')
    .map((seg) => {
      if (seg.startsWith('{') && seg.endsWith('}')) {
        const name = seg.slice(1, -1);
        return `(?<${name}>[^/]+)`;
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('\\/');
  return new RegExp(`^${escaped}$`);
}

/**
 * Match an incoming HTTP method + concrete path against the OpenAPI document's path templates.
 * Returns null if no path template matches.
 *
 * Deterministic ordering: templates with longer static prefixes are tried first,
 * ensuring /loans/active beats /loans/{id}.
 */
export function matchRoute(
  doc: OpenApiDoc,
  method: string,
  path: string,
): MatchedRoute | null {
  const lowerMethod = method.toLowerCase();

  // F-01: Strip query string from path before matching so that callers passing
  // raw req.url (e.g. /items?limit=10) still match the /items template.
  const normalizedPath = path.split('?')[0]!;

  // Count the number of parameter (wildcard) segments in a path template.
  // Used as a secondary sort key: fewer params = more specific = wins ties.
  function paramSegmentCount(pathTemplate: string): number {
    return pathTemplate.split('/').filter((seg) => seg.startsWith('{')).length;
  }

  // F-03: Sort by descending static-prefix length for deterministic specificity.
  // Tie-break: fewer param segments wins. Final tie-break: lexicographic order
  // for full determinism regardless of insertion order.
  const sortedPaths = Object.keys(doc.paths).sort((a, b) => {
    const staticDiff = staticPrefixLength(b) - staticPrefixLength(a);
    if (staticDiff !== 0) return staticDiff;
    const paramDiff = paramSegmentCount(a) - paramSegmentCount(b);
    if (paramDiff !== 0) return paramDiff;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  for (const pathTemplate of sortedPaths) {
    const regex = templateToRegex(pathTemplate);
    const match = regex.exec(normalizedPath);
    if (!match) continue;

    const pathItem = doc.paths[pathTemplate];
    /* istanbul ignore next — pathTemplate comes from Object.keys(doc.paths) so pathItem is always defined */
    if (!pathItem) continue;

    const operation = pathItem[lowerMethod];
    if (!operation) continue;

    const pathParams: Record<string, string> = {};
    if (match.groups) {
      for (const [key, value] of Object.entries(match.groups)) {
        if (typeof value === 'string') {
          pathParams[key] = value;
        }
      }
    }

    return {
      contractPath: pathTemplate,
      pathParams,
      operation,
    };
  }

  return null;
}
