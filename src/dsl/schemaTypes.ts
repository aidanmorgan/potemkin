export type FieldKind =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "null"
  | "array"
  | "object"
  | "unknown";

export type Confidence = "known" | "narrowed" | "unknown";

export interface FieldType {
  readonly kind: FieldKind;
  readonly confidence: Confidence;
  readonly element?: FieldType;
  readonly fields?: Record<string, FieldType>;
}

export interface DeclaredComputedField {
  readonly name: string;
  readonly formula: string;
  readonly dependsOn: readonly string[];
}

export interface DeclaredInternalField {
  readonly name: string;
  readonly type: FieldType;
}

export interface DeclaredState {
  readonly computed?: readonly DeclaredComputedField[];
  readonly internal?: readonly DeclaredInternalField[];
}
