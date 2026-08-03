import type { OpenApiDoc, OpenApiOperation } from "./loader.js";
import { matchRoute } from "./router.js";
import type { JsonObject } from "../types.js";

/**
 * Resolve the response schema for one concrete operation and status.
 *
 * Response schemas are deliberately resolved per operation. An API-level
 * error schema is not a substitute for an operation that does not declare
 * that status. The lookup order is the OpenAPI response key for the exact
 * status, followed by `default`.
 *
 * The loader keeps only literal numeric status keys and `default`; range keys
 * such as `4XX` and `5XX` are not part of this lookup contract.
 */
export function resolveResponseSchema(
  doc: OpenApiDoc,
  method: string,
  path: string,
  status: number,
): JsonObject | undefined {
  const matched = matchRoute(doc, method, path);
  if (matched === null) return undefined;

  const responseSchemas = matched.operation.responseSchemas;
  if (responseSchemas === undefined) return undefined;

  return responseSchemas[String(status)] ?? responseSchemas.default;
}

/** Find an operation by operationId for static DSL analysis. */
export function findOperationById(
  doc: OpenApiDoc,
  operationId: string,
):
  | { readonly method: string; readonly path: string; readonly operation: OpenApiOperation }
  | undefined {
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (operation?.operationId === operationId) {
        return { method: method.toUpperCase(), path, operation };
      }
    }
  }
  return undefined;
}
