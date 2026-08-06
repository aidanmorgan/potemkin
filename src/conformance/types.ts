/** Data contracts used by the Specmatic conformance gate. */

import { httpMethods, type HttpMethod } from '../domain/references.js';
import { isRecord, type JsonValue } from '../contracts/value.js';

declare const conformanceBrand: unique symbol;

type ConformanceBrand<Value extends string | number, Kind extends string> = Value & {
  readonly [conformanceBrand]: Kind;
};

/** A URL that has crossed the conformance input validation boundary. */
export type ConformanceUrl = ConformanceBrand<string, 'conformance-url'>;

/** A filesystem path used to locate a conformance artifact. */
export type ConformanceFilePath = ConformanceBrand<string, 'conformance-file-path'>;

/** An HTTP request path extracted from a conformance artifact. */
export type ConformanceRequestPath = ConformanceBrand<string, 'conformance-request-path'>;

/** A stable identifier assigned to a testcase in a conformance report. */
export type ConformanceReportId = ConformanceBrand<string, 'conformance-report-id'>;

/** A non-empty status token reported by JUnit, including values such as `4xx`. */
export type ConformanceStatusToken = ConformanceBrand<string, 'conformance-status-token'>;

/** A validated numeric HTTP status code from an exported example. */
export type ConformanceStatusCode = ConformanceBrand<number, 'conformance-status-code'>;

/** Known HTTP methods plus validated extension methods from an external report. */
export type ConformanceHttpMethod =
  | HttpMethod
  | ConformanceBrand<string, 'conformance-http-method'>;

function brand<Value extends string | number, Kind extends string>(
  value: Value,
): ConformanceBrand<Value, Kind> {
  return value as ConformanceBrand<Value, Kind>;
}

export function toConformanceUrl(value: string): ConformanceUrl {
  const normalized = value.trim();
  const url = new URL(normalized);
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error(`Conformance URL must use HTTP or HTTPS: ${value}`);
  return brand(normalized);
}

export function toConformanceFilePath(value: string): ConformanceFilePath {
  const normalized = value.trim();
  if (normalized === '') throw new Error('Conformance file path must not be empty');
  return brand(normalized);
}

export function toConformanceRequestPath(value: string): ConformanceRequestPath {
  const normalized = value.trim();
  if (normalized === '') throw new Error('Conformance request path must not be empty');
  if (/^https?:\/\//i.test(normalized)) {
    const url: ConformanceUrl = toConformanceUrl(normalized);
    const parsed = new URL(url);
    return brand(`${parsed.pathname}${parsed.search}`);
  }
  return brand(normalized);
}

export function toConformanceReportId(value: string): ConformanceReportId {
  const normalized = value.trim();
  if (normalized === '') throw new Error('Conformance report identifier must not be empty');
  return brand(normalized);
}

export function toConformanceStatusToken(value: string): ConformanceStatusToken {
  const normalized = value.trim();
  if (normalized === '') throw new Error('Conformance status token must not be empty');
  return brand(normalized);
}

export function toConformanceStatusCode(value: number): ConformanceStatusCode {
  if (!Number.isInteger(value) || value < 100 || value > 599)
    throw new Error(`Conformance status code must be an integer from 100 to 599: ${value}`);
  return brand(value);
}

export function toConformanceHttpMethod(value: string): ConformanceHttpMethod {
  const normalized = value.trim().toUpperCase();
  if (normalized === '') throw new Error('Conformance HTTP method must not be empty');
  const knownMethod = httpMethods.find((method) => method === normalized);
  if (knownMethod !== undefined) return knownMethod;
  return brand(normalized);
}

/** Raw shape accepted at the JSON boundary of an exported Specmatic example. */
export interface ExportedCorpusExampleInput {
  readonly 'http-request': {
    readonly method: string;
    readonly path: string;
  };
  readonly 'http-response': {
    readonly status: number;
    readonly body?: unknown;
  };
}

