import type { JsonValue } from '../../src/contracts/value.js';
import { createRealApiEndpoint, type EquivalenceEndpoint, type HttpFetcher } from './realApi.js';
import { compareEquivalenceTrace } from './comparator.js';
import type {
  DivergenceLedgerEntry,
  EquivalenceComparison,
  EquivalenceDivergence,
  EquivalenceObservation,
  EquivalenceRequest,
  EquivalenceStep,
  EquivalenceWriteSet,
  ProjectionPolicy,
} from './types.js';

export interface SymbolicCapture {
  readonly symbol: string;
  /** JSON path in the settled response, for example `$.id`. */
  readonly responsePath: string;
}

export interface StablePoll {
  /** Read-only request used to observe the projection after a mutation. */
  readonly request: EquivalenceRequest;
  readonly maxAttempts?: number;
  readonly intervalMs?: number;
}

export interface SymbolicSequenceStep {
  readonly operation: string;
  readonly request: EquivalenceRequest;
  readonly captures?: readonly SymbolicCapture[];
  readonly mutating?: boolean;
  /** Required for mutating steps so the frame oracle receives both pre-states. */
  readonly preStateRequest?: EquivalenceRequest;
  readonly writeSet?: EquivalenceWriteSet;
  readonly poll?: StablePoll;
}

export interface DualRunnerOptions {
  /** Base URL of the Potemkin instance. It is also used for the reset endpoint. */
  readonly modelBaseUrl?: string;
  /** Base URL of the real provider. A fresh entity must be created per sequence. */
  readonly realBaseUrl?: string;
  readonly model?: EquivalenceEndpoint;
  readonly real?: EquivalenceEndpoint;
  readonly fetch?: HttpFetcher;
  /** Override the Potemkin reset call for an in-process or test transport. */
  readonly resetModel?: () => Promise<void>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly defaultPoll?: Readonly<{
    maxAttempts: number;
    intervalMs: number;
  }>;
  readonly policy?: ProjectionPolicy;
  readonly ledger?: readonly DivergenceLedgerEntry[];
}

export interface DualRunResult {
  readonly verdict: 'CONFORMS' | 'DIVERGES' | 'INCONCLUSIVE';
  readonly conforms: boolean;
  readonly inconclusive: boolean;
  readonly steps: readonly EquivalenceStep[];
  readonly comparison: EquivalenceComparison;
  readonly divergences: readonly EquivalenceDivergence[];
}

interface SideResult {
  readonly observation: EquivalenceObservation;
  readonly stable: boolean;
}

interface MutableSymbols {
  readonly values: Map<string, string>;
}

/**
 * Execute one abstract sequence against Potemkin and a second endpoint.
 *
 * Symbol resolution is deliberately side-local: a model-created `cus_A` and
 * real-created `cus_B` are both bound to the same abstract symbol, and later
 * requests are rendered with the correct concrete value for that side.
 */
export class SymbolicDualRunner {
  private readonly model: EquivalenceEndpoint;
  private readonly real: EquivalenceEndpoint;
  private readonly resetModel: () => Promise<void>;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly defaultPoll: Readonly<{ maxAttempts: number; intervalMs: number }>;

  public constructor(private readonly options: DualRunnerOptions) {
    this.model = options.model ?? endpointFromBaseUrl(options.modelBaseUrl, options.fetch);
    this.real = options.real ?? endpointFromBaseUrl(options.realBaseUrl, options.fetch);
    this.resetModel = options.resetModel ?? resetFromBaseUrl(options.modelBaseUrl, options.fetch);
    this.sleep = options.sleep ?? defaultSleep;
    this.defaultPoll = options.defaultPoll ?? { maxAttempts: 3, intervalMs: 25 };
  }

