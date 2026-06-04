/**
 * Form-field type metadata, published to the plugin so it can convert
 * x-www-form-urlencoded requests into typed JSON before forwarding to the engine.
 *
 * The engine stays JSON-only: it does NOT decode form bodies. This endpoint only
 * EXPOSES, per operation, which form fields are integer/number/boolean — derived
 * from the $ref-resolved OpenAPI — so the plugin (the HTTP/contract adapter) can
 * coerce Specmatic's parsed form fields to the contract's declared types.
 */
import type { Request, Response } from 'express';
import type { BootedSystem } from '../engine/boot.js';
import type { OpenApiDoc } from './loader.js';

/** Coercible primitive types (string needs no coercion and is omitted). */
export type FormFieldType = 'integer' | 'number' | 'boolean';

export interface FormFieldOperation {
  /** Uppercase HTTP method. */
  readonly method: string;
  /** OpenAPI path template, e.g. /v1/customers/{customer}. */
  readonly pathPattern: string;
  /** Field name → declared coercible type. */
  readonly fields: Readonly<Record<string, FormFieldType>>;
}

export interface FormFieldsResponse {
  readonly operations: readonly FormFieldOperation[];
  readonly engine: string;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head'];
const FORM_MEDIA_TYPE = 'application/x-www-form-urlencoded';

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** The form-urlencoded request schema for an operation, if declared. */
function formSchemaOf(op: Record<string, unknown>): Record<string, unknown> | undefined {
  const content = asObject(asObject(op['requestBody'])?.['content']);
  const schema = asObject(asObject(content?.[FORM_MEDIA_TYPE])?.['schema']);
  return schema;
}

/**
 * Walk the resolved OpenAPI and collect, per operation that has a form-urlencoded
 * request body, the fields whose declared type is integer/number/boolean.
 */
export function buildFormFieldOperations(openapi: OpenApiDoc): FormFieldOperation[] {
  const paths = asObject(asObject(openapi.raw)?.['paths']);
  if (!paths) return [];
  const out: FormFieldOperation[] = [];
  for (const [pathPattern, pathItemRaw] of Object.entries(paths)) {
    const pathItem = asObject(pathItemRaw);
    if (!pathItem) continue;
    for (const method of HTTP_METHODS) {
      const op = asObject(pathItem[method]);
      if (!op) continue;
      const schema = formSchemaOf(op);
      const props = asObject(schema?.['properties']);
      if (!props) continue;
      const fields: Record<string, FormFieldType> = {};
      for (const [name, propRaw] of Object.entries(props)) {
        const t = asObject(propRaw)?.['type'];
        if (t === 'integer' || t === 'number' || t === 'boolean') fields[name] = t;
      }
      if (Object.keys(fields).length > 0) {
        out.push({ method: method.toUpperCase(), pathPattern, fields });
      }
    }
  }
  return out;
}

/** GET /_engine/form-fields — static metadata computed once at registration. */
export function createFormFieldsHandler(sys: BootedSystem) {
  const operations = buildFormFieldOperations(sys.openapi);
  const body: FormFieldsResponse = { operations, engine: 'potemkin-stateful' };
  return function formFieldsHandler(_req: Request, res: Response): void {
    res.status(200).json(body);
  };
}
