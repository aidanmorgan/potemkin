import type { JsonObject, JsonValue } from "../types.js";

/**
 * Query behavior is kept as a policy module so the engine only coordinates
 * query execution. Operators are registered strategies rather than embedded
 * in the orchestration path, which keeps adding an operator localized.
 */
export type QueryOperatorStrategy = (value: JsonValue, expected: string) => boolean;

export function queryValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "object" && value !== null ? value[0] : value;
}

export function readPath(value: JsonValue | undefined, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = Array.isArray(current) ? current[Number(segment)] : (current as JsonObject)[segment];
  }
  return current;
}

export function compareQueryValues(
  left: JsonValue | undefined,
  right: JsonValue | undefined,
): number {
  if (left === null || left === undefined) return right === null || right === undefined ? 0 : 1;
  if (right === null || right === undefined) return -1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right));
}

const queryOperatorStrategies: Readonly<Record<string, QueryOperatorStrategy>> = {
  arrayContains: (value, expected) =>
    Array.isArray(value) && value.some((item) => String(item) === expected),
  contains: (value, expected) =>
    Array.isArray(value)
      ? value.some((item) => String(item) === expected)
      : typeof value === "string" && value.toLowerCase().includes(expected.toLowerCase()),
  startsWith: (value, expected) =>
    typeof value === "string" && value.toLowerCase().startsWith(expected.toLowerCase()),
  endsWith: (value, expected) =>
    typeof value === "string" && value.toLowerCase().endsWith(expected.toLowerCase()),
  in: (value, expected) =>
    expected
      .split(",")
      .map((item) => item.trim())
      .includes(String(value)),
};

export function queryOperator(
  value: JsonValue | undefined,
  operator: string,
  expected: string,
): boolean {
  if (value === null || value === undefined) return operator === "ne";
  const strategy = queryOperatorStrategies[operator];
  if (strategy !== undefined) return strategy(value, expected);

  const numericValue = Number(value);
  const numericExpected = Number(expected);
  const numeric =
    !Number.isNaN(numericValue) && !Number.isNaN(numericExpected) && expected.trim() !== "";
  const left = numeric ? numericValue : String(value);
  const right = numeric ? numericExpected : expected;
  switch (operator) {
    case "gt":
      return left > right;
    case "gte":
      return left >= right;
    case "lt":
      return left < right;
    case "lte":
      return left <= right;
    case "ne":
      return String(value) !== expected && left !== right;
    default:
      return false;
  }
}

export function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id }), "utf8").toString("base64url");
}

export function decodeCursor(value: string): string | undefined {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      id?: unknown;
    };
    return typeof decoded.id === "string" ? decoded.id : undefined;
  } catch {
    return undefined;
  }
}

export function selectFields(value: JsonObject, fields: readonly string[]): JsonObject {
  if (fields.length === 0) return value;
  const output: JsonObject = {};
  for (const field of new Set(["id", ...fields])) if (field in value) output[field] = value[field]!;
  return output;
}

export function expandFields(
  value: JsonObject,
  fields: readonly string[],
  state: ReadonlyMap<string, JsonObject>,
): JsonObject {
  if (fields.length === 0) return value;
  const output = { ...value };
  for (const field of fields) {
    const ids = value[field];
    if (!Array.isArray(ids)) continue;
    output[`_${field}`] = ids
      .filter((id): id is string => typeof id === "string")
      .map((id) => state.get(id))
      .filter((item): item is JsonObject => item !== undefined);
  }
  return output;
}