  public async run(sequence: readonly SymbolicSequenceStep[]): Promise<DualRunResult> {
    await this.resetModel();
    const modelSymbols: MutableSymbols = { values: new Map() };
    const realSymbols: MutableSymbols = { values: new Map() };
    const steps: EquivalenceStep[] = [];
    const divergences: EquivalenceDivergence[] = [];
    let inconclusive = false;

    for (const [index, abstractStep] of sequence.entries()) {
      const operation = abstractStep.operation;
      const modelRequest = resolveRequest(abstractStep.request, modelSymbols);
      const realRequest = resolveRequest(abstractStep.request, realSymbols);
      const context = { index, operation };

      let modelPreState: JsonValue | null | undefined;
      let realPreState: JsonValue | null | undefined;
      if (abstractStep.mutating === true) {
        if (abstractStep.preStateRequest === undefined) {
          throw new Error(`Mutating equivalence step ${operation} requires preStateRequest`);
        }
        const modelPre = await execute(
          this.model,
          resolveRequest(abstractStep.preStateRequest, modelSymbols),
          context,
        );
        const realPre = await execute(
          this.real,
          resolveRequest(abstractStep.preStateRequest, realSymbols),
          context,
        );
        modelPreState = modelPre.status >= 400 ? null : (modelPre.body ?? null);
        realPreState = realPre.status >= 400 ? null : (realPre.body ?? null);
      }

      const [modelResult, realResult] = await Promise.all([
        executeStable(
          this.model,
          modelRequest,
          resolvePoll(abstractStep.poll, modelSymbols),
          context,
          this.sleep,
          this.defaultPoll,
        ),
        executeStable(
          this.real,
          realRequest,
          resolvePoll(abstractStep.poll, realSymbols),
          context,
          this.sleep,
          this.defaultPoll,
        ),
      ]);
      if (!modelResult.stable || !realResult.stable) {
        inconclusive = true;
        divergences.push({
          code: 'INCONCLUSIVE',
          operation,
          path: '$.body',
          message: `Projection for ${operation} did not become stable within the configured polling bound`,
        });
      }

      captureSymbols(
        abstractStep.captures ?? [],
        modelResult.observation.body ?? null,
        modelSymbols,
      );
      captureSymbols(abstractStep.captures ?? [], realResult.observation.body ?? null, realSymbols);
      if (modelResult.stable && realResult.stable) {
        steps.push({
          operation,
          request: abstractStep.request,
          model: modelResult.observation,
          real: realResult.observation,
          ...(abstractStep.mutating === true
            ? {
                preState: {
                  model: modelPreState ?? null,
                  real: realPreState ?? null,
                },
              }
            : {}),
          ...(abstractStep.writeSet === undefined ? {} : { writeSet: abstractStep.writeSet }),
        });
      }
    }

    const comparison = compareEquivalenceTrace(steps, this.options.policy, this.options.ledger);
    const allDivergences = [...comparison.divergences, ...divergences];
    const verdict = inconclusive
      ? 'INCONCLUSIVE'
      : allDivergences.length === 0
        ? 'CONFORMS'
        : 'DIVERGES';
    return {
      verdict,
      conforms: verdict === 'CONFORMS',
      inconclusive,
      steps: Object.freeze(steps),
      comparison,
      divergences: Object.freeze(allDivergences),
    };
  }

  public async runMany(
    sequences: readonly (readonly SymbolicSequenceStep[])[],
  ): Promise<readonly DualRunResult[]> {
    const results: DualRunResult[] = [];
    for (const sequence of sequences) results.push(await this.run(sequence));
    return Object.freeze(results);
  }
}

export function createSymbolicDualRunner(options: DualRunnerOptions): SymbolicDualRunner {
  return new SymbolicDualRunner(options);
}

function endpointFromBaseUrl(
  baseUrl: string | undefined,
  fetcher: HttpFetcher | undefined,
): EquivalenceEndpoint {
  if (baseUrl === undefined)
    throw new Error('Dual runner requires both endpoint implementations or base URLs');
  return createRealApiEndpoint({ baseUrl, fetch: fetcher });
}

