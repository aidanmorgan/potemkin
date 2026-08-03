import type { JsonValue } from "../../src/types.js";
import { compareEquivalenceTrace } from "./comparator.js";
import type {
  DivergenceLedgerEntry,
  EquivalenceComparison,
  EquivalenceDivergence,
  EquivalenceObservation,
  EquivalenceRequest,
  EquivalenceStep,
  ProjectionPolicy,
} from "./types.js";

/** The small response surface needed by an HTTP endpoint, making fetch easy to inject in tests. */
export interface HttpFetchResponse {
  readonly status: number;
  readonly headers?: HeaderCollection;
  text(): Promise<string>;
}

export type HttpFetcher = (url: string, init: RequestInit) => Promise<HttpFetchResponse>;

export type HeaderCollection =
  | Readonly<Record<string, string>>
  | Iterable<readonly [string, string]>
  | { forEach(callback: (value: string, key: string) => void): void };

export interface RawHttpObservation {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
}

export interface EquivalenceEndpointContext extends EquivalenceExecutionContext {
  readonly request: EquivalenceRequest;
  readonly response?: EquivalenceObservation;
}

export interface EquivalenceExecutionContext {
  readonly index: number;
  readonly operation: string;
}

export type ObservationNormalizer = (
  raw: RawHttpObservation,
  context: EquivalenceEndpointContext,
) => EquivalenceObservation | Promise<EquivalenceObservation>;

export type EventSource = (
  context: EquivalenceEndpointContext,
) => readonly JsonValue[] | Promise<readonly JsonValue[]>;

export type Quiescence = (context: EquivalenceEndpointContext) => void | Promise<void>;

export interface EquivalenceEndpoint {
  execute(
    request: EquivalenceRequest,
    context: EquivalenceExecutionContext,
  ): Promise<EquivalenceObservation>;
}

export interface RealApiEndpointOptions {
  /** A base URL for relative request paths. Absolute paths are passed through unchanged. */
  readonly baseUrl?: string;
  /** Defaults to the Node 24 global fetch implementation. */
  readonly fetch?: HttpFetcher;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly normalize?: ObservationNormalizer;
  readonly eventSource?: EventSource;
  readonly quiesce?: Quiescence;
}

/**
 * Build an endpoint for a real HTTP service. It performs one request at a time and
 * collects the response only after the body has been consumed. Event collection is
 * deliberately a separate callback so API transport and event transport can differ.
 */
export function createRealApiEndpoint(options: RealApiEndpointOptions = {}): EquivalenceEndpoint {
  const fetcher = options.fetch ?? defaultFetch;
  return {
    async execute(request, context): Promise<EquivalenceObservation> {
      const headers: Record<string, string> = {
        ...options.headers,
        ...request.headers,
      };
      let body: string | undefined;
      if (request.body !== undefined) {
        if (request.bodyEncoding === "form") {
          body = encodeFormBody(request.body);
          if (!hasHeader(headers, "content-type"))
            headers["content-type"] = "application/x-www-form-urlencoded";
        } else {
          body = JSON.stringify(request.body);
          if (!hasHeader(headers, "content-type")) headers["content-type"] = "application/json";
        }
      }

      const controller = options.timeoutMs === undefined ? undefined : new AbortController();
      const init: RequestInit = {
        method: request.method.toUpperCase(),
        headers,
        ...(body === undefined ? {} : { body }),
        ...(controller === undefined ? {} : { signal: controller.signal }),
      };
      const response = await withTimeout(
        fetcher(resolveUrl(options.baseUrl, request.path), init),
        options.timeoutMs,
        controller,
      );
      const raw: RawHttpObservation = {
        status: response.status,
        headers: normalizeHeaders(response.headers),
        text: await response.text(),
      };
      const normalized = await (options.normalize ?? normalizeHttpObservation)(raw, {
        ...context,
        request,
      });
      const quiescenceContext: EquivalenceEndpointContext = {
        ...context,
        request,
        response: normalized,
      };
      if (options.quiesce !== undefined) await options.quiesce(quiescenceContext);
      if (options.eventSource === undefined) return normalized;
      const events = await options.eventSource(quiescenceContext);
      return { ...normalized, events: [...events] };
    },
  };
}

