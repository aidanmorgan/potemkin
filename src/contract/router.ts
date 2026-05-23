import type { OpenApiDoc, OpenApiOperation } from './loader.js';

export interface MatchedRoute {
  readonly contractPath: string;
  readonly pathParams: Record<string, string>;
  readonly operation: OpenApiOperation;
}

/**
 * Match an incoming HTTP method + concrete path against the OpenAPI document's path templates.
 * Returns null if no path template matches.
 */
export function matchRoute(
  doc: OpenApiDoc,
  method: string,
  path: string,
): MatchedRoute | null {
  throw new Error('NotImplemented: contract/router.matchRoute');
}
