import type { ObjectGraphSchema, ObjectGraphSchemaRegistry } from './types.js';

/**
 * Tokenise a dot-path like `a.b.c[0].d` into segments.
 * Square-bracket indices are normalised to the special token `[]`.
 */
function tokenise(dotPath: string): string[] {
  // replace [n] or [] with .[]
  const normalised = dotPath.replace(/\[(\d+|)\]/g, '.[]');
  return normalised.split('.').filter((s) => s.length > 0);
}

/**
 * Walk `schema` following `dotPath` and return the reached sub-schema, or null
 * if the path does not exist or is not reachable.
 *
 * Supports:
 *  - `a.b.c`           — plain property traversal
 *  - `a[0].b` / `a[].b` — array index resolves to `items`
 */
export function resolvePath(schema: ObjectGraphSchema, dotPath: string): ObjectGraphSchema | null {
  if (!dotPath || dotPath === '') return schema;

  const tokens = tokenise(dotPath);
  let current: ObjectGraphSchema = schema;

  for (const token of tokens) {
    if (token === '[]') {
      // Descend into array items
      if (current.kind !== 'array' || !current.items) return null;
      current = current.items;
    } else if (current.kind === 'object') {
      const child = current.properties != null && Object.prototype.hasOwnProperty.call(current.properties, token)
        ? current.properties[token]
        : undefined;
      if (!child) {
        // If additionalProperties is a schema, any key is valid but returns that schema
        if (typeof current.additionalProperties === 'object') {
          current = current.additionalProperties as ObjectGraphSchema;
        } else if (current.additionalProperties === true) {
          // Wildcard — return an 'any' schema
          return { name: token, kind: 'any' };
        } else {
          return null;
        }
      } else {
        current = child;
      }
    } else if (current.kind === 'union' && current.union) {
      // Try to resolve in any union member
      let resolved: ObjectGraphSchema | null = null;
      for (const member of current.union) {
        const attempt = resolvePath(member, token);
        if (attempt !== null) {
          resolved = attempt;
          break;
        }
      }
      if (!resolved) return null;
      current = resolved;
    } else if (current.kind === 'any') {
      return { name: token, kind: 'any' };
    } else {
      return null;
    }
  }

  return current;
}

export function isValidPath(schema: ObjectGraphSchema, dotPath: string): boolean {
  return resolvePath(schema, dotPath) !== null;
}

export function pathExists(
  registry: ObjectGraphSchemaRegistry,
  boundary: string,
  dotPath: string,
): boolean {
  const bs = registry.get(boundary);
  if (!bs) return false;
  return isValidPath(bs.entity, dotPath);
}
