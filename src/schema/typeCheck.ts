import type { JsonValue, JsonObject } from '../types.js';
import type { ObjectGraphSchema, SchemaTypeKind } from './types.js';
import { getTracer, withSpan } from '../observability/tracing.js';

// ── format validation ─────────────────────────────────────────────────────────

const FORMAT_PATTERNS: Record<string, RegExp> = {
  uuid: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
};

function validateFormat(value: string, format: string): boolean {
  const pattern = FORMAT_PATTERNS[format];
  if (!pattern) return true; // unknown format → lenient
  return pattern.test(value);
}

// ── helpers ────────────────────────────────────────────────────────────────────

export function typeOfJson(v: JsonValue): SchemaTypeKind {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  if (typeof v === 'string') return 'string';
  if (Array.isArray(v)) return 'array';
  return 'object';
}

/**
 * Returns true when `value` is structurally assignable to `target`.
 *
 * Rules:
 *  - kind === 'any'                             → always true
 *  - nullable && value === null                 → true
 *  - kind === 'union'                           → true if assignable to any member
 *  - kind === 'integer'                         → value must be integer or number (integers are numbers)
 *  - kind === 'number'                          → value must be number or integer
 *  - kind === 'string' with enum                → value must be one of the enum values
 *  - kind === 'object' with additionalProperties === false → no extra keys allowed
 *  - kind === 'array'                           → value must be array; items checked if schema has items
 */
export function isAssignable(value: JsonValue, target: ObjectGraphSchema): boolean {
  if (target.kind === 'any') return true;
  if (value === null) return target.nullable === true || target.kind === 'null';

  const kind = typeOfJson(value);

  if (target.kind === 'union') {
    return (target.union ?? []).some((member) => isAssignable(value, member));
  }

  if (target.kind === 'null') return value === null;

  // Enum check applies to all primitive kinds
  if (target.enum && target.enum.length > 0) {
    return (target.enum as JsonValue[]).includes(value);
  }

  if (target.kind === 'integer') {
    if (kind !== 'integer') return false;
    const n = value as number;
    if (target.minimum !== undefined && n < target.minimum) return false;
    if (target.maximum !== undefined && n > target.maximum) return false;
    if (target.exclusiveMinimum !== undefined && n <= target.exclusiveMinimum) return false;
    if (target.exclusiveMaximum !== undefined && n >= target.exclusiveMaximum) return false;
    return true;
  }

  if (target.kind === 'number') {
    if (kind !== 'integer' && kind !== 'number') return false;
    const n = value as number;
    if (target.minimum !== undefined && n < target.minimum) return false;
    if (target.maximum !== undefined && n > target.maximum) return false;
    if (target.exclusiveMinimum !== undefined && n <= target.exclusiveMinimum) return false;
    if (target.exclusiveMaximum !== undefined && n >= target.exclusiveMaximum) return false;
    return true;
  }

  if (target.kind === 'boolean') return kind === 'boolean';

  if (target.kind === 'string') {
    if (kind !== 'string') return false;
    const s = value as string;
    if (target.minLength !== undefined && s.length < target.minLength) return false;
    if (target.maxLength !== undefined && s.length > target.maxLength) return false;
    if (target.pattern !== undefined && !new RegExp(target.pattern).test(s)) return false;
    if (target.format !== undefined && !validateFormat(s, target.format)) return false;
    return true;
  }

  if (target.kind === 'array') {
    if (!Array.isArray(value)) return false;
    if (target.items) {
      return (value as JsonValue[]).every((item) => isAssignable(item, target.items!));
    }
    return true;
  }

  if (target.kind === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) return false;
    const obj = value as JsonObject;
    const props = target.properties ?? {};
    const required = target.required ?? [];
    const addlProps = target.additionalProperties;

    // Check required fields are present
    for (const req of required) {
      if (!(req in obj)) return false;
    }

    // Check each value against its property schema
    for (const [k, v] of Object.entries(obj)) {
      if (props[k]) {
        if (!isAssignable(v, props[k])) return false;
      } else {
        // Unknown property
        if (addlProps === false || addlProps === undefined) return false;
        if (typeof addlProps === 'object') {
          if (!isAssignable(v, addlProps as ObjectGraphSchema)) return false;
        }
        // addlProps === true → allowed
      }
    }

    return true;
  }

  return false;
}

// ── entity validation ──────────────────────────────────────────────────────────

interface ValidationError {
  path: string;
  reason: string;
}

