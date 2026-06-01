import type { OpenApiDoc, OpenApiOperation } from './loader.js';
import type { VersioningConfig } from '../dsl/types.js';

export interface MatchedRoute {
  readonly contractPath: string;
  readonly pathParams: Record<string, string>;
  readonly operation: OpenApiOperation;
}

/** Result of resolving an API version from a request path. */
export interface VersionResolution {
  /** The path with any matched version prefix stripped (e.g. /v1/leads → /leads). */
  readonly path: string;
  /** The resolved version name, or undefined when versioning is disabled. */
  readonly version?: string;
}

/**
 * Resolve the API version for a request path and strip the matching version
 * prefix so the downstream contract lookup sees the un-versioned path.
 *
 *  - When versioning is disabled/absent → path is returned unchanged, no version.
 *  - When a declared prefix matches (longest-prefix wins) → that prefix is
 *    stripped and its version name returned.
 *  - When no prefix matches → the path is unchanged and the `default` version
 *    (if one is declared) is returned.
 *
 * A prefix matches when the path equals the prefix or continues with a `/`
 * after it, so `/v1` and `/v1/leads` match but `/v10/leads` does not.
 */
export function resolveVersion(
  path: string,
  versioning: VersioningConfig | undefined,
): VersionResolution {
  if (!versioning?.enabled || !versioning.versions || versioning.versions.length === 0) {
    return { path };
  }

  const pathOnly = path.split('?')[0]!;

  // Longest prefix first for deterministic specificity (e.g. /v1/beta over /v1).
  const sorted = [...versioning.versions].sort((a, b) => b.prefix.length - a.prefix.length);
  for (const v of sorted) {
    const prefix = v.prefix;
    if (pathOnly === prefix || pathOnly.startsWith(prefix + '/')) {
      const stripped = pathOnly.slice(prefix.length) || '/';
      return { path: stripped, version: v.version };
    }
  }

  // No prefix matched — route to the default version, leaving the path intact.
  const def = versioning.versions.find((v) => v.default === true);
  return def !== undefined ? { path: pathOnly, version: def.version } : { path: pathOnly };
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

  // Strip query string before matching so callers passing raw req.url still match.
  const normalizedPath = path.split('?')[0]!;

  // Count the number of parameter (wildcard) segments in a path template.
  // Used as a secondary sort key: fewer params = more specific = wins ties.
  function paramSegmentCount(pathTemplate: string): number {
    return pathTemplate.split('/').filter((seg) => seg.startsWith('{')).length;
  }

  // Sort by descending static-prefix length; fewer param segments wins ties; lexicographic for full determinism.
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
