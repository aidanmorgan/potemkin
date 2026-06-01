import type { OpenApiDoc } from '../contract/loader.js';
import type { BoundaryConfig } from '../dsl/types.js';
import type { JsonObject } from '../types.js';
import { BootError } from '../errors.js';
import type { ObjectGraphSchema, BoundarySchemas, ObjectGraphSchemaRegistry, SchemaTypeKind } from './types.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function collectArrayPaths(schema: ObjectGraphSchema, prefix: string): string[] {
  const paths: string[] = [];
  if (schema.kind === 'array') {
    if (prefix) paths.push(prefix);
    if (schema.items) {
      paths.push(...collectArrayPaths(schema.items, prefix ? `${prefix}[]` : '[]'));
    }
  }
  if (schema.kind === 'object' && schema.properties) {
    for (const [key, child] of Object.entries(schema.properties)) {
      const childPath = prefix ? `${prefix}.${key}` : key;
      paths.push(...collectArrayPaths(child, childPath));
    }
  }
  return paths;
}

function mapOasType(raw: JsonObject): SchemaTypeKind {
  const t = raw['type'] as string | string[] | undefined;
  if (Array.isArray(t)) {
    // e.g. ["string", "null"]
    const nonNull = t.filter((x) => x !== 'null');
    if (nonNull.length === 1) return mapOasType({ ...raw, type: nonNull[0] });
    return 'union';
  }
  if (t === 'integer') return 'integer';
  if (t === 'number') return 'number';
  if (t === 'string') return 'string';
  if (t === 'boolean') return 'boolean';
  if (t === 'null') return 'null';
  if (t === 'array') return 'array';
  if (t === 'object' || (!t && raw['properties'])) return 'object';
  if (!t && !raw['properties'] && !raw['items']) return 'any';
  return 'any';
}

/**
 * Recursively convert an OAS schema node (already dereferenced) into an ObjectGraphSchema.
 */
