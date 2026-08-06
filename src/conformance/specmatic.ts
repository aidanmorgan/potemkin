import * as fs from 'node:fs/promises';
import * as cp from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseJunitDirectory } from './junit.js';
import type {
  CommandRunner,
  ProcessResult,
  SpecmaticTestOptions,
  SpecmaticTestResult,
} from './types.js';

export class ConformanceToolUnavailableError extends Error {
  readonly code = 'CONFORMANCE_TOOL_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'ConformanceToolUnavailableError';
  }
}

export class SpecmaticProcessError extends Error {
  readonly code = 'SPECMATIC_PROCESS_FAILED';
  constructor(message: string) {
    super(message);
    this.name = 'SpecmaticProcessError';
  }
}

const MAX_DIAGNOSTIC_OUTPUT_BYTES = 64 * 1024;

/**
 * Retains a bounded diagnostic tail for a child-process stream.
 *
 * Each stream keeps its last 64 KiB. Once that limit is exceeded, earlier
 * bytes are discarded and a fixed marker is prepended to the returned text.
 * The tail is useful for process failures, which generally report the final
 * error after their progress output, while the fixed policy makes retained
 * memory independent of process lifetime and output volume.
 */
class BoundedDiagnosticOutput {
  private bytes = Buffer.alloc(0);
  private truncated = false;

  append(chunk: Buffer | string): void {
    const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    if (incoming.length === 0) return;

    if (incoming.length > MAX_DIAGNOSTIC_OUTPUT_BYTES) {
      this.bytes = Buffer.from(incoming.subarray(incoming.length - MAX_DIAGNOSTIC_OUTPUT_BYTES));
      this.truncated = true;
      return;
    }

    const combined = Buffer.concat([this.bytes, incoming]);
    if (combined.length > MAX_DIAGNOSTIC_OUTPUT_BYTES) {
      this.bytes = Buffer.from(combined.subarray(combined.length - MAX_DIAGNOSTIC_OUTPUT_BYTES));
      this.truncated = true;
      return;
    }

    this.bytes = combined;
  }

  toString(streamName: 'stdout' | 'stderr'): string {
    const output = this.bytes.toString('utf8');
    return this.truncated
      ? `[${streamName} truncated; retaining the last ${MAX_DIAGNOSTIC_OUTPUT_BYTES} bytes]\n${output}`
      : output;
  }
}

class ChildProcessRunner implements CommandRunner {
  run(options: {
    command: string;
    args: readonly string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  }): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = cp.spawn(options.command, [...options.args], {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout = new BoundedDiagnosticOutput();
      const stderr = new BoundedDiagnosticOutput();
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout.append(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr.append(chunk);
      });
      child.once('error', reject);
      child.once('close', (exitCode, signal) =>
        resolve({
          command: options.command,
          args: options.args,
          cwd: options.cwd,
          exitCode,
          signal,
          stdout: stdout.toString('stdout'),
          stderr: stderr.toString('stderr'),
        }),
      );
    });
  }
}

export function javaAvailable(): boolean {
  const result = cp.spawnSync('java', ['-version'], { stdio: 'ignore' });
  return result.error === undefined && result.status === 0;
}

function unavailable(message: string): never {
  throw new ConformanceToolUnavailableError(`Specmatic conformance gate unavailable: ${message}`);
}

export async function runSpecmaticTest(
  options: SpecmaticTestOptions,
): Promise<SpecmaticTestResult> {
  if (
    options.maxTestRequestCombinations !== undefined &&
    (!Number.isSafeInteger(options.maxTestRequestCombinations) ||
      options.maxTestRequestCombinations < 1)
  ) {
    throw new Error('maxTestRequestCombinations must be a positive safe integer');
  }
  const filter = options.filter?.trim();
  if (options.filter !== undefined && !filter)
    throw new Error('Specmatic filter must be a non-empty expression');
  if (!(options.javaAvailable ?? javaAvailable)())
    unavailable('Java was not found on PATH. Install a JDK or provide a fake runner in tests.');
  if (!options.jarPath) unavailable('no Specmatic JAR path was supplied.');
  if (!options.commandRunner) {
    try {
      await fs.access(options.jarPath);
    } catch {
      unavailable(`the Specmatic JAR does not exist at ${options.jarPath}.`);
    }
  }

  const generatedConfigPath =
    options.configPath === undefined &&
    (options.testMode !== undefined || options.maxTestRequestCombinations !== undefined)
      ? await createSpecmaticTestConfig(options)
      : undefined;
  const configPath = options.configPath ?? generatedConfigPath;

  const args = [
    '-Xmx512m',
    '-XX:+UseSerialGC',
    '-cp',
    options.jarPath,
    'application.SpecmaticApplication',
    'test',
    '--testBaseURL',
    options.testBaseUrl,
    '--junitReportDir',
    options.junitReportDir,
  ];
  if (configPath) args.push('--config', configPath);
  if (options.examplesDir) args.push('--examples', options.examplesDir);
  if (filter) args.push('--filter', filter);
  args.push(options.contractPath);

  const env: NodeJS.ProcessEnv = { ...options.env };
  const runner = options.commandRunner ?? new ChildProcessRunner();
  let processResult: ProcessResult;
  try {
    try {
      processResult = await runner.run({ command: 'java', args, cwd: options.cwd, env });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      unavailable(`the Java process could not be started: ${reason}`);
    }

    let report;
    try {
      report = await parseJunitDirectory(options.junitReportDir);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (processResult.exitCode !== 0) {
        throw new SpecmaticProcessError(
          [
            `Specmatic test exited with code ${processResult.exitCode ?? 'unknown'}${processResult.signal ? ` (${processResult.signal})` : ''}.`,
            reason,
            processResult.stderr.trim() ||
              processResult.stdout.trim() ||
              '(Specmatic produced no diagnostic output)',
          ].join('\n'),
        );
      }
      throw error;
    }
    return { process: processResult, report };
  } finally {
    if (generatedConfigPath)
      await fs
        .rm(path.dirname(generatedConfigPath), { force: true, recursive: true })
        .catch(() => {});
  }
}

async function createSpecmaticTestConfig(options: SpecmaticTestOptions): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-specmatic-config-'));
  const filePath = path.join(directory, 'specmatic.yaml');
  const mode = options.testMode ?? 'all';
  const maxCombinations = options.maxTestRequestCombinations;
  const lines = [
    'version: 3',
    'specmatic:',
    '  settings:',
    '    test:',
    `      schemaResiliencyTests: ${mode}`,
    ...(maxCombinations === undefined
      ? []
      : [`      maxTestRequestCombinations: ${maxCombinations}`]),
  ];
  await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
}