function validateNode(
  value: JsonValue,
  schema: ObjectGraphSchema,
  path: string,
  errors: ValidationError[],
): void {
  if (schema.kind === 'any') return;

  if (value === null) {
    if (!schema.nullable && schema.kind !== 'null') {
      errors.push({ path, reason: `null not permitted (nullable: false)` });
    }
    return;
  }

  if (schema.kind === 'union') {
    const ok = (schema.union ?? []).some((m) => isAssignable(value, m));
    if (!ok) {
      errors.push({
        path,
        reason: `value does not match any union member`,
      });
    }
    return;
  }

  const kind = typeOfJson(value);

  // Enum check applies across all primitive kinds
  if (schema.enum && schema.enum.length > 0 && !(schema.enum as JsonValue[]).includes(value)) {
    errors.push({ path, reason: `value '${String(value)}' not in enum ${JSON.stringify(schema.enum)}` });
    return;
  }

  if (schema.kind === 'null') {
    if (value !== null) errors.push({ path, reason: `expected null` });
    return;
  }

  if (schema.kind === 'boolean') {
    if (kind !== 'boolean') errors.push({ path, reason: `expected boolean, got ${kind}` });
    return;
  }

  if (schema.kind === 'integer') {
    if (kind !== 'integer') {
      errors.push({ path, reason: `expected integer, got ${kind}` });
      return;
    }
    const n = value as number;
    if (schema.minimum !== undefined && n < schema.minimum)
      errors.push({ path, reason: `value ${n} is less than minimum ${schema.minimum}` });
    if (schema.maximum !== undefined && n > schema.maximum)
      errors.push({ path, reason: `value ${n} is greater than maximum ${schema.maximum}` });
    if (schema.exclusiveMinimum !== undefined && n <= schema.exclusiveMinimum)
      errors.push({ path, reason: `value ${n} is not greater than exclusiveMinimum ${schema.exclusiveMinimum}` });
    if (schema.exclusiveMaximum !== undefined && n >= schema.exclusiveMaximum)
      errors.push({ path, reason: `value ${n} is not less than exclusiveMaximum ${schema.exclusiveMaximum}` });
    return;
  }

  if (schema.kind === 'number') {
    if (kind !== 'integer' && kind !== 'number') {
      errors.push({ path, reason: `expected number, got ${kind}` });
      return;
    }
    const n = value as number;
    if (schema.minimum !== undefined && n < schema.minimum)
      errors.push({ path, reason: `value ${n} is less than minimum ${schema.minimum}` });
    if (schema.maximum !== undefined && n > schema.maximum)
      errors.push({ path, reason: `value ${n} is greater than maximum ${schema.maximum}` });
    if (schema.exclusiveMinimum !== undefined && n <= schema.exclusiveMinimum)
      errors.push({ path, reason: `value ${n} is not greater than exclusiveMinimum ${schema.exclusiveMinimum}` });
    if (schema.exclusiveMaximum !== undefined && n >= schema.exclusiveMaximum)
      errors.push({ path, reason: `value ${n} is not less than exclusiveMaximum ${schema.exclusiveMaximum}` });
    return;
  }

  if (schema.kind === 'string') {
    if (kind !== 'string') {
      errors.push({ path, reason: `expected string, got ${kind}` });
      return;
    }
    const s = value as string;
    if (schema.minLength !== undefined && s.length < schema.minLength)
      errors.push({ path, reason: `string length ${s.length} is less than minLength ${schema.minLength}` });
    if (schema.maxLength !== undefined && s.length > schema.maxLength)
      errors.push({ path, reason: `string length ${s.length} is greater than maxLength ${schema.maxLength}` });
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(s))
      errors.push({ path, reason: `string '${s}' does not match pattern ${schema.pattern}` });
    if (schema.format !== undefined && !validateFormat(s, schema.format))
      errors.push({ path, reason: `string '${s}' does not match format '${schema.format}'` });
    return;
  }

  if (schema.kind === 'array') {
    if (!Array.isArray(value)) {
      errors.push({ path, reason: `expected array, got ${kind}` });
      return;
    }
    if (schema.items) {
      (value as JsonValue[]).forEach((item, i) => {
        validateNode(item, schema.items!, `${path}[${i}]`, errors);
      });
    }
    return;
  }

  if (schema.kind === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) {
      errors.push({ path, reason: `expected object, got ${kind}` });
      return;
    }
    const obj = value as JsonObject;
    const props = schema.properties ?? {};
    const required = schema.required ?? [];
    const addlProps = schema.additionalProperties;

    for (const req of required) {
      if (!(req in obj)) {
        errors.push({ path: path ? `${path}.${req}` : req, reason: `required field missing` });
      }
    }

    for (const [k, v] of Object.entries(obj)) {
      const childPath = path ? `${path}.${k}` : k;
      if (props[k]) {
        validateNode(v, props[k], childPath, errors);
      } else if (addlProps === false || addlProps === undefined) {
        errors.push({ path: childPath, reason: `additional property not allowed` });
      } else if (typeof addlProps === 'object') {
        validateNode(v, addlProps as ObjectGraphSchema, childPath, errors);
      }
      // addlProps === true → allow any value
    }
    return;
  }
}

export async function validateEntityAgainstSchema(
  entity: JsonObject,
  schema: ObjectGraphSchema,
): Promise<{ ok: true } | { ok: false; errors: readonly ValidationError[] }> {
  return withSpan(getTracer(), 'schema.validateEntity', () => {
    const errors: ValidationError[] = [];
    validateNode(entity, schema, '', errors);
    if (errors.length === 0) return { ok: true as const };
    return { ok: false as const, errors };
  }, { 'schema.name': schema.name });
}
