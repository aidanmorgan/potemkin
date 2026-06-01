import type { HateoasEntry, DeprecationConfig } from './responseDslCompiler.js';
import { parsePointer } from './patches.js';

// Extracts HATEOAS and deprecation defaults from an OpenAPI operation.
// Used when a boundary does not supply a `hateoas:` or `deprecation:` block;
// the response interceptor composes per-boundary overrides on top.

export interface OpenApiOperation {
  readonly deprecated?: boolean;
  readonly responses?: Record<string, OpenApiResponseObject | undefined>;
  readonly operationId?: string;
}

export interface OpenApiResponseObject {
  readonly links?: Record<string, OpenApiLinkObject | undefined>;
}

export interface OpenApiLinkObject {
  readonly operationId?: string;
  readonly operationRef?: string;
  readonly parameters?: Record<string, string>;
}

export interface OperationLookup {
  resolveOperationPath(operationId: string): string | undefined;
}

export function extractDefaultHateoas(
  op: OpenApiOperation | undefined,
  statusCode: number | string,
  lookup: OperationLookup,
): HateoasEntry[] {
  if (!op?.responses) return [];
  const codeKey = typeof statusCode === 'number' ? String(statusCode) : statusCode;
  const responseObj = op.responses[codeKey] ?? op.responses['default'];
  if (!responseObj?.links) return [];
  const out: HateoasEntry[] = [];
  for (const [rel, link] of Object.entries(responseObj.links)) {
    if (!link) continue;
    const href = resolveLinkHref(link, lookup);
    if (href) out.push({ rel, href });
  }
  return out;
}

function resolveLinkHref(link: OpenApiLinkObject, lookup: OperationLookup): string | null {
  if (link.operationId) {
    const path = lookup.resolveOperationPath(link.operationId);
    if (!path) return null;
    return applyLinkParameters(path, link.parameters);
  }
  if (link.operationRef) {
    // `#/paths/<escaped-path>/<method>` — the path segment is the URL template.
    // External refs (`<uri>#/paths/...`) cannot be resolved here; returning the
    // raw JSON Pointer as an href would surface an internal pointer to clients,
    // so we return null rather than a non-URL string.
    return extractPathFromOperationRef(link.operationRef);
  }
  return null;
}

// Extract the URL path from an internal `#/paths/<path>/<method>` operationRef.
// Returns null for external refs or malformed pointers.
function extractPathFromOperationRef(operationRef: string): string | null {
  if (!operationRef.startsWith('#/paths/')) return null;
  const segs = parsePointer(operationRef.slice(1));
  if (segs.length !== 3 || segs[0] !== 'paths') return null;
  const path = segs[1];
  return path && path.startsWith('/') ? path : null;
}

function applyLinkParameters(
  template: string,
  parameters: Record<string, string> | undefined,
): string {
  if (!parameters) return template;
  let out = template;
  for (const [name, expr] of Object.entries(parameters)) {
    out = out.replace(`{${name}}`, expr);
  }
  return out;
}

// OpenAPI only carries the deprecation flag; Sunset/Link emission is per-boundary.

export function extractDefaultDeprecation(
  op: OpenApiOperation | undefined,
): DeprecationConfig | undefined {
  if (!op) return undefined;
  if (op.deprecated === true) return {};
  return undefined;
}