export interface RealApiEquivalenceRunnerOptions {
  readonly model: EquivalenceEndpoint;
  readonly real: EquivalenceEndpoint;
  readonly policy?: ProjectionPolicy;
  readonly ledger?: readonly DivergenceLedgerEntry[];
}

export interface EquivalenceRunResult {
  readonly conforms: boolean;
  readonly steps: readonly EquivalenceStep[];
  readonly observations: readonly EquivalenceObservationPair[];
  readonly comparison: EquivalenceComparison;
  readonly divergences: readonly EquivalenceDivergence[];
  readonly report: string;
}

export interface EquivalenceObservationPair {
  readonly operation: string;
  readonly request: EquivalenceRequest;
  readonly model: EquivalenceObservation;
  readonly real: EquivalenceObservation;
}

/**
 * Runs a model endpoint and a real endpoint in a deterministic sequence. The model
 * side is called first for each step, followed by the real side; neither side is
 * run concurrently, which keeps stateful APIs reproducible.
 */
export class RealApiEquivalenceRunner {
  public constructor(private readonly options: RealApiEquivalenceRunnerOptions) {}

  public async run(requests: readonly EquivalenceRequest[]): Promise<EquivalenceRunResult> {
    const observations: EquivalenceObservationPair[] = [];
    const steps: EquivalenceStep[] = [];
    const endpointDivergences: EquivalenceDivergence[] = [];

    for (const [index, request] of requests.entries()) {
      const operation = request.operation ?? `${request.method.toUpperCase()} ${request.path}`;
      const context = { index, operation };
      const model = await executeSafely(
        this.options.model,
        request,
        context,
        "model",
        endpointDivergences,
      );
      const real = await executeSafely(
        this.options.real,
        request,
        context,
        "real",
        endpointDivergences,
      );
      const pair = { operation, request, model, real };
      observations.push(pair);
      steps.push({ operation, request, model, real });
    }

    const comparison = compareEquivalenceTrace(steps, this.options.policy, this.options.ledger);
    const eventDivergences = compareEvents(observations);
    const divergences = [...comparison.divergences, ...eventDivergences, ...endpointDivergences];
    return {
      conforms: divergences.length === 0,
      steps: Object.freeze(steps),
      observations: Object.freeze(observations),
      comparison,
      divergences: Object.freeze(divergences),
      report: formatDivergenceReport(divergences),
    };
  }
}

export function createRealApiEquivalenceRunner(
  options: RealApiEquivalenceRunnerOptions,
): RealApiEquivalenceRunner {
  return new RealApiEquivalenceRunner(options);
}

export function runRealApiEquivalence(
  requests: readonly EquivalenceRequest[],
  options: RealApiEquivalenceRunnerOptions,
): Promise<EquivalenceRunResult> {
  return createRealApiEquivalenceRunner(options).run(requests);
}

