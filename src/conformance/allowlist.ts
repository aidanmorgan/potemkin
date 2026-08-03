import * as fs from "node:fs/promises";
import * as yaml from "js-yaml";
import type {
  AllowlistEvaluation,
  ConformanceAllowlistEntry,
  ConformanceFailure,
  NamedConformanceAllowlist,
} from "./types.js";

function stringField(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`Conformance allowlist field '${name}' must be a non-empty string`);
  return value;
}

function parseEntry(value: unknown, index: number): ConformanceAllowlistEntry {
  if (!value || typeof value !== "object")
    throw new Error(`Conformance allowlist entry ${index} must be an object`);
  const entry = value as Record<string, unknown>;
  const numberOrString = (name: string): string => {
    const fieldValue = entry[name];
    if (typeof fieldValue === "number" || typeof fieldValue === "string") return String(fieldValue);
    throw new Error(
      `Conformance allowlist entry ${index} field '${name}' must be a string or number`,
    );
  };
  return {
    id: stringField(entry.id, "id"),
    reason: stringField(entry.reason, "reason"),
    method: stringField(entry.method, "method").toUpperCase(),
    path: stringField(entry.path, "path"),
    scenario: stringField(entry.scenario, "scenario"),
    expectedStatus: numberOrString("expected_status"),
    actualStatus: numberOrString("actual_status"),
    ...(entry.rule_id === undefined ? {} : { ruleId: stringField(entry.rule_id, "rule_id") }),
    ...(entry.source === undefined ? {} : { source: stringField(entry.source, "source") }),
  };
}

function parseNamed(value: unknown, index: number): NamedConformanceAllowlist {
  if (!value || typeof value !== "object")
    throw new Error(`Conformance allowlist ${index} must be an object`);
  const item = value as Record<string, unknown>;
  const rawEntries = item.entries;
  if (!Array.isArray(rawEntries))
    throw new Error(`Conformance allowlist '${String(item.name)}' must contain an entries array`);
  return {
    name: stringField(item.name, "name"),
    entries: rawEntries.map(parseEntry),
  };
}

export function parseAllowlistDocument(value: unknown): NamedConformanceAllowlist[] {
  if (!value || typeof value !== "object")
    throw new Error("Conformance allowlist must be a YAML object");
  const document = value as Record<string, unknown>;
  if (document.version !== 1) throw new Error("Conformance allowlist 'version' must be 1");
  if (Array.isArray(document.allowlists)) {
    const parsed = document.allowlists.map(parseNamed);
    assertNamedAllowlistNamesAreUnique(parsed);
    return parsed;
  }
  if (document.name !== undefined || document.entries !== undefined) {
    if (!Array.isArray(document.entries))
      throw new Error("Conformance allowlist must contain an entries array");
    return [
      { name: stringField(document.name, "name"), entries: document.entries.map(parseEntry) },
    ];
  }
  throw new Error("Conformance allowlist must contain either 'allowlists' or 'name' and 'entries'");
}

export async function loadAllowlists(filePath: string): Promise<NamedConformanceAllowlist[]> {
  const raw = await fs.readFile(filePath, "utf8");
  return parseAllowlistDocument(yaml.load(raw));
}

function sameCase(entry: ConformanceAllowlistEntry, failure: ConformanceFailure): boolean {
  return (
    entry.method === failure.method &&
    entry.path === failure.path &&
    entry.scenario === failure.scenario &&
    entry.expectedStatus === failure.expectedStatus &&
    entry.actualStatus === failure.actualStatus &&
    (entry.ruleId ?? "") === (failure.ruleId ?? "")
  );
}

function assertNamedAllowlistNamesAreUnique(
  allowlists: readonly NamedConformanceAllowlist[],
): void {
  const names = new Set<string>();
  for (const allowlist of allowlists) {
    if (names.has(allowlist.name))
      throw new Error(`Conformance allowlists contain duplicate name '${allowlist.name}'`);
    names.add(allowlist.name);
  }
}

export function evaluateAllowlist(
  failures: readonly ConformanceFailure[],
  allowlist: NamedConformanceAllowlist | undefined,
): AllowlistEvaluation {
  if (!allowlist) return { allowed: [], unexpected: [...failures], stale: [] };
  const allowed: ConformanceFailure[] = [];
  const unexpected: ConformanceFailure[] = [];
  const consumed = new Set<string>();
  for (const failure of failures) {
    const entry = allowlist.entries.find(
      (candidate) => !consumed.has(candidate.id) && sameCase(candidate, failure),
    );
    if (entry) {
      allowed.push(failure);
      consumed.add(entry.id);
    } else {
      unexpected.push(failure);
    }
  }
  const stale = allowlist.entries.filter((entry) => !consumed.has(entry.id));
  return { allowed, unexpected, stale };
}

export function selectAllowlist(
  allowlists: readonly NamedConformanceAllowlist[],
  name: string | undefined,
): NamedConformanceAllowlist | undefined {
  assertNamedAllowlistNamesAreUnique(allowlists);
  if (!name) {
    if (allowlists.length > 1)
      throw new Error(
        `Multiple conformance allowlists found; choose one of: ${allowlists.map((item) => item.name).join(", ")}`,
      );
    return allowlists[0];
  }
  const selected = allowlists.find((item) => item.name === name);
  if (!selected)
    throw new Error(
      `Conformance allowlist '${name}' was not found; available: ${allowlists.map((item) => item.name).join(", ") || "(none)"}`,
    );
  return selected;
}

export function assertAllowlistIsUnique(allowlist: NamedConformanceAllowlist): void {
  const ids = new Set<string>();
  for (const entry of allowlist.entries) {
    if (ids.has(entry.id))
      throw new Error(
        `Conformance allowlist '${allowlist.name}' contains duplicate entry id '${entry.id}'`,
      );
    ids.add(entry.id);
  }
}
