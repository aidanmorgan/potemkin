import * as path from "node:path";

export interface CliOptions {
  readonly exampleName: string;
  readonly layer: "negative" | "positive";
  readonly specmaticContractPath?: string;
  readonly allowlistPath?: string;
  readonly allowlistName?: string;
  readonly filter?: string;
  readonly maxCombinations: number;
}

export interface SpecmaticLayerOptions {
  readonly filter?: string;
  readonly testMode: "all" | "positiveOnly" | "none";
}

export const conformanceUsage =
  "Usage: pnpm run test:conformance [--example crm] [--layer negative|positive] [--specmatic-contract path] [--allowlist path] [--allowlist-name name] [--filter expression] [--max-combinations N]";

export class ConformanceHelpRequested extends Error {
  constructor() {
    super(conformanceUsage);
    this.name = "ConformanceHelpRequested";
  }
}

/**
 * Specmatic exposes positive-only selection, but no negative-only switch.
 * The negative layer is explicitly restricted to contract-invalid requests
 * whose expected response is 400. Domain and state-transition failures (422,
 * 404, and other 4xx responses) belong to the stateful behaviour suites.
 */
export const NEGATIVE_LAYER_FILTER = "STATUS='400'";

function layerFilter(layer: CliOptions["layer"], requestedFilter?: string): string | undefined {
  const filter = requestedFilter?.trim();
  if (layer === "positive") return filter;
  return filter ? `(${NEGATIVE_LAYER_FILTER}) && (${filter})` : NEGATIVE_LAYER_FILTER;
}

export function specmaticOptionsForLayer(
  layer: CliOptions["layer"],
  requestedFilter?: string,
): SpecmaticLayerOptions {
  return layer === "positive"
    ? { filter: layerFilter(layer, requestedFilter), testMode: "positiveOnly" }
    : {
        filter: layerFilter(layer, requestedFilter),
        testMode: "all",
      };
}

function parseMaxCombinations(value: string): number {
  if (!/^\d+$/.test(value))
    throw new Error(
      `Conformance option '--max-combinations' must be a positive integer; received '${value}'`,
    );
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(
      `Conformance option '--max-combinations' must be a positive safe integer; received '${value}'`,
    );
  return parsed;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  let exampleName = "crm";
  let layer: CliOptions["layer"] = "negative";
  let specmaticContractPath: string | undefined;
  let allowlistPath: string | undefined;
  let allowlistName: string | undefined;
  let filter: string | undefined;
  let maxCombinations = 25;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--") continue;
    if (arg === "--example" && next) {
      exampleName = next;
      index += 1;
    } else if (arg === "--layer" && (next === "negative" || next === "positive")) {
      layer = next;
      index += 1;
    } else if (arg === "--specmatic-contract" && next) {
      specmaticContractPath = path.resolve(next);
      index += 1;
    } else if (arg === "--allowlist" && next) {
      allowlistPath = path.resolve(next);
      index += 1;
    } else if (arg === "--allowlist-name" && next) {
      allowlistName = next;
      index += 1;
    } else if (arg === "--filter") {
      if (next === undefined || next.trim() === "")
        throw new Error("Conformance option '--filter' requires a non-empty expression");
      filter = next;
      index += 1;
    } else if (arg === "--max-combinations" && next !== undefined) {
      maxCombinations = parseMaxCombinations(next);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      throw new ConformanceHelpRequested();
    } else {
      throw new Error(`Unknown or incomplete conformance option '${arg}'`);
    }
  }
  return {
    exampleName,
    layer,
    specmaticContractPath,
    allowlistPath,
    allowlistName,
    filter,
    maxCombinations,
  };
}
