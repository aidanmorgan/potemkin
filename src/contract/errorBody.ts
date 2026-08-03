import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { OpenApiDoc } from "./loader.js";
import { resolveResponseSchema } from "./responseSchema.js";
import type { JsonObject, JsonValue } from "../types.js";

/** Context copied from a Potemkin error without coupling this module to error classes. */
export interface ContractErrorContext {
  readonly code?: string;
  readonly message?: string;
  readonly details?: JsonValue;
}

/** Optional inputs used when a contract constrains generated error values. */
export interface ContractErrorBodyOptions {
  /** Engine error code -> contract enum/string value. */
  readonly codeMap?: Readonly<Record<string, string>>;
  /** Server/request virtual clock offset, in milliseconds. */
  readonly clockOffsetMs?: number;
  /** Test or host supplied clock. Overrides clockOffsetMs when supplied. */
  readonly now?: () => string;
}

interface SchemaNode {
  readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function localRefTarget(doc: OpenApiDoc, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  const parts = ref
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cursor: unknown = doc.raw;
  for (const part of parts) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function mergeSchemaParts(parts: readonly SchemaNode[]): SchemaNode {
  const merged: Record<string, unknown> = {};
  const properties: Record<string, unknown> = {};
  const required = new Set<string>();

  for (const part of parts) {
    for (const [key, value] of Object.entries(part)) {
      if (key === "properties" && isRecord(value)) {
        Object.assign(properties, value);
      } else if (key === "required" && Array.isArray(value)) {
        for (const item of value) if (typeof item === "string") required.add(item);
      } else {
        merged[key] = value;
      }
    }
  }

  if (Object.keys(properties).length > 0) merged.properties = properties;
  if (required.size > 0) merged.required = [...required];
  return merged;
}

/**
 * Resolve local references and the schema combinators used by the fill
 * algorithm. `oneOf`/`anyOf` deliberately select their first branch: the
 * generated error body must be stable even when several branches are valid.
 */
function resolveForFill(
  doc: OpenApiDoc,
  schema: unknown,
  refs: Set<unknown> = new Set(),
): SchemaNode {
  if (!isRecord(schema)) return {};

  if (typeof schema["$ref"] === "string") {
    const target = localRefTarget(doc, schema["$ref"]);
    if (target === undefined || refs.has(target)) return {};
    const nextRefs = new Set(refs);
    nextRefs.add(target);
    const resolvedTarget = resolveForFill(doc, target, nextRefs);
    const siblings = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$ref"));
    return Object.keys(siblings).length > 0
      ? mergeSchemaParts([resolvedTarget, resolveForFill(doc, siblings, refs)])
      : resolvedTarget;
  }

  if (Array.isArray(schema["allOf"])) {
    const parts = schema["allOf"].map((part) => resolveForFill(doc, part, refs));
    const siblings = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "allOf"));
    if (Object.keys(siblings).length > 0) parts.push(resolveForFill(doc, siblings, refs));
    return mergeSchemaParts(parts);
  }

  for (const combinator of ["oneOf", "anyOf"] as const) {
    if (Array.isArray(schema[combinator]) && schema[combinator].length > 0) {
      const first = resolveForFill(doc, schema[combinator][0], refs);
      const siblings = Object.fromEntries(
        Object.entries(schema).filter(([key]) => key !== combinator),
      );
      return Object.keys(siblings).length > 0
        ? mergeSchemaParts([first, resolveForFill(doc, siblings, refs)])
        : first;
    }
  }

  const out: Record<string, unknown> = { ...schema };
  if (isRecord(schema["properties"])) {
    out.properties = Object.fromEntries(
      Object.entries(schema["properties"]).map(([key, value]) => [
        key,
        resolveForFill(doc, value, refs),
      ]),
    );
  }
  if (isRecord(schema["items"])) out.items = resolveForFill(doc, schema["items"], refs);
  return out;
}

function virtualNow(options: ContractErrorBodyOptions): string {
  // Runtime callers always supply the injected helper clock. A deterministic
  // epoch keeps standalone static analysis pure when no host clock exists.
  const base = options.now?.() ?? "1970-01-01T00:00:00.000Z";
  const offset = Number.isFinite(options.clockOffsetMs ?? NaN) ? options.clockOffsetMs! : 0;
  const timestamp = Date.parse(base);
  return new Date((Number.isFinite(timestamp) ? timestamp : 0) + offset).toISOString();
}

function formatValue(format: string, options: ContractErrorBodyOptions): string {
  const now = virtualNow(options);
  switch (format) {
    case "date":
      return now.slice(0, 10);
    case "date-time":
      return now;
    case "time":
      return now.slice(11);
    case "uuid":
      return "00000000-0000-4000-8000-000000000000";
    case "email":
      return "error@example.com";
    case "uri":
    case "uri-reference":
    case "url":
      return "https://example.com/error";
    case "hostname":
      return "example.com";
    case "ipv4":
      return "127.0.0.1";
    default:
      return "";
  }
}