/** Parsed and validated shape of one exported Specmatic example. */
export interface ExportedCorpusExample {
  readonly request: {
    readonly method: ConformanceHttpMethod;
    readonly path: ConformanceRequestPath;
  };
  readonly response: {
    readonly status: ConformanceStatusCode;
    readonly body?: JsonValue;
  };
}

export function isExportedCorpusExampleInput(value: unknown): value is ExportedCorpusExampleInput {
  if (!isRecord(value)) return false;
  const document = value;
  const request = document['http-request'];
  const response = document['http-response'];
  if (!isRecord(request) || !isRecord(response)) return false;
  if (typeof request.method !== 'string' || typeof request.path !== 'string') return false;
  if (typeof response.status !== 'number') return false;
  return true;
}

export interface ConformanceCaseKey {
  readonly method: string;
  readonly path: string;
  readonly scenario: string;
  readonly expectedStatus: string;
  readonly actualStatus: string;
  readonly ruleId?: string;
}

export interface ConformanceFailure extends ConformanceCaseKey {
  readonly testName: string;
  readonly classname?: string;
  readonly message: string;
  readonly details: string;
}

/**
 * One testcase emitted by Specmatic's JUnit reporter.
 *
 * The conformance gate only needs failures, but verifier consumers also need
 * the successful cases to prove that the JVM actually exercised the contract.
 * Unknown status values are explicit because Specmatic does not include
 * request/response diagnostics on every successful testcase.
 */
export interface ConformanceTestCase extends ConformanceCaseKey {
  readonly testName: string;
  readonly classname?: string;
  readonly passed: boolean;
  readonly skipped: boolean;
  readonly message: string;
  readonly details: string;
}

export interface ConformanceReport {
  readonly tests: number;
  readonly failures: number;
  readonly errors: number;
  readonly skipped: number;
  readonly cases: readonly ConformanceFailure[];
  /** All parsed testcases, including successful and skipped cases. */
  readonly testCases?: readonly ConformanceTestCase[];
  readonly sourceFiles: readonly string[];
}

export interface ConformanceAllowlistEntry extends Omit<
  ConformanceCaseKey,
  'method' | 'path' | 'expectedStatus' | 'actualStatus'
> {
  readonly method: ConformanceHttpMethod;
  readonly path: ConformanceRequestPath;
  readonly expectedStatus: ConformanceStatusToken;
  readonly actualStatus: ConformanceStatusToken;
  readonly id: string;
  readonly reason: string;
  readonly source?: string;
}

export interface NamedConformanceAllowlist {
  readonly name: string;
  readonly entries: readonly ConformanceAllowlistEntry[];
}

export interface AllowlistDocument {
  readonly version: 1;
  readonly name?: string;
  readonly entries?: readonly ConformanceAllowlistEntry[];
  readonly allowlists?: readonly NamedConformanceAllowlist[];
}

export interface AllowlistEvaluation {
  readonly allowed: readonly ConformanceFailure[];
  readonly unexpected: readonly ConformanceFailure[];
  readonly stale: readonly ConformanceAllowlistEntry[];
}

export interface ProcessResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly exitCode: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(options: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
  }): Promise<ProcessResult>;
}

export interface SpecmaticTestOptions {
  readonly jarPath: string;
  readonly testBaseUrl: string;
  readonly contractPath: string;
  readonly junitReportDir: string;
  /** Optional Specmatic YAML/JSON settings file passed to the real JVM. */
  readonly configPath?: string;
  readonly examplesDir?: string;
  readonly filter?: string;
  /** Specmatic's actual v3 resiliency mode, written to --config. */
  readonly testMode?: 'all' | 'positiveOnly' | 'none';
  readonly maxTestRequestCombinations?: number;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly commandRunner?: CommandRunner;
  readonly javaAvailable?: () => boolean;
}

export interface SpecmaticTestResult {
  readonly process: ProcessResult;
  readonly report: ConformanceReport;
}

export interface ConformanceProvider {
  readonly baseUrl: string;
  reset(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface ConformanceGateOptions {
  readonly provider: ConformanceProvider;
  readonly verifier: () => Promise<SpecmaticTestResult>;
  readonly allowlist?: NamedConformanceAllowlist;
}
