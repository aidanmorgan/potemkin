/**
 * Form-field type metadata, published to the plugin so it can convert
 * x-www-form-urlencoded requests into typed JSON before forwarding to the engine.
 *
 * The engine stays JSON-only: it does NOT decode form bodies. This endpoint only
 * EXPOSES, per operation, which form fields are integer/number/boolean — derived
 * from the $ref-resolved OpenAPI — so the plugin (the HTTP/contract bridge) can
 * coerce Specmatic's parsed form fields to the contract's declared types.
 */
import type { Request, Response } from 'express';
import type { OpenApiDoc } from './loader.js';
import { isRecord } from '../contracts/value.js';
import { httpMethods, type HttpMethod } from '../domain/references.js';

/** The only runtime state needed by the form-field projection. */
export interface FormFieldsRuntimeHost {
  readonly openapi: OpenApiDoc;
}

/** Coercible primitive types (string needs no coercion and is omitted). */
export type FormFieldType = 'integer' | 'number' | 'boolean';

export interface FormFieldOperation {
  /** Uppercase HTTP method. */
  readonly method: HttpMethod;
  /** OpenAPI path template, e.g. /v1/customers/{customer}. */
  readonly pathPattern: string;
  /** Field name → declared coercible type. */
  readonly fields: Readonly<Record<string, FormFieldType>>;
}

export interface FormFieldsResponse {
  readonly operations: readonly FormFieldOperation[];
  readonly engine: string;
}

const FORM_MEDIA_TYPE = 'application/x-www-form-urlencoded';

interface OpenApiSchemaNode {
  readonly properties?: unknown;
}

interface OpenApiMediaTypeNode {
  readonly schema?: OpenApiSchemaNode;
}

interface OpenApiRequestBodyNode {
  readonly content?: Readonly<Record<string, unknown>>;
}

interface OpenApiOperationNode {
  readonly requestBody?: OpenApiRequestBodyNode;
}

interface OpenApiPathItemNode {
  readonly [key: string]: unknown;
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return isRecord(v) ? v : undefined;
}

function asOperation(v: unknown): OpenApiOperationNode | undefined {
  const operation = asObject(v);
  if (operation === undefined) return undefined;
  const requestBody = asRequestBody(operation['requestBody']);
  return requestBody === undefined ? {} : { requestBody };
}

function asPathItem(v: unknown): OpenApiPathItemNode | undefined {
  return isRecord(v) ? v : undefined;
}

function asRequestBody(v: unknown): OpenApiRequestBodyNode | undefined {
  const requestBody = asObject(v);
  if (requestBody === undefined) return undefined;
  const content = asObject(requestBody['content']);
  return content === undefined ? {} : { content };
}

function asMediaType(v: unknown): OpenApiMediaTypeNode | undefined {
  const mediaType = asObject(v);
  if (mediaType === undefined) return undefined;
  const schema = asObject(mediaType['schema']);
  return schema === undefined ? {} : { schema };
}

function pathItemsOf(raw: unknown): Readonly<Record<string, OpenApiPathItemNode>> {
  const paths = asObject(asObject(raw)?.['paths']);
  if (paths === undefined) return {};

  const pathItems: Record<string, OpenApiPathItemNode> = {};
  for (const [pathPattern, pathItemRaw] of Object.entries(paths)) {
    const pathItem = asPathItem(pathItemRaw);
    if (pathItem !== undefined) pathItems[pathPattern] = pathItem;
  }
  return pathItems;
}

/** The form-urlencoded request schema for an operation, if declared. */
function formSchemaOf(op: OpenApiOperationNode): OpenApiSchemaNode | undefined {
  const content = op.requestBody?.content;
  return asMediaType(content?.[FORM_MEDIA_TYPE])?.schema;
}

/**
 * Walk the resolved OpenAPI and collect, per operation that has a form-urlencoded
 * request body, the fields whose declared type is integer/number/boolean.
 */
export function buildFormFieldOperations(openapi: OpenApiDoc): FormFieldOperation[] {
  const out: FormFieldOperation[] = [];
  for (const [pathPattern, pathItem] of Object.entries(pathItemsOf(openapi.raw))) {
    for (const method of httpMethods) {
      const op = asOperation(pathItem[method.toLowerCase()]);
      if (op === undefined) continue;
      const schema = formSchemaOf(op);
      const props = asObject(schema?.properties);
      if (props === undefined) continue;
      const fields: Record<string, FormFieldType> = {};
      for (const [name, propRaw] of Object.entries(props)) {
        const t = asObject(propRaw)?.['type'];
        if (t === 'integer' || t === 'number' || t === 'boolean') fields[name] = t;
      }
      if (Object.keys(fields).length > 0) {
        out.push({ method, pathPattern, fields });
      }
    }
  }
  return out;
}

/** GET /_engine/form-fields — static metadata computed once at registration. */
export function createFormFieldsHandler(sys: FormFieldsRuntimeHost) {
  const operations = buildFormFieldOperations(sys.openapi);
  const body: FormFieldsResponse = { operations, engine: 'potemkin-stateful' };
  return function formFieldsHandler(_req: Request, res: Response): void {
    res.status(200).json(body);
  };
}