function patternValue(pattern: string): string {
  const candidates = [
    "",
    "0",
    "A",
    "a",
    "x",
    "error",
    "error-0",
    "00000000-0000-4000-8000-000000000000",
  ];
  for (const candidate of candidates) {
    try {
      if (new RegExp(pattern).test(candidate)) return candidate;
    } catch {
      return "";
    }
  }

  // Small deterministic generator for the common anchored patterns used in
  // API error codes, such as ^ERR_[A-Z]+$ and ^item-[0-9]+$.
  const core = pattern.replace(/^\^/, "").replace(/\$$/, "");
  let result = "";
  for (let i = 0; i < core.length; i += 1) {
    const rest = core.slice(i);
    let token = "";
    if (rest.startsWith("\\d")) {
      token = "0";
      i += 1;
    } else if (rest.startsWith("\\w")) {
      token = "a";
      i += 1;
    } else {
      const cls = /^\[([^\]]+)\]/.exec(rest);
      if (cls) {
        const chars = cls[1];
        token = chars.includes("A-Z")
          ? "A"
          : chars.includes("a-z")
            ? "a"
            : chars.includes("0-9")
              ? "0"
              : (chars[0] ?? "");
        i += cls[0].length - 1;
      } else if (rest.startsWith("(?:")) {
        const close = rest.indexOf(")");
        if (close > 3) {
          token = rest.slice(3, close).split("|")[0] ?? "";
          i += close;
        }
      } else if (core[i] === ".") {
        token = "x";
      } else if ("+*?".includes(core[i] ?? "")) {
        token = "";
      } else {
        token = core[i] ?? "";
      }
    }
    result += token;
    const quantifier = core[i + 1];
    if (quantifier === "+" && token.length > 0) result += token;
    if (quantifier === "?") i += 1;
    if (quantifier === "+" || quantifier === "*") i += 1;
  }
  try {
    return new RegExp(pattern).test(result) ? result : "";
  } catch {
    return "";
  }
}

function stringValue(
  schema: SchemaNode,
  field: string | undefined,
  context: ContractErrorContext,
  options: ContractErrorBodyOptions,
): string {
  if (field === "error" && context.code !== undefined)
    return options.codeMap?.[context.code] ?? context.code;
  if (field === "message" && context.message !== undefined) return context.message;
  if ((field === "code" || field === "type") && context.code !== undefined) {
    return (
      options.codeMap?.[context.code] ??
      (Array.isArray(schema["enum"]) && typeof schema["enum"][0] === "string"
        ? schema["enum"][0]
        : context.code)
    );
  }
  if (typeof schema["format"] === "string") return formatValue(schema["format"], options);
  if (typeof schema["pattern"] === "string") return patternValue(schema["pattern"]);
  const minLength = typeof schema["minLength"] === "number" ? schema["minLength"] : 0;
  return "x".repeat(Math.max(0, minLength));
}

