import * as path from 'node:path';
import { parseArgs as parseNodeArgs, type ParseArgsOptionsConfig } from 'node:util';

export interface CliOptions {
  readonly exampleName: string;
  readonly layer: 'negative' | 'positive';
  readonly specmaticContractPath?: string;
  readonly allowlistPath?: string;
  readonly allowlistName?: string;
  readonly filter?: string;
  readonly maxCombinations: number;
}

export interface SpecmaticLayerOptions {
  readonly filter?: string;
  readonly testMode: 'all' | 'positiveOnly' | 'none';
}

export const conformanceUsage =
  'Usage: pnpm run test:conformance [--example crm] [--layer negative|positive] [--specmatic-contract path] [--allowlist path] [--allowlist-name name] [--filter expression] [--max-combinations N]';

export class ConformanceHelpRequested extends Error {
  constructor() {
    super(conformanceUsage);
    this.name = 'ConformanceHelpRequested';
  }
}

/**
 * Specmatic exposes positive-only selection, but no negative-only switch.
 * The negative layer is explicitly restricted to contract-invalid requests
 * whose expected response is 400. Domain and state-transition failures (422,
 * 404, and other 4xx responses) belong to the stateful behaviour suites.
 */
export const NEGATIVE_LAYER_FILTER = "STATUS='400'";

const NODE_OPTIONS = {
  example: { type: 'string' },
  layer: { type: 'string' },
  'specmatic-contract': { type: 'string' },
  allowlist: { type: 'string' },
  'allowlist-name': { type: 'string' },
  filter: { type: 'string' },
  'max-combinations': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies ParseArgsOptionsConfig;

function parseNodeConformanceArgs(argv: readonly string[]) {
  return parseNodeArgs({
    args: [...argv],
    allowPositionals: false,
    strict: true,
    options: NODE_OPTIONS,
  });
}

function layerFilter(layer: CliOptions['layer'], requestedFilter?: string): string | undefined {
  const filter = requestedFilter?.trim();
  if (layer === 'positive') return filter;
  return filter ? `(${NEGATIVE_LAYER_FILTER}) && (${filter})` : NEGATIVE_LAYER_FILTER;
}

export function specmaticOptionsForLayer(
  layer: CliOptions['layer'],
  requestedFilter?: string,
): SpecmaticLayerOptions {
  return layer === 'positive'
    ? { filter: layerFilter(layer, requestedFilter), testMode: 'positiveOnly' }
    : {
        filter: layerFilter(layer, requestedFilter),
        testMode: 'all',
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
  let parsed: ReturnType<typeof parseNodeConformanceArgs>;
  try {
    parsed = parseNodeConformanceArgs(argv);
  } catch (error) {
    throw new Error(
      `Unknown or incomplete conformance option: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (parsed.values.help === true) throw new ConformanceHelpRequested();

  const exampleName = parsed.values.example;
  if (exampleName !== undefined && exampleName.trim() === '')
    throw new Error("Conformance option '--example' requires a non-empty name");

  const rawLayer = parsed.values.layer;
  if (rawLayer !== undefined && rawLayer !== 'negative' && rawLayer !== 'positive')
    throw new Error(
      `Conformance option '--layer' must be 'negative' or 'positive'; received '${rawLayer}'`,
    );

  const filter = parsed.values.filter;
  if (filter !== undefined && filter.trim() === '')
    throw new Error("Conformance option '--filter' requires a non-empty expression");

  const maxCombinations =
    parsed.values['max-combinations'] === undefined
      ? 25
      : parseMaxCombinations(parsed.values['max-combinations']);

  return {
    exampleName: exampleName ?? 'crm',
    layer: rawLayer ?? 'negative',
    specmaticContractPath:
      parsed.values['specmatic-contract'] === undefined
        ? undefined
        : path.resolve(parsed.values['specmatic-contract']),
    allowlistPath:
      parsed.values.allowlist === undefined ? undefined : path.resolve(parsed.values.allowlist),
    allowlistName: parsed.values['allowlist-name'],
    filter,
    maxCombinations,
  };
}