function resetFromBaseUrl(
  baseUrl: string | undefined,
  fetcher: HttpFetcher | undefined,
): () => Promise<void> {
  if (baseUrl === undefined) {
    throw new Error('Dual runner requires resetModel or a Potemkin modelBaseUrl');
  }
  const request = fetcher ?? ((url, init) => globalThis.fetch(url, init));
  return async () => {
    const response = await request(`${baseUrl.replace(/\/$/, '')}/_admin/reset`, {
      method: 'POST',
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Potemkin reset failed with status ${response.status}`);
    }
    await response.text();
  };
}

async function execute(
  endpoint: EquivalenceEndpoint,
  request: EquivalenceRequest,
  context: Readonly<{ index: number; operation: string }>,
): Promise<EquivalenceObservation> {
  return endpoint.execute(request, context);
}

async function executeStable(
  endpoint: EquivalenceEndpoint,
  request: EquivalenceRequest,
  poll: StablePoll | undefined,
  context: Readonly<{ index: number; operation: string }>,
  sleep: (milliseconds: number) => Promise<void>,
  defaults: Readonly<{ maxAttempts: number; intervalMs: number }>,
): Promise<SideResult> {
  const initial = await execute(endpoint, request, context);
  if (poll === undefined) return { observation: initial, stable: true };
  const maxAttempts = Math.max(1, poll.maxAttempts ?? defaults.maxAttempts);
  const intervalMs = Math.max(0, poll.intervalMs ?? defaults.intervalMs);
  let previous: EquivalenceObservation | undefined;
  let current = initial;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (intervalMs > 0) await sleep(intervalMs);
    current = await execute(endpoint, poll.request, context);
    if (previous !== undefined && sameProjection(previous, current)) {
      return { observation: { ...initial, body: current.body }, stable: true };
    }
    previous = current;
  }
  return { observation: { ...initial, body: current.body }, stable: false };
}

function sameProjection(left: EquivalenceObservation, right: EquivalenceObservation): boolean {
  return (
    JSON.stringify({ status: left.status, body: left.body }) ===
    JSON.stringify({ status: right.status, body: right.body })
  );
}

function resolveRequest(request: EquivalenceRequest, symbols: MutableSymbols): EquivalenceRequest {
  return {
    ...request,
    path: resolveTemplate(request.path, symbols),
    ...(request.body === undefined ? {} : { body: resolveValue(request.body, symbols) }),
    ...(request.headers === undefined
      ? {}
      : { headers: resolveValue(request.headers, symbols) as Readonly<Record<string, string>> }),
  };
}

function resolvePoll(
  poll: StablePoll | undefined,
  symbols: MutableSymbols,
): StablePoll | undefined {
  if (poll === undefined) return undefined;
  return { ...poll, request: resolveRequest(poll.request, symbols) };
}

function resolveValue(value: JsonValue, symbols: MutableSymbols): JsonValue {
  if (typeof value === 'string') return resolveTemplateValue(value, symbols);
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, symbols));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, resolveValue(child, symbols)]),
    );
  }
  return value;
}

function resolveTemplate(value: string, symbols: MutableSymbols): string {
  const resolved = resolveTemplateValue(value, symbols);
  if (typeof resolved !== 'string')
    throw new Error(`Path template ${value} did not resolve to a string`);
  return resolved;
}

function resolveTemplateValue(value: string, symbols: MutableSymbols): string {
  return value.replace(/\{\{([A-Za-z][A-Za-z0-9_.-]*)\}\}/g, (_match, symbol: string) => {
    const resolved = symbols.values.get(symbol);
    if (resolved === undefined) throw new Error(`Unbound symbolic identifier ${symbol}`);
    return resolved;
  });
}

function captureSymbols(
  captures: readonly SymbolicCapture[],
  body: JsonValue,
  symbols: MutableSymbols,
): void {
  for (const capture of captures) {
    const value = readPath(body, capture.responsePath);
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new Error(
        `Symbolic capture ${capture.symbol} was not a scalar at ${capture.responsePath}: ${JSON.stringify(body)}`,
      );
    }
    const concrete = String(value);
    const previous = symbols.values.get(capture.symbol);
    if (previous !== undefined && previous !== concrete) {
      throw new Error(
        `Symbolic identifier ${capture.symbol} was rebound from ${previous} to ${concrete}`,
      );
    }
    symbols.values.set(capture.symbol, concrete);
  }
}

function readPath(value: JsonValue, path: string): JsonValue | undefined {
  const segments = path
    .replace(/^\$\.?/, '')
    .split(/[.[\]]+/)
    .filter(Boolean);
  let current: JsonValue | undefined = value;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    current = Array.isArray(current)
      ? current[Number(segment)]
      : (current as Readonly<Record<string, JsonValue>>)[segment];
  }
  return current;
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
