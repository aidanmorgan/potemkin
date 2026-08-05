import type { HateoasEntry, ResponseDeprecation } from '../contracts/response.js';
import { parsePointer } from '../model/patches.js';

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
  operation: OpenApiOperation | undefined,
  statusCode: number | string,
  lookup: OperationLookup,
): HateoasEntry[] {
  if (!operation?.responses) return [];
  const response = operation.responses[String(statusCode)] ?? operation.responses.default;
  if (!response?.links) return [];
  const entries: HateoasEntry[] = [];
  for (const [rel, link] of Object.entries(response.links)) {
    if (!link) continue;
    const href = resolveLinkHref(link, lookup);
    if (href) entries.push({ rel, href });
  }
  return entries;
}

function resolveLinkHref(link: OpenApiLinkObject, lookup: OperationLookup): string | null {
  if (link.operationId) {
    const path = lookup.resolveOperationPath(link.operationId);
    return path ? applyLinkParameters(path, link.parameters) : null;
  }
  if (link.operationRef) return extractPathFromOperationRef(link.operationRef);
  return null;
}

function extractPathFromOperationRef(operationRef: string): string | null {
  if (!operationRef.startsWith('#/paths/')) return null;
  const segments = parsePointer(operationRef.slice(1));
  if (segments.length !== 3 || segments[0] !== 'paths') return null;
  const path = segments[1];
  return path?.startsWith('/') ? path : null;
}

function applyLinkParameters(path: string, parameters: Record<string, string> | undefined): string {
  if (!parameters) return path;
  let result = path;
  for (const [name, expression] of Object.entries(parameters)) {
    result = result.replace(`{${name}}`, expression);
  }
  return result;
}

export function extractDefaultDeprecation(
  operation: OpenApiOperation | undefined,
): ResponseDeprecation | undefined {
  return operation?.deprecated ? {} : undefined;
}
