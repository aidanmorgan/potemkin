import type { JsonValue } from "../../src/types.js";
import type {
  ContractFieldPolicy,
  DivergenceLedgerEntry,
  EquivalenceComparison,
  EquivalenceDivergence,
  EquivalenceStep,
  EquivalenceWriteSet,
  IdentifierBijectionSnapshot,
  ProjectionPolicy,
} from "./types.js";

interface MutableBijection {
  readonly modelToReal: Map<string, string>;
  readonly realToModel: Map<string, string>;
}

const IDENTIFIER_KEY = /^(id|.*Id|.*ID|.*_id)$/;

/** Compare one or more response steps using one coherent identifier mapping. */
export function compareEquivalenceTrace(
  steps: readonly EquivalenceStep[],
  policy: ProjectionPolicy = {},
  ledger: readonly DivergenceLedgerEntry[] = [],
): EquivalenceComparison {
  const mapping: MutableBijection = { modelToReal: new Map(), realToModel: new Map() };
  const divergences: EquivalenceDivergence[] = [...validateProjectionPolicy(policy, ledger)];
  const previousModel: { value?: JsonValue } = {};
  const previousReal: { value?: JsonValue } = {};

  for (const step of steps) {
    compareResponse(
      step,
      mapping,
      policy,
      step.preState?.model ?? previousModel.value,
      step.preState?.real ?? previousReal.value,
      step.writeSet ?? policy.writeSets?.[step.operation],
      divergences,
    );
    previousModel.value = step.model.body ?? null;
    previousReal.value = step.real.body ?? null;
  }

  const active = divergences.filter((divergence) =>
    ledger.some((entry) => ledgerMatches(entry, divergence)),
  );
  for (const divergence of active) {
    const index = divergences.indexOf(divergence);
    if (index >= 0) divergences.splice(index, 1);
  }
  for (const entry of ledger) {
    if (
      !divergences.some((divergence) => ledgerMatches(entry, divergence)) &&
      !active.some((divergence) => ledgerMatches(entry, divergence))
    ) {
      divergences.push({
        code: "LEDGER_STALE",
        operation: entry.operation,
        path: entry.path,
        message: `Divergence ledger entry ${entry.operation}:${entry.path} is stale`,
      });
    }
  }

  return {
    conforms: divergences.length === 0,
    divergences,
    identifiers: snapshot(mapping),
  };
}

/** Reject a narrowing declaration unless EQ4 has explicitly justified it. */
export function validateProjectionPolicy(
  policy: ProjectionPolicy,
  ledger: readonly DivergenceLedgerEntry[] = [],
): readonly EquivalenceDivergence[] {
  const divergences: EquivalenceDivergence[] = [];
  for (const [operation, paths] of Object.entries(policy.enumerableNarrowing ?? {})) {
    for (const path of Object.keys(paths)) {
      const responsePath = toResponsePath(path);
      if (
        ledger.some(
          (entry) =>
            entry.operation === operation &&
            entry.path === responsePath &&
            (entry.code === undefined || entry.code === "ENUMERABLE_NARROWING"),
        )
      ) {
        continue;
      }
      divergences.push({
        code: "ENUMERABLE_NARROWING",
        operation,
        path: responsePath,
        message: `Enumerable narrowing at ${responsePath} requires a cited divergence ledger entry`,
      });
    }
  }
  return divergences;
}

export function validateDivergenceLedger(
  ledger: readonly DivergenceLedgerEntry[],
  observed: readonly EquivalenceDivergence[],
): { valid: boolean; stale: readonly DivergenceLedgerEntry[] } {
  const stale = ledger.filter(
    (entry) => !observed.some((divergence) => ledgerMatches(entry, divergence)),
  );
  return { valid: stale.length === 0, stale };
}

export function validatePinnedDivergenceLedger(ledger: readonly DivergenceLedgerEntry[]): {
  valid: boolean;
  unpinned: readonly DivergenceLedgerEntry[];
} {
  const unpinned = ledger.filter((entry) => entry.pinnedSequence.length === 0);
  return { valid: unpinned.length === 0, unpinned };
}