function fillSchema(
  doc: OpenApiDoc,
  schema: SchemaNode,
  context: ContractErrorContext,
  options: ContractErrorBodyOptions,
  field?: string,
): JsonValue {
  if (isJsonValue(schema["const"])) return schema["const"];
  if (
    Array.isArray(schema["enum"]) &&
    schema["enum"].length > 0 &&
    isJsonValue(schema["enum"][0])
  ) {
    if ((field === "code" || field === "type" || field === "error") && context.code !== undefined) {
      const mapped = options.codeMap?.[context.code];
      // The boot lint deliberately validates an injected map. Do not silently
      // replace a stale mapped value here; otherwise the lint could never
      // report that the configured contract value is invalid.
      if (mapped !== undefined) return mapped;
    }
    return schema["enum"][0];
  }

  const type = Array.isArray(schema["type"])
    ? schema["type"].find((item): item is string => typeof item === "string" && item !== "null")
    : schema["type"];

  if (type === "object" || isRecord(schema["properties"])) {
    const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
    const required = Array.isArray(schema["required"])
      ? schema["required"].filter((item): item is string => typeof item === "string")
      : [];
    // An unconstrained object schema explicitly permits any properties. Keep
    // the useful engine fields in that case instead of replacing a structured
    // diagnostic with `{}`; there are no contract fields to fill or constrain.
    if (required.length === 0 && Object.keys(properties).length === 0) {
      const openBody: JsonObject = {};
      if (context.code !== undefined)
        openBody.code = options.codeMap?.[context.code] ?? context.code;
      if (context.message !== undefined) openBody.message = context.message;
      if (context.details !== undefined) openBody.details = context.details;
      return openBody;
    }
    const nestedErrorEnvelope =
      isRecord(properties["error"]) &&
      (properties["error"]["type"] === "object" ||
        isRecord(properties["error"]["properties"]) ||
        properties["error"]["$ref"] !== undefined);
    const out: JsonObject = {};
    for (const key of required) {
      const child = resolveForFill(doc, properties[key]);
      if (key === "details" && context.details !== undefined) {
        out[key] = context.details;
      } else if (key === "error" && !nestedErrorEnvelope && context.code !== undefined) {
        out[key] = options.codeMap?.[context.code] ?? context.code;
      } else if (key === "message" && context.message !== undefined) {
        out[key] = context.message;
      } else {
        out[key] = fillSchema(
          doc,
          child,
          context,
          options,
          nestedErrorEnvelope
            ? key === "message" && context.code !== undefined && context.message === undefined
              ? "message"
              : key
            : key,
        );
      }
    }
    // Error message/code are engine-known values. They may be optional in the
    // contract (Stripe's nested error object is an example), but retaining them
    // makes the shaped response useful without changing the required-only fill
    // policy for unrelated fields.
    if (
      isRecord(properties["message"]) &&
      !Object.prototype.hasOwnProperty.call(out, "message") &&
      (context.message !== undefined || context.code !== undefined)
    ) {
      const message =
        nestedErrorEnvelope &&
        context.code !== undefined &&
        options.codeMap?.[context.code] === undefined
          ? `${context.code}${context.message ? `: ${context.message}` : ""}`
          : (context.message ?? context.code ?? "");
      out.message = message;
    }
    if (
      isRecord(properties["code"]) &&
      !Object.prototype.hasOwnProperty.call(out, "code") &&
      context.code !== undefined
    ) {
      out.code = fillSchema(doc, resolveForFill(doc, properties["code"]), context, options, "code");
    }
    // Preserve engine diagnostics when the contract exposes an optional
    // `details` field.  Error schemas commonly require only the top-level
    // error code, but dropping the guard/authentication sub-code makes the
    // response materially less useful to callers and regresses the generic
    // Potemkin error envelope.
    if (
      isRecord(properties["details"]) &&
      !Object.prototype.hasOwnProperty.call(out, "details") &&
      context.details !== undefined
    ) {
      out.details = context.details;
    }
    return out;
  }

  if (type === "array" || schema["items"] !== undefined) {
    const minItems =
      typeof schema["minItems"] === "number" ? Math.max(0, Math.floor(schema["minItems"])) : 0;
    const itemSchema = resolveForFill(doc, schema["items"]);
    return Array.from({ length: minItems }, () => fillSchema(doc, itemSchema, context, options));
  }
  if (type === "number" || type === "integer") {
    if (typeof schema["minimum"] === "number" && schema["minimum"] > 0) return schema["minimum"];
    return 0;
  }
  if (type === "boolean") return false;
  if (type === "null") return null;
  return stringValue(schema, field, context, options);
}

/**
 * Build a deterministic body for a declared error response. `undefined` means
 * that the operation/status pair has no usable response schema; callers must
 * retain their existing generic body in that case.
 */
export function buildContractErrorBody(
  doc: OpenApiDoc,
  method: string,
  path: string,
  status: number,
  context: ContractErrorContext = {},
  options: ContractErrorBodyOptions = {},
): JsonValue | undefined {
  const schema = resolveResponseSchema(doc, method, path, status);
  if (schema === undefined) return undefined;
  return fillSchema(doc, resolveForFill(doc, schema), context, options);
}

function resolveRefsForValidation(
  doc: OpenApiDoc,
  value: unknown,
  refs: Set<unknown> = new Set(),
): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveRefsForValidation(doc, item, refs));
  if (!isRecord(value)) return value;
  if (typeof value["$ref"] === "string") {
    const target = localRefTarget(doc, value["$ref"]);
    if (target === undefined || refs.has(target)) return {};
    const nextRefs = new Set(refs);
    nextRefs.add(target);
    return resolveRefsForValidation(doc, target, nextRefs);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, resolveRefsForValidation(doc, item, refs)]),
  );
}

export interface ContractBodyValidation {
  readonly valid: boolean;
  readonly errors?: readonly unknown[];
}

/** Validate a static/runtime body using the same operation/status resolver. */
export function validateContractErrorBody(
  doc: OpenApiDoc,
  method: string,
  path: string,
  status: number,
  body: JsonValue,
): ContractBodyValidation {
  const schema = resolveResponseSchema(doc, method, path, status);
  if (schema === undefined) return { valid: true };
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  addFormats(ajv);
  // The resolver preserves JSON-schema objects while replacing local refs;
  // narrow the result for Ajv's schema overload after that structural walk.
  const validate = ajv.compile(resolveRefsForValidation(doc, schema) as Record<string, unknown>);
  const valid = validate(body);
  return valid ? { valid } : { valid, errors: validate.errors ?? [] };
}
