/** Data contracts used by the Specmatic conformance gate. */

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

export interface ConformanceAllowlistEntry extends ConformanceCaseKey {
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