function compareResponse(
  step: EquivalenceStep,
  mapping: MutableBijection,
  policy: ProjectionPolicy,
  previousModel: JsonValue | undefined,
  previousReal: JsonValue | undefined,
  writeSet: EquivalenceWriteSet | undefined,
  divergences: EquivalenceDivergence[],
): void {
  if (step.model.status !== step.real.status) {
    divergences.push({
      code: "STATUS_MISMATCH",
      operation: step.operation,
      path: "$.status",
      expected: step.model.status,
      actual: step.real.status,
      message: `Expected status ${step.model.status}, received ${step.real.status}`,
    });
  }
  compareHeaders(step, policy, divergences);
  const projectedWriteSet =
    step.model.status >= 200 && step.model.status < 300 ? writeSet : undefined;
  compareValue(
    step,
    mapping,
    policy,
    previousModel,
    previousReal,
    projectedWriteSet,
    step.model.body ?? null,
    step.real.body ?? null,
    "$.body",
    divergences,
  );
}

function compareHeaders(
  step: EquivalenceStep,
  policy: ProjectionPolicy,
  divergences: EquivalenceDivergence[],
): void {
  const ignored = new Set((policy.ignoredHeaders ?? []).map((header) => header.toLowerCase()));
  const expected = step.model.headers ?? {};
  const actual = step.real.headers ?? {};
  // uioco is output inclusion: fields outside the model's permitted output
  // are not a divergence, while every model-declared header remains required.
  const keys = new Set(Object.keys(expected));
  for (const key of keys) {
    if (ignored.has(key.toLowerCase())) continue;
    const left = expected[key] ?? expected[key.toLowerCase()];
    const right = actual[key] ?? actual[key.toLowerCase()];
    if (left !== right) {
      divergences.push({
        code: "HEADER_MISMATCH",
        operation: step.operation,
        path: `$.headers.${key}`,
        expected: left,
        actual: right,
        message: `Header ${key} differs`,
      });
    }
  }
}

function compareValue(
  step: EquivalenceStep,
  mapping: MutableBijection,
  policy: ProjectionPolicy,
  previousModel: JsonValue | undefined,
  previousReal: JsonValue | undefined,
  writeSet: EquivalenceWriteSet | undefined,
  expected: JsonValue,
  actual: JsonValue,
  path: string,
  divergences: EquivalenceDivergence[],
): void {
  const pathKey = path.replace(/^\$\.body/, "$");
  const shapeOnly =
    matches(pathKey, policy.shapeOnlyPaths) ||
    (writeSet !== undefined && matchesAnyField(pathKey, writeSet.volatile)) ||
    isContractVolatile(pathKey, policy.contractFields);
  if (shapeOnly) {
    if (!shapeCompatible(expected, actual))
      divergences.push({
        code: "SHAPE_MISMATCH",
        operation: step.operation,
        path,
        expected: shapeOf(expected),
        actual: shapeOf(actual),
        message: `Shape differs at ${path}`,
      });
    return;
  }
  const hasFrameState = isRecord(previousModel) && isRecord(previousReal);
  if (hasFrameState && isFramePath(pathKey, policy, writeSet) && isLeaf(expected, actual)) {
    const beforeExpected = getPath(previousModel, pathKey);
    const beforeActual = getPath(previousReal, pathKey);
    if (
      previousModel !== undefined &&
      previousReal !== undefined &&
      (!deepEqual(expected, beforeExpected) || !deepEqual(actual, beforeActual))
    ) {
      divergences.push({
        code: "FRAME_VIOLATION",
        operation: step.operation,
        path,
        message: `Frame path ${path} changed`,
      });
      return;
    }
  }
  if (
    typeof expected === "string" &&
    typeof actual === "string" &&
    (isIdentifierPath(path) || hasEmbeddedIdentifier(expected, actual))
  ) {
    if (!compareIdentifierStrings(expected, actual, mapping)) {
      divergences.push({
        code: "IDENTIFIER_CONTRADICTION",
        operation: step.operation,
        path,
        expected,
        actual,
        message: `Identifier mapping contradicts the trace at ${path}`,
      });
    }
    return;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    // uioco compares the model's declared outputs as an inclusion set. The
    // real implementation may expose additional output values, but it must
    // still contain every model-positioned value in the declared order. A
    // shorter actual array remains a divergence.
    if (actual.length < expected.length) {
      divergences.push({
        code: "BODY_MISMATCH",
        operation: step.operation,
        path,
        expected: expected.length,
        actual: actual.length,
        message: `Actual array omits model output values at ${path}`,
      });
    }
    for (let index = 0; index < expected.length; index++) {
      compareValue(
        step,
        mapping,
        policy,
        previousModel,
        previousReal,
        writeSet,
        expected[index] ?? null,
        actual[index] ?? null,
        `${path}[${index}]`,
        divergences,
      );
    }
    return;
  }
  if (isRecord(expected) && isRecord(actual)) {
    const keys = new Set(Object.keys(expected));
    for (const key of keys)
      compareValue(
        step,
        mapping,
        policy,
        previousModel,
        previousReal,
        writeSet,
        expected[key] ?? null,
        actual[key] ?? null,
        `${path}.${key}`,
        divergences,
      );
    return;
  }
  if (!Object.is(expected, actual)) {
    if (narrowingAllows(policy, step.operation, pathKey, actual)) {
      divergences.push({
        code: "ENUMERABLE_NARROWING",
        operation: step.operation,
        path,
        expected,
        actual,
        message: `Enumerable narrowing at ${path} requires a cited divergence ledger entry`,
      });
      return;
    }
    divergences.push({
      code: "BODY_MISMATCH",
      operation: step.operation,
      path,
      expected,
      actual,
      message: `Body differs at ${path}`,
    });
  }
}

