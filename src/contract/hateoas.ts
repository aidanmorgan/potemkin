import type { JsonObject, JsonValue } from "../types.js";
import type { OpenApiOperation } from "./loader.js";

/**
 * Return true when a schema can accept the object-valued `_links` property
 * that the global HATEOAS pass adds to an entity.
 *
 * OpenAPI's default for `additionalProperties` is permissive, so an object
 * schema without that keyword continues to support HATEOAS. A strict object
 * (`additionalProperties: false`) must opt in by declaring `_links` itself.
 * The combinator handling is deliberately conservative for `allOf`: every
 * constituent must permit the property because every constituent validates
 * the final object.
 */
function schemaAcceptsHateoasProperty(schema: JsonObject): boolean {
  const allOf = schema["allOf"];
  if (Array.isArray(allOf)) {
    return allOf.every((branch) => isJsonObject(branch) && schemaAcceptsHateoasProperty(branch));
  }

  const anyOf = schema["anyOf"];
  if (Array.isArray(anyOf)) {
    return anyOf.some((branch) => isJsonObject(branch) && schemaAcceptsHateoasProperty(branch));
  }
  const oneOf = schema["oneOf"];
  if (Array.isArray(oneOf)) {
    return oneOf.some((branch) => isJsonObject(branch) && schemaAcceptsHateoasProperty(branch));
  }

  const type = schema["type"];
  if (
    (typeof type === "string" && type !== "object") ||
    (Array.isArray(type) && !type.includes("object"))
  )
    return false;

  const properties = schema["properties"];
  if (isJsonObject(properties) && Object.prototype.hasOwnProperty.call(properties, "_links")) {
    // `_links` is expected to be an object. The declared property schema is
    // otherwise left to the contract validator, which remains authoritative.
    return true;
  }

  const additionalProperties = schema["additionalProperties"];
  if (additionalProperties === false) return false;
  if (isJsonObject(additionalProperties)) {
    const additionalType = additionalProperties["type"];
    return (
      additionalType === undefined ||
      additionalType === "object" ||
      (Array.isArray(additionalType) && additionalType.includes("object"))
    );
  }

  // `additionalProperties` omitted or explicitly true is permissive under
  // JSON Schema/OpenAPI and therefore supports additive HATEOAS metadata.
  return true;
}

/** Narrow object guard for schema fragments and response bodies. */
function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Return an array item's schema, if the response schema describes an array. */
function arrayItemSchema(schema: JsonObject): JsonObject | undefined {
  const items = schema["items"];
  return isJsonObject(items) ? items : undefined;
}

/**
 * Check the schema at the same shape that the HATEOAS response pass mutates:
 * array items, pagination-envelope items, or a single entity object.
 */
export function responseSupportsHateoas(
  operation: OpenApiOperation | undefined,
  status: number,
  body: JsonValue,
): boolean {
  const schema =
    operation?.responseSchemas?.[String(status)] ?? operation?.responseSchemas?.default;
  // An operation without a response schema has no contract constraint to
  // invalidate. Preserve the additive behaviour in that case.
  if (schema === undefined) return true;

  if (Array.isArray(body)) {
    const itemSchema = arrayItemSchema(schema);
    return (
      itemSchema === undefined ||
      body.every((item) => !isJsonObject(item) || schemaAcceptsHateoasProperty(itemSchema))
    );
  }

  if (isJsonObject(body) && Array.isArray(body["items"])) {
    const properties = schema["properties"];
    const itemsProperty = isJsonObject(properties) ? properties["items"] : undefined;
    if (isJsonObject(itemsProperty)) {
      const itemSchema = arrayItemSchema(itemsProperty);
      return (
        itemSchema === undefined ||
        (body["items"] as JsonValue[]).every(
          (item) => !isJsonObject(item) || schemaAcceptsHateoasProperty(itemSchema),
        )
      );
    }
    // A permissive envelope may leave `items` undeclared. A strict envelope
    // cannot describe the body shape, so do not add nested `_links` to it.
    return schemaAcceptsHateoasProperty(schema);
  }

  return schemaAcceptsHateoasProperty(schema);
}
