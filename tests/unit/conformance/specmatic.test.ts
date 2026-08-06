import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const mockSpawn = jest.fn();
jest.mock('node:child_process', () => ({
  ...jest.requireActual('node:child_process'),
  spawn: mockSpawn,
}));

import {
  ConformanceToolUnavailableError,
  runSpecmaticTest,
} from '../../../src/conformance/specmatic';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe('Specmatic verifier runner', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('fails clearly when Java is unavailable', async () => {
    await expect(
      runSpecmaticTest({
        jarPath: '/missing/specmatic.jar',
        testBaseUrl: 'http://127.0.0.1:1234',
        contractPath: '/missing/openapi.yaml',
        junitReportDir: '/missing/report',
        javaAvailable: () => false,
      }),
    ).rejects.toBeInstanceOf(ConformanceToolUnavailableError);
  });

  it('constructs the test-mode command and parses its report through a fake runner', async () => {
    const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-conformance-test-'));
    await fs.writeFile(
      path.join(reportDir, 'results.xml'),
      '<testsuite tests="1" failures="0" errors="0" />',
    );
    let invocation:
      | { command: string; args: readonly string[]; env?: NodeJS.ProcessEnv }
      | undefined;
    const result = await runSpecmaticTest({
      jarPath: '/tmp/specmatic.jar',
      testBaseUrl: 'http://127.0.0.1:4321',
      contractPath: '/tmp/crm.yaml',
      junitReportDir: reportDir,
      filter: "METHOD='POST'",
      testMode: 'all',
      maxTestRequestCombinations: 25,
      javaAvailable: () => true,
      commandRunner: {
        async run(options) {
          invocation = options;
          return {
            command: options.command,
            args: options.args,
            exitCode: 0,
            signal: null,
            stdout: '',
            stderr: '',
          };
        },
      },
    });
    expect(invocation?.command).toBe('java');
    expect(invocation?.args).toEqual(
      expect.arrayContaining([
        'application.SpecmaticApplication',
        'test',
        '--testBaseURL',
        'http://127.0.0.1:4321',
        '--junitReportDir',
        reportDir,
        '--filter',
        "METHOD='POST'",
        '/tmp/crm.yaml',
      ]),
    );
    expect(invocation?.args).toEqual(
      expect.arrayContaining(['--config', expect.stringContaining('specmatic-config-')]),
    );
    expect(result.report.tests).toBe(1);
  });

  it('passes an externalized examples directory when requested', async () => {
    const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-conformance-examples-'));
    await fs.writeFile(
      path.join(reportDir, 'results.xml'),
      '<testsuite tests="1" failures="0" errors="0" />',
    );
    let invocation: { args: readonly string[] } | undefined;
    await runSpecmaticTest({
      jarPath: '/tmp/specmatic.jar',
      testBaseUrl: 'http://127.0.0.1:4321',
      contractPath: '/tmp/crm.yaml',
      junitReportDir: reportDir,
      examplesDir: '/tmp/crm_examples',
      javaAvailable: () => true,
      commandRunner: {
        async run(options) {
          invocation = options;
          return {
            command: options.command,
            args: options.args,
            exitCode: 0,
            signal: null,
            stdout: '',
            stderr: '',
          };
        },
      },
    });
    expect(invocation?.args).toEqual(expect.arrayContaining(['--examples', '/tmp/crm_examples']));
  });

  it('passes a real Specmatic config file to the JVM', async () => {
    const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-conformance-config-'));
    await fs.writeFile(path.join(reportDir, 'results.xml'), '<testsuite tests="1" />');
    let args: readonly string[] | undefined;
    await runSpecmaticTest({
      jarPath: '/tmp/specmatic.jar',
      testBaseUrl: 'http://127.0.0.1:4321',
      contractPath: '/tmp/crm.yaml',
      junitReportDir: reportDir,
      configPath: '/tmp/verifier-specmatic.yaml',
      javaAvailable: () => true,
      commandRunner: {
        async run(options) {
          args = options.args;
          return {
            command: options.command,
            args: options.args,
            exitCode: 0,
            signal: null,
            stdout: '',
            stderr: '',
          };
        },
      },
    });
    expect(args).toEqual(expect.arrayContaining(['--config', '/tmp/verifier-specmatic.yaml']));
  });

  it('passes only the explicitly supplied child-process environment', async () => {
    const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-conformance-env-'));
    await fs.writeFile(
      path.join(reportDir, 'results.xml'),
      '<testsuite tests="1" failures="0" errors="0" />',
    );
    let receivedEnv: NodeJS.ProcessEnv | undefined;
    await runSpecmaticTest({
      jarPath: '/tmp/specmatic.jar',
      testBaseUrl: 'http://127.0.0.1:4321',
      contractPath: '/tmp/crm.yaml',
      junitReportDir: reportDir,
      env: { KEEP_THIS: 'true' },
      javaAvailable: () => true,
      commandRunner: {
        async run(options) {
          receivedEnv = options.env;
          return {
            command: options.command,
            args: options.args,
            exitCode: 0,
            signal: null,
            stdout: '',
            stderr: '',
          };
        },
      },
    });
    expect(receivedEnv).toHaveProperty('KEEP_THIS', 'true');
  });

  it('preserves child-process diagnostics that fit within the bound', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-conformance-output-'));
    const jarPath = path.join(root, 'specmatic.jar');
    const reportDir = path.join(root, 'report');
    await fs.writeFile(jarPath, 'test jar');
    await fs.mkdir(reportDir);
    await fs.writeFile(path.join(reportDir, 'results.xml'), '<testsuite tests="1" />');

    const child = createFakeChild();
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('stdout remains unchanged\n'));
        child.stderr.emit('data', Buffer.from('stderr remains unchanged\n'));
        child.emit('close', 0, null);
      });
      return child;
    });

    const result = await runSpecmaticTest({
      jarPath,
      testBaseUrl: 'http://127.0.0.1:4321',
      contractPath: '/tmp/crm.yaml',
      junitReportDir: reportDir,
      javaAvailable: () => true,
    });
    expect(result.process.stdout).toBe('stdout remains unchanged\n');
    expect(result.process.stderr).toBe('stderr remains unchanged\n');
  });

  it('retains a deterministic tail when child-process diagnostics exceed the bound', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-conformance-output-'));
    const jarPath = path.join(root, 'specmatic.jar');
    const reportDir = path.join(root, 'report');
    await fs.writeFile(jarPath, 'test jar');
    await fs.mkdir(reportDir);
    await fs.writeFile(path.join(reportDir, 'results.xml'), '<testsuite tests="1" />');

    const child = createFakeChild();
    mockSpawn.mockReturnValue(child);
    const retainedBytes = 64 * 1024;
    const stdoutTail = 'stdout-tail\n';
    const stderrTail = 'stderr-tail\n';
    const stdoutInput = `${'stdout-prefix\n'}${'x'.repeat(retainedBytes)}${stdoutTail}`;
    const stderrInput = `${'stderr-prefix\n'}${'y'.repeat(retainedBytes)}${stderrTail}`;
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(stdoutInput));
        child.stderr.emit('data', Buffer.from(stderrInput));
        child.emit('close', 1, null);
      });
      return child;
    });

    const result = await runSpecmaticTest({
      jarPath,
      testBaseUrl: 'http://127.0.0.1:4321',
      contractPath: '/tmp/crm.yaml',
      junitReportDir: reportDir,
      javaAvailable: () => true,
    });
    expect(result.process.stdout).toBe(
      `[stdout truncated; retaining the last ${retainedBytes} bytes]\n${stdoutInput.slice(-retainedBytes)}`,
    );
    expect(result.process.stderr).toBe(
      `[stderr truncated; retaining the last ${retainedBytes} bytes]\n${stderrInput.slice(-retainedBytes)}`,
    );
  });

  it('rejects a blank filter and an invalid direct combination cap', async () => {
    const base = {
      jarPath: '/tmp/specmatic.jar',
      testBaseUrl: 'http://127.0.0.1:4321',
      contractPath: '/tmp/crm.yaml',
      junitReportDir: '/tmp/missing-report',
      javaAvailable: () => true,
    };
    await expect(runSpecmaticTest({ ...base, filter: '   ' })).rejects.toThrow(
      'Specmatic filter must be a non-empty expression',
    );
    await expect(runSpecmaticTest({ ...base, maxTestRequestCombinations: 0 })).rejects.toThrow(
      'maxTestRequestCombinations must be a positive safe integer',
    );
  });
});