function bind(mapping: MutableBijection, model: string, real: string): boolean {
  const existingReal = mapping.modelToReal.get(model);
  const existingModel = mapping.realToModel.get(real);
  if (existingReal !== undefined && existingReal !== real) return false;
  if (existingModel !== undefined && existingModel !== model) return false;
  mapping.modelToReal.set(model, real);
  mapping.realToModel.set(real, model);
  return true;
}

function snapshot(mapping: MutableBijection): IdentifierBijectionSnapshot {
  return {
    modelToReal: Object.fromEntries(mapping.modelToReal),
    realToModel: Object.fromEntries(mapping.realToModel),
  };
}

function isIdentifierPath(path: string): boolean {
  const key =
    path
      .split(".")
      .pop()
      ?.replace(/\[\d+\]$/, "") ?? "";
  return IDENTIFIER_KEY.test(key);
}

function isFramePath(
  path: string,
  policy: ProjectionPolicy,
  writeSet: EquivalenceWriteSet | undefined,
): boolean {
  if (matches(path, policy.framePaths)) return true;
  if (writeSet === undefined || path === "$") return false;
  return (
    !writeSet.replaceState &&
    !matchesAnyField(path, [...writeSet.fields, ...writeSet.derivedClosure])
  );
}

function matchesAnyField(path: string, fields: readonly string[]): boolean {
  return fields.some((field) => matches(path, [`$.${field}`]));
}

function isLeaf(left: unknown, right: unknown): boolean {
  return !Array.isArray(left) && !Array.isArray(right) && !isRecord(left) && !isRecord(right);
}

function hasEmbeddedIdentifier(expected: string, actual: string): boolean {
  const expectedSecret = structuredClientSecret(expected);
  const actualSecret = structuredClientSecret(actual);
  if (expectedSecret !== undefined || actualSecret !== undefined) {
    return (
      expectedSecret !== undefined &&
      actualSecret !== undefined &&
      expectedSecret.prefix === actualSecret.prefix
    );
  }
  const left = embeddedIdentifierTokens(expected);
  const right = embeddedIdentifierTokens(actual);
  if (left.length === 0 || left.length !== right.length) return false;
  return identifierTemplate(expected, left) === identifierTemplate(actual, right);
}

