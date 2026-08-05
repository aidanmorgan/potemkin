import type { OpenApiDoc, OpenApiOperation } from '../../src/contract/loader.js';
import type { JsonObject } from '../../src/contracts/value.js';
import type { ContractFieldPolicy, EquivalencePath } from './types.js';

/**
 * Extract response-field volatility from the loaded OpenAPI document. This is
 * intentionally a test/equivalence concern: the runtime contract loader stays
 * source-independent and does not know about comparator projection policy.
 */
export function contractFieldPolicies(
  document: OpenApiDoc,
  operationId: string,
  status = '200',
): Readonly<Record<EquivalencePath, ContractFieldPolicy>> {
  const operation = findOperation(document, operationId);
  if (operation === undefined) return {};
  const schema = responseSchema(operation, status);
  if (schema === undefined) return {};
  const fields: Record<string, ContractFieldPolicy> = {};
  collectPolicies(schema, '$', fields);
  return Object.freeze(fields);
}

function findOperation(document: OpenApiDoc, operationId: string): OpenApiOperation | undefined {
  for (const item of Object.values(document.paths)) {
    for (const method of Object.keys(item)) {
      const operation = item[method];
      if (operation?.operationId === operationId) return operation;
    }
  }
  return undefined;
}

function responseSchema(operation: OpenApiOperation, status: string): JsonObject | undefined {
  const responses = operation.responseSchemas;
  if (responses === undefined) return undefined;
  return responses[status] ?? Object.entries(responses).find(([key]) => /^2\d\d$/.test(key))?.[1];
}

function collectPolicies(
  schema: JsonObject,
  path: string,
  fields: Record<string, ContractFieldPolicy>,
): void {
  const format = schema['format'];
  const readOnly = schema['readOnly'];
  if (typeof format === 'string' || readOnly === true) {
    fields[path] = {
      ...(typeof format === 'string' ? { format } : {}),
      ...(readOnly === true ? { readOnly: true } : {}),
    };
  }

  const properties = schema['properties'];
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
      if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
        collectPolicies(child as JsonObject, `${path}.${name}`, fields);
      }
    }
  }

  const items = schema['items'];
  if (items !== null && typeof items === 'object' && !Array.isArray(items)) {
    // The comparator deliberately treats a policy on an array field as a
    // shape-only projection, which is the safe representation for arbitrary
    // item depth without introducing a second wildcard path language.
    const itemPolicies: Record<string, ContractFieldPolicy> = {};
    collectPolicies(items as JsonObject, path, itemPolicies);
    for (const [itemPath, policy] of Object.entries(itemPolicies)) fields[itemPath] = policy;
  }
}