export function normalizeHeaders(
  headers: HeaderCollection | undefined,
): Readonly<Record<string, string>> {
  if (headers === undefined) return {};
  const entries: Array<[string, string]> = [];
  if (typeof (headers as { forEach?: unknown }).forEach === "function") {
    (headers as { forEach(callback: (value: string, key: string) => void): void }).forEach(
      (value, key) => {
        entries.push([key, value]);
      },
    );
  } else if (Symbol.iterator in Object(headers)) {
    for (const [key, value] of headers as Iterable<readonly [string, string]>)
      entries.push([key, value]);
  } else {
    for (const [key, value] of Object.entries(headers)) entries.push([key, value]);
  }
  const normalized: Record<string, string> = {};
  for (const [key, value] of entries) normalized[key.toLowerCase()] = value.trim();
  return Object.fromEntries(
    Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export async function normalizeHttpObservation(
  raw: RawHttpObservation,
): Promise<EquivalenceObservation> {
  const contentType = raw.headers["content-type"]?.toLowerCase() ?? "";
  const text = raw.text.trim();
  let body: JsonValue | null = null;
  if (text.length > 0) {
    if (contentType.includes("json") || looksLikeJson(text)) {
      try {
        body = JSON.parse(text) as JsonValue;
      } catch {
        body = raw.text;
      }
    } else {
      body = raw.text;
    }
  }
  return { status: raw.status, headers: raw.headers, body };
}

export function formatDivergenceReport(divergences: readonly EquivalenceDivergence[]): string {
  if (divergences.length === 0) return "No equivalence divergences.";
  return divergences
    .map((divergence, index) => {
      const expected =
        divergence.expected === undefined ? "" : ` expected=${display(divergence.expected)}`;
      const actual = divergence.actual === undefined ? "" : ` actual=${display(divergence.actual)}`;
      return `${index + 1}. [${divergence.code}] ${divergence.operation} ${divergence.path}: ${divergence.message}${expected}${actual}`;
    })
    .join("\n");
}

async function executeSafely(
  endpoint: EquivalenceEndpoint,
  request: EquivalenceRequest,
  context: EquivalenceExecutionContext,
  side: "model" | "real",
  divergences: EquivalenceDivergence[],
): Promise<EquivalenceObservation> {
  try {
    return await endpoint.execute(request, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    divergences.push({
      code: "ENDPOINT_FAILURE",
      operation: context.operation,
      path: `$.${side}`,
      actual: message,
      message: `${side} endpoint failed: ${message}`,
    });
    return { status: 599, headers: {}, body: null };
  }
}

function compareEvents(
  observations: readonly EquivalenceObservationPair[],
): readonly EquivalenceDivergence[] {
  const divergences: EquivalenceDivergence[] = [];
  for (const observation of observations) {
    if (observation.model.events === undefined || observation.real.events === undefined) continue;
    const comparison = compareEquivalenceTrace([
      {
        operation: `${observation.operation} events`,
        request: observation.request,
        model: { status: 200, body: [...observation.model.events] },
        real: { status: 200, body: [...observation.real.events] },
      },
    ]);
    for (const divergence of comparison.divergences) {
      divergences.push({
        ...divergence,
        code: divergence.code === "BODY_MISMATCH" ? "EVENT_MISMATCH" : divergence.code,
        path: divergence.path.replace("$.body", "$.events"),
        message: `Event observation differs: ${divergence.message}`,
      });
    }
  }
  return divergences;
}

function resolveUrl(baseUrl: string | undefined, path: string): string {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(path) || baseUrl === undefined) return path;
  const base = new URL(`${baseUrl.replace(/\/$/, "")}/`);
  const relativePath = path.replace(/^\/+/, "");
  return new URL(relativePath, base).toString();
}

function hasHeader(headers: Readonly<Record<string, string>>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

function encodeFormBody(value: JsonValue): string {
  if (value === null || Array.isArray(value) || typeof value !== "object")
    throw new Error("Form request bodies must be JSON objects");
  const form = new URLSearchParams();
  for (const [key, child] of Object.entries(value)) {
    if (child === null) form.append(key, "");
    else if (typeof child === "string" || typeof child === "number" || typeof child === "boolean")
      form.append(key, String(child));
    else form.append(key, JSON.stringify(child));
  }
  return form.toString();
}

function looksLikeJson(text: string): boolean {
  return (
    text.startsWith("{") ||
    text.startsWith("[") ||
    text === "null" ||
    text === "true" ||
    text === "false" ||
    /^-?\d/.test(text)
  );
}

function display(value: JsonValue | string | number): string {
  return typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  controller: AbortController | undefined,
): Promise<T> {
  if (timeoutMs === undefined) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          controller?.abort();
          reject(new Error(`HTTP request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const defaultFetch: HttpFetcher = (url, init) => globalThis.fetch(url, init);
