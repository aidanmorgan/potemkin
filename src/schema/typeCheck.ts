import { validate as validateUuid } from 'uuid';
import { isJsonObject } from '../contracts/value.js';
import type { JsonObject, JsonValue } from '../contracts/value.js';
import type { ObjectGraphSchema, SchemaTypeKind } from './types.js';
import { createNoopTracer, withSpan, type Tracer } from '../observability/tracing.js';
import { detectCatastrophicRegexShape } from './regexSafety.js';

// ── pattern validation (ReDoS-safe) ───────────────────────────────────────────

/**
 * Compile a pattern string to a RegExp after checking for catastrophic-backtracking
 * shapes. Throws a descriptive error rather than running an unsafe pattern.
 */
function compilePatternSafe(pattern: string): RegExp {
  const reason = detectCatastrophicRegexShape(pattern);
  if (reason !== null) {
    throw new Error(
      `SCHEMA_PATTERN_REJECTED: pattern /${pattern}/ has a ${reason} known to backtrack catastrophically`,
    );
  }
  return new RegExp(pattern);
}

// ── format validation ─────────────────────────────────────────────────────────

const FORMAT_PATTERNS: Record<string, RegExp> = {
  'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
};

function validateFormat(value: string, format: string): boolean {
  if (format === 'uuid') return validateUuid(value);
  const pattern = FORMAT_PATTERNS[format];
  if (!pattern) return true; // unknown format → lenient
  return pattern.test(value);
}

function enumContains(schema: ObjectGraphSchema, value: JsonValue): boolean {
  const values = schema.enum;
  return values !== undefined && values.length > 0 && values.includes(value);
}

function unionMatchCount(value: JsonValue, schema: ObjectGraphSchema): number {
  return (schema.union ?? []).filter((member) => isAssignable(value, member)).length;
}

function numericConstraintErrors(value: number, schema: ObjectGraphSchema): string[] {
  const errors: string[] = [];
  if (schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`value ${value} is less than minimum ${schema.minimum}`);
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    errors.push(`value ${value} is greater than maximum ${schema.maximum}`);
  }
  if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
    errors.push(`value ${value} is not greater than exclusiveMinimum ${schema.exclusiveMinimum}`);
  }
  if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
    errors.push(`value ${value} is not less than exclusiveMaximum ${schema.exclusiveMaximum}`);
  }
  return errors;
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
    if (target.unionVariant === 'oneOf') {
      return unionMatchCount(value, target) === 1;
    }
    return unionMatchCount(value, target) > 0;
  }

  if (target.kind === 'null') return value === null;

  // Enum check applies to all primitive kinds
  if (enumContains(target, value)) return true;
  if (target.enum !== undefined && target.enum.length > 0) return false;

  if (target.kind === 'integer') {
    return (
      typeof value === 'number' &&
      Number.isInteger(value) &&
      numericConstraintErrors(value, target).length === 0
    );
  }

  if (target.kind === 'number') {
    return typeof value === 'number' && numericConstraintErrors(value, target).length === 0;
  }

  if (target.kind === 'boolean') return kind === 'boolean';

  if (target.kind === 'string') {
    if (typeof value !== 'string') return false;
    const s = value;
    if (target.minLength !== undefined && s.length < target.minLength) return false;
    if (target.maxLength !== undefined && s.length > target.maxLength) return false;
    if (target.pattern !== undefined && !compilePatternSafe(target.pattern).test(s)) return false;
    if (target.format !== undefined && !validateFormat(s, target.format)) return false;
    return true;
  }

  if (target.kind === 'array') {
    if (!Array.isArray(value)) return false;
    const items = target.items;
    if (items !== undefined) return value.every((item) => isAssignable(item, items));
    return true;
  }

  if (target.kind === 'object') {
    if (!isJsonObject(value)) return false;
    const obj = value;
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
        if (typeof addlProps === 'object' && !isAssignable(v, addlProps)) return false;
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
    if (schema.unionVariant === 'oneOf') {
      const matchCount = unionMatchCount(value, schema);
      if (matchCount !== 1) {
        errors.push({
          path,
          reason:
            matchCount === 0
              ? `value does not match any oneOf member`
              : `value matches ${matchCount} oneOf members (exactly one required)`,
        });
      }
    } else {
      if (unionMatchCount(value, schema) === 0) {
        errors.push({
          path,
          reason: `value does not match any union member`,
        });
      }
    }
    return;
  }

  const kind = typeOfJson(value);

  // Enum check applies across all primitive kinds
  if (schema.enum !== undefined && schema.enum.length > 0 && !enumContains(schema, value)) {
    errors.push({
      path,
      reason: `value '${String(value)}' not in enum ${JSON.stringify(schema.enum)}`,
    });
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
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      errors.push({ path, reason: `expected integer, got ${kind}` });
      return;
    }
    for (const reason of numericConstraintErrors(value, schema)) errors.push({ path, reason });
    return;
  }

  if (schema.kind === 'number') {
    if (typeof value !== 'number') {
      errors.push({ path, reason: `expected number, got ${kind}` });
      return;
    }
    for (const reason of numericConstraintErrors(value, schema)) errors.push({ path, reason });
    return;
  }

  if (schema.kind === 'string') {
    if (typeof value !== 'string') {
      errors.push({ path, reason: `expected string, got ${kind}` });
      return;
    }
    const s = value;
    if (schema.minLength !== undefined && s.length < schema.minLength)
      errors.push({
        path,
        reason: `string length ${s.length} is less than minLength ${schema.minLength}`,
      });
    if (schema.maxLength !== undefined && s.length > schema.maxLength)
      errors.push({
        path,
        reason: `string length ${s.length} is greater than maxLength ${schema.maxLength}`,
      });
    if (schema.pattern !== undefined) {
      const compiled = compilePatternSafe(schema.pattern);
      if (!compiled.test(s))
        errors.push({ path, reason: `string '${s}' does not match pattern ${schema.pattern}` });
    }
    if (schema.format !== undefined && !validateFormat(s, schema.format))
      errors.push({ path, reason: `string '${s}' does not match format '${schema.format}'` });
    return;
  }

  if (schema.kind === 'array') {
    if (!Array.isArray(value)) {
      errors.push({ path, reason: `expected array, got ${kind}` });
      return;
    }
    const items = schema.items;
    if (items !== undefined) {
      value.forEach((item, i) => validateNode(item, items, `${path}[${i}]`, errors));
    }
    return;
  }

  if (schema.kind === 'object') {
    if (!isJsonObject(value)) {
      errors.push({ path, reason: `expected object, got ${kind}` });
      return;
    }
    const obj = value;
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
        validateNode(v, addlProps, childPath, errors);
      }
      // addlProps === true → allow any value
    }
    return;
  }
}

export async function validateEntityAgainstSchema(
  entity: JsonObject,
  schema: ObjectGraphSchema,
  options: { readonly tracer?: Tracer } = {},
): Promise<{ ok: true } | { ok: false; errors: readonly ValidationError[] }> {
  return withSpan(
    options.tracer ?? createNoopTracer(),
    'schema.validateEntity',
    () => {
      const errors: ValidationError[] = [];
      validateNode(entity, schema, '', errors);
      if (errors.length === 0) return { ok: true as const };
      return { ok: false as const, errors };
    },
    { 'schema.name': schema.name },
  );
}
