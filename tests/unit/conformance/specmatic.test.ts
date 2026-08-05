import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ConformanceToolUnavailableError,
  runSpecmaticTest,
} from '../../../src/conformance/specmatic';

describe('Specmatic verifier runner', () => {
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