function compareIdentifierStrings(
  expected: string,
  actual: string,
  mapping: MutableBijection,
): boolean {
  const expectedSecret = structuredClientSecret(expected);
  const actualSecret = structuredClientSecret(actual);
  if (expectedSecret !== undefined || actualSecret !== undefined) {
    if (expectedSecret === undefined || actualSecret === undefined) return false;
    if (expectedSecret.prefix !== actualSecret.prefix) return false;
    return bind(mapping, expectedSecret.identifier, actualSecret.identifier);
  }
  const expectedTokens = embeddedIdentifierTokens(expected);
  const actualTokens = embeddedIdentifierTokens(actual);
  if (expectedTokens.length > 0 || actualTokens.length > 0) {
    if (!hasEmbeddedIdentifier(expected, actual)) return false;
    return expectedTokens.every((token, index) => bind(mapping, token, actualTokens[index]!));
  }
  return bind(mapping, expected, actual);
}

function embeddedIdentifierTokens(value: string): readonly string[] {
  return value.match(/(?:pi|ch|cus|pm|src|ord|acct|sub|tok)_[A-Za-z0-9-]+/g) ?? [];
}

function identifierTemplate(value: string, tokens: readonly string[]): string {
  let template = value;
  tokens.forEach((token, index) => {
    template = template.replace(token, `\u0000${index}\u0000`);
  });
  return template;
}

function structuredClientSecret(
  value: string,
): { readonly prefix: string; readonly identifier: string } | undefined {
  const match = value.match(/^([A-Za-z]{2,8})_([A-Za-z0-9-]+)_secret_[A-Za-z0-9-]+$/);
  if (match === null) return undefined;
  return { prefix: match[1]!, identifier: `${match[1]}_${match[2]}` };
}

function narrowingAllows(
  policy: ProjectionPolicy,
  operation: string,
  path: string,
  actual: JsonValue,
): boolean {
  const values = policy.enumerableNarrowing?.[operation]?.[path];
  return values?.some((value) => deepEqual(value, actual)) ?? false;
}

function isContractVolatile(
  path: string,
  fields: Readonly<Record<string, ContractFieldPolicy>> | undefined,
): boolean {
  const field = fields?.[path];
  if (field?.readOnly === true) return true;
  const format = field?.format
    ?.trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
  if (format === undefined || format.length === 0) return false;
  return (
    format === "unix-time" ||
    format === "timestamp" ||
    format === "date-time" ||
    format === "datetime" ||
    format === "uuid" ||
    format.startsWith("uuid-")
  );
}

function toResponsePath(path: string): string {
  return path === "$" ? "$.body" : `$.body${path.slice(1)}`;
}

function matches(path: string, patterns: readonly string[] | undefined): boolean {
  return (patterns ?? []).some(
    (pattern) =>
      path === pattern || path.startsWith(`${pattern}.`) || path.startsWith(`${pattern}[`),
  );
}

function getPath(value: JsonValue | undefined, path: string): JsonValue | undefined {
  if (value === undefined) return undefined;
  const segments = path
    .replace(/^\$\.?/, "")
    .split(/[.[\]]+/)
    .filter(Boolean);
  let current: unknown = value;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current as JsonValue | undefined;
}

function shapeCompatible(left: unknown, right: unknown): boolean {
  if (left === null || right === null) return left === right;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length === 0) return true;
    return right.length > 0 && left.every((value) => shapeCompatible(value, right[0]));
  }
  if (typeof left === "object" || typeof right === "object") {
    if (typeof left !== "object" || typeof right !== "object") return false;
    const leftKeys = Object.keys(left as object).sort();
    return leftKeys.every((key) =>
      shapeCompatible(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
      ),
    );
  }
  return typeof left === typeof right;
}

function shapeOf(value: unknown): JsonValue {
  if (value === null) return null;
  if (Array.isArray(value)) return value.length > 0 ? [shapeOf(value[0])] : [];
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, shapeOf(child)]),
    );
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function ledgerMatches(entry: DivergenceLedgerEntry, divergence: EquivalenceDivergence): boolean {
  return (
    entry.operation === divergence.operation &&
    entry.path === divergence.path &&
    (entry.code === undefined || entry.code === divergence.code)
  );
}
