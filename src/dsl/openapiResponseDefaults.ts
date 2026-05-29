import type { HateoasEntry, DeprecationConfig } from './responseDslCompiler.js';

// Walks an OpenAPI document to extract HATEOAS and deprecation defaults
// for a matched operation. These defaults are used when a boundary does
// NOT supply a `hateoas:` or `deprecation:` override block — the response
// interceptor then composes the per-boundary overrides on top.

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
  // Path-template + method → operation. Operation may carry a templated
  // href produced by translating operationId or operationRef.
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
    // operationRef points at the OpenAPI doc; for templated paths it's
    // already the templated string after a `#/paths/...` pointer. For now
    // we surface it as-is — Stage 4 plugin can resolve fully.
    return link.operationRef;
  }
  return null;
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

// Read OpenAPI deprecated:true on the matched operation. Sunset/Link
// emission is per-boundary — OpenAPI alone only carries the deprecation
// flag (no Sunset date semantic).

export function extractDefaultDeprecation(
  op: OpenApiOperation | undefined,
): DeprecationConfig | undefined {
  if (!op) return undefined;
  if (op.deprecated === true) return {};
  return undefined;
}