function convertNode(raw: JsonObject, name: string): ObjectGraphSchema {
  // Handle nullable shorthand: nullable: true alongside type
  const nullable = (raw['nullable'] as boolean | undefined) ?? false;

  // Handle not: keyword
  if (raw['not']) {
    throw new BootError(
      'BOOT_ERR_SCHEMA_UNSUPPORTED',
      `'not' keyword is not supported in boundary schema '${name}'`,
      { feature: 'not' },
    );
  }

  // Handle oneOf → kind 'union' with unionVariant 'oneOf' (exactly one member must match)
  if (raw['oneOf']) {
    const members = (raw['oneOf'] as JsonObject[]).map((m, i) =>
      convertNode(m as JsonObject, `${name}[${i}]`),
    );
    return { name, kind: 'union', union: members, nullable, unionVariant: 'oneOf' };
  }

  // Handle anyOf → kind 'union' with unionVariant 'anyOf' (at least one member must match)
  if (raw['anyOf']) {
    const members = (raw['anyOf'] as JsonObject[]).map((m, i) =>
      convertNode(m as JsonObject, `${name}[${i}]`),
    );
    return { name, kind: 'union', union: members, nullable, unionVariant: 'anyOf' };
  }

  // Handle allOf → merge into object (merge properties, required, and constraints from
  // both the parent node and every sub-schema; additionalProperties:false is preserved).
  if (raw['allOf']) {
    const merged: JsonObject = {};
    const allProps: Record<string, JsonObject> = {};
    const allRequired: string[] = [];
    let typeOnlyKind: string | undefined;

    // Inherit parent-level keywords (e.g. additionalProperties, nullable, description)
    // that sit alongside the allOf keyword itself.
    const parentKeywords = [
      'additionalProperties', 'nullable', 'description',
      'format', 'pattern', 'minLength', 'maxLength',
      'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
      'enum',
    ];
    for (const key of parentKeywords) {
      if (raw[key] !== undefined) merged[key] = raw[key] as JsonObject;
    }

    for (const sub of raw['allOf'] as JsonObject[]) {
      const s = sub as JsonObject;
      if (s['properties']) {
        Object.assign(allProps, s['properties'] as Record<string, JsonObject>);
      }
      if (Array.isArray(s['required'])) {
        allRequired.push(...(s['required'] as string[]));
      }
      // Merge sub-schema keywords (last write wins for scalars; additionalProperties:false wins)
      for (const key of parentKeywords) {
        if (s[key] !== undefined) {
          // additionalProperties: false must win over true/absent
          if (key === 'additionalProperties' && s[key] === false) {
            merged[key] = false as unknown as JsonObject;
          } else if (merged[key] === undefined || merged[key] !== false) {
            merged[key] = s[key] as JsonObject;
          }
        }
      }
      // Track type from members that have a type (with or without properties)
      if (s['type']) {
        typeOnlyKind = s['type'] as string;
      }
    }

    if (Object.keys(allProps).length > 0) {
      merged['type'] = 'object';
      merged['properties'] = allProps;
      if (allRequired.length > 0) merged['required'] = allRequired;
    } else if (typeOnlyKind) {
      merged['type'] = typeOnlyKind;
    }
    return convertNode(Object.keys(merged).length > 0 ? merged : { type: 'any' }, name);
  }

  const kind = mapOasType(raw);

  if (kind === 'object') {
    const rawProps = (raw['properties'] as Record<string, JsonObject> | undefined) ?? {};
    const properties: Record<string, ObjectGraphSchema> = {};
    for (const [k, v] of Object.entries(rawProps)) {
      properties[k] = convertNode(v as JsonObject, `${name}.${k}`);
    }
    const required = Array.isArray(raw['required'])
      ? (raw['required'] as string[])
      : undefined;

    let addlProps: boolean | ObjectGraphSchema = false;
    const rawAddl = raw['additionalProperties'];
    if (rawAddl === true) addlProps = true;
    else if (rawAddl && typeof rawAddl === 'object') {
      addlProps = convertNode(rawAddl as JsonObject, `${name}.__additional`);
    }

    return {
      name,
      kind,
      properties,
      required,
      nullable,
      additionalProperties: addlProps,
      description: raw['description'] as string | undefined,
    };
  }

  if (kind === 'array') {
    const rawItems = raw['items'] as JsonObject | undefined;
    const items = rawItems ? convertNode(rawItems, `${name}[]`) : undefined;
    return { name, kind, items, nullable, description: raw['description'] as string | undefined };
  }

  if (kind === 'string') {
    return {
      name,
      kind,
      format: raw['format'] as string | undefined,
      enum: raw['enum'] as string[] | undefined,
      nullable,
      description: raw['description'] as string | undefined,
      minLength: raw['minLength'] as number | undefined,
      maxLength: raw['maxLength'] as number | undefined,
      pattern: raw['pattern'] as string | undefined,
    };
  }

  if (kind === 'union') {
    // type was an array
    const types = raw['type'] as string[];
    const nonNull = types.filter((t) => t !== 'null');
    const members = nonNull.map((t, i) => convertNode({ type: t }, `${name}[${i}]`));
    return { name, kind: 'union', union: members, nullable: true };
  }

  return {
    name,
    kind,
    nullable,
    description: raw['description'] as string | undefined,
    enum: raw['enum'] as string[] | undefined,
    minimum: raw['minimum'] as number | undefined,
    maximum: raw['maximum'] as number | undefined,
    exclusiveMinimum: raw['exclusiveMinimum'] as number | undefined,
    exclusiveMaximum: raw['exclusiveMaximum'] as number | undefined,
  };
}

// ── public API ─────────────────────────────────────────────────────────────────

export function deriveSchemasFromOpenApi(
  doc: OpenApiDoc,
  boundaries: readonly BoundaryConfig[],
): ObjectGraphSchemaRegistry {
  const rawDoc = doc.raw as JsonObject;
  const components = rawDoc['components'] as JsonObject | undefined;
  const schemas = (components?.['schemas'] as Record<string, JsonObject> | undefined) ?? {};

  const byBoundary: Record<string, BoundarySchemas> = {};

  for (const b of boundaries) {
    const boundaryName = b.boundary;
    const rawSchema = schemas[boundaryName];
    if (!rawSchema) {
      throw new BootError(
        'BOOT_ERR_SCHEMA_MISSING',
        `OpenAPI components.schemas.${boundaryName} not found`,
        { boundary: boundaryName },
      );
    }

    // Detect unsupported top-level features
    if (rawSchema['discriminator']) {
      throw new BootError(
        'BOOT_ERR_SCHEMA_UNSUPPORTED',
        `Discriminator not supported in boundary schema '${boundaryName}'`,
        { boundary: boundaryName, feature: 'discriminator' },
      );
    }

    const entity = convertNode(rawSchema, boundaryName);
    const arrayPaths = collectArrayPaths(entity, '');

    byBoundary[boundaryName] = { boundary: boundaryName, entity, arrayPaths };
  }

  return {
    byBoundary,
    get(boundary: string) {
      return byBoundary[boundary];
    },
  };
}
