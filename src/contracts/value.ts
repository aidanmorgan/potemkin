/** Canonical source-neutral JSON and patch value contracts. */
export type JsonScalar = string | number | boolean | null;

export type JsonArray = readonly JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonValue = JsonScalar | JsonArray | JsonObject;

/** Sources that can contribute a state mutation. */
export type PatchSource =
  | 'reducer'
  | 'projection'
  | 'seed'
  | 'hateoas'
  | 'mask'
  | 'deprecation'
  | 'overlay';

export type Patch =
  | { op: 'add'; path: string; value: JsonValue }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: JsonValue }
  | { op: 'move'; from: string; path: string }
  | { op: 'copy'; from: string; path: string }
  | { op: 'append'; path: string; value: JsonValue }
  | { op: 'prepend'; path: string; value: JsonValue }
  | { op: 'increment'; path: string; by: number }
  | { op: 'merge'; path: string; value: Record<string, JsonValue>; deep?: boolean }
  | { op: 'upsert'; path: string; key: string; value: Record<string, JsonValue> };

/** Recursively readonly view of a JSON-domain value. */
export type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? string extends keyof T
      ? Readonly<T>
      : { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;
