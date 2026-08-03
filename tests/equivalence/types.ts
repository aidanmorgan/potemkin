import type { JsonValue } from "../../src/types.js";

export interface EquivalenceResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: JsonValue | null;
}

export interface EquivalenceRequest {
  readonly method: string;
  readonly path: string;
  readonly body?: JsonValue;
  /** Select the wire encoding for request bodies that are not JSON. */
  readonly bodyEncoding?: "json" | "form";
  readonly headers?: Readonly<Record<string, string>>;
  /** Optional stable label used in reports; the request path remains the wire value. */
  readonly operation?: string;
}

/** A response plus observations collected by an endpoint after the HTTP call. */
export interface EquivalenceObservation extends EquivalenceResponse {
  /** Events observed after the request became quiescent, when an event source is configured. */
  readonly events?: readonly JsonValue[];
}

export interface EquivalenceStep {
  readonly operation: string;
  readonly request: EquivalenceRequest;
  readonly model: EquivalenceResponse;
  readonly real: EquivalenceResponse;
  /** State immediately before this operation on each side. */
  readonly preState?: Readonly<{
    readonly model: JsonValue | null;
    readonly real: JsonValue | null;
  }>;
  /** MODEL1's operation write-set, supplied by the sequence driver. */
  readonly writeSet?: EquivalenceWriteSet;
}

export type EquivalencePath = string;

export interface ProjectionPolicy {
  /** Values in these paths are compared for schema shape only. */
  readonly shapeOnlyPaths?: readonly EquivalencePath[];
  /** Values in these paths are expected to remain unchanged from the prior observation. */
  readonly framePaths?: readonly EquivalencePath[];
  /** Values in these paths are compared exactly, after identifier normalization. */
  readonly equalPaths?: readonly EquivalencePath[];
  /** Response headers that are documented as non-semantic. */
  readonly ignoredHeaders?: readonly string[];
  /** MODEL1 write-sets keyed by the abstract operation name. */
  readonly writeSets?: Readonly<Record<string, EquivalenceWriteSet>>;
  /** Explicit enumerable narrowing is only permitted through the ledger. */
  readonly enumerableNarrowing?: Readonly<
    Record<string, Readonly<Record<string, readonly JsonValue[]>>>
  >;
  /** Contract metadata which may make a response field provider-generated. */
  readonly contractFields?: Readonly<Record<EquivalencePath, ContractFieldPolicy>>;
}

export interface ContractFieldPolicy {
  readonly format?: string;
  readonly readOnly?: boolean;
}

export interface EquivalenceWriteSet {
  readonly fields: readonly string[];
  readonly replaceState: boolean;
  readonly derivedClosure: readonly string[];
  readonly volatile: readonly string[];
}

export interface IdentifierBijectionSnapshot {
  readonly modelToReal: Readonly<Record<string, string>>;
  readonly realToModel: Readonly<Record<string, string>>;
}

export interface EquivalenceDivergence {
  readonly code:
    | "STATUS_MISMATCH"
    | "HEADER_MISMATCH"
    | "BODY_MISMATCH"
    | "FRAME_VIOLATION"
    | "SHAPE_MISMATCH"
    | "IDENTIFIER_CONTRADICTION"
    | "EVENT_MISMATCH"
    | "ENDPOINT_FAILURE"
    | "INCONCLUSIVE"
    | "LEDGER_STALE"
    | "ENUMERABLE_NARROWING";
  readonly operation: string;
  readonly path: string;
  readonly expected?: JsonValue | string | number;
  readonly actual?: JsonValue | string | number;
  readonly message: string;
}

export interface EquivalenceComparison {
  readonly conforms: boolean;
  readonly divergences: readonly EquivalenceDivergence[];
  readonly identifiers: IdentifierBijectionSnapshot;
}

export interface DivergenceLedgerEntry {
  readonly operation: string;
  readonly path: string;
  readonly code?: EquivalenceDivergence["code"];
  readonly justification: string;
  readonly citation: string;
  /** Pinned minimal reproducer retained with the field-level ledger entry. */
  readonly pinnedSequence: readonly EquivalenceRequest[];
}

export interface LedgerValidation {
  readonly valid: boolean;
  readonly stale: readonly DivergenceLedgerEntry[];
}

export interface ModelTransition {
  readonly from: string;
  readonly operation: string;
  readonly to: string;
  readonly output?: string;
}

export interface FiniteStateModel {
  readonly initial: string;
  readonly states: readonly string[];
  readonly transitions: readonly ModelTransition[];
}

export interface GeneratedSequence {
  readonly steps: readonly string[];
  readonly coveredTransitions: readonly string[];
}

export interface GenerationOptions {
  readonly maxDepth?: number;
  readonly extraStates?: number;
  readonly includeNegative?: boolean;
}

export interface MetamorphicRelation {
  readonly name: string;
  readonly apply: (sequence: readonly EquivalenceRequest[]) => readonly EquivalenceRequest[];
  readonly assert: (
    before: readonly EquivalenceResponse[],
    after: readonly EquivalenceResponse[],
  ) => readonly EquivalenceDivergence[];
}
