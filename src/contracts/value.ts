/** Canonical source-neutral JSON and patch value contracts. */
export type JsonScalar = string | number | boolean | null;

export type JsonArray = readonly JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonValue = JsonScalar | JsonArray | JsonObject;

/** Runtime guards for values crossing an untyped JSON/YAML/HTTP boundary. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Return an object-shaped value or `undefined` for scalar and array inputs. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function isJsonValue(value: unknown): value is JsonValue {
  return isJsonValueInternal(value, new WeakSet<object>());
}

export function isJsonObject(value: unknown): value is JsonObject {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    isJsonObjectInternal(value, new WeakSet<object>())
  );
}

function isJsonValueInternal(value: unknown, seen: WeakSet<object>): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;

  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonValueInternal(entry, seen))
    : isJsonObjectInternal(value, seen);
  seen.delete(value);
  return valid;
}

function isJsonObjectInternal(value: object, seen: WeakSet<object>): value is JsonObject {
  return (
    Object.prototype.toString.call(value) === '[object Object]' &&
    Object.values(value).every((entry) => isJsonValueInternal(entry, seen))
  );
}

/** Closed vocabulary for RFC 6902 operations and Potemkin extensions. */
export const PatchOperation = {
  Add: 'add',
  Remove: 'remove',
  Replace: 'replace',
  Move: 'move',
  Copy: 'copy',
  Append: 'append',
  Prepend: 'prepend',
  Increment: 'increment',
  Merge: 'merge',
  Upsert: 'upsert',
} as const;

export type PatchOperation = (typeof PatchOperation)[keyof typeof PatchOperation];

/** Closed vocabulary for the components that can contribute a state mutation. */
export const PatchSource = {
  Reducer: 'reducer',
  Projection: 'projection',
  Seed: 'seed',
  Hateoas: 'hateoas',
  Mask: 'mask',
  Deprecation: 'deprecation',
  Overlay: 'overlay',
} as const;

export type PatchSource = (typeof PatchSource)[keyof typeof PatchSource];

export type Patch =
  | { op: typeof PatchOperation.Add; path: string; value: JsonValue }
  | { op: typeof PatchOperation.Remove; path: string }
  | { op: typeof PatchOperation.Replace; path: string; value: JsonValue }
  | { op: typeof PatchOperation.Move; from: string; path: string }
  | { op: typeof PatchOperation.Copy; from: string; path: string }
  | { op: typeof PatchOperation.Append; path: string; value: JsonValue }
  | { op: typeof PatchOperation.Prepend; path: string; value: JsonValue }
  | { op: typeof PatchOperation.Increment; path: string; by: number }
  | {
      op: typeof PatchOperation.Merge;
      path: string;
      value: Record<string, JsonValue>;
      deep?: boolean;
    }
  | {
      op: typeof PatchOperation.Upsert;
      path: string;
      key: string;
      value: Record<string, JsonValue>;
    };

/** Recursively readonly view of a JSON-domain value. */
export type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? string extends keyof T
      ? Readonly<T>
      : { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;
