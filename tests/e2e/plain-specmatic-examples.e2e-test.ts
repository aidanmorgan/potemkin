/**
 * Proves that the exported corpus is independently consumable by Specmatic.
 * No Potemkin engine and no Potemkin plugin are present in this test.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureSpecmaticJar } from '../../src/conformance/binaries.js';
import { startPlainSpecmatic, type PlainSpecmaticHandle } from './_harness/plain-specmatic-driver';

interface ExportedExample {
  readonly [key: string]: unknown;
  'http-request': {
    readonly method: string;
    readonly path: string;
    readonly headers?: Record<string, string>;
    readonly body?: unknown;
  };
  'http-response': {
    readonly status: number;
    readonly body: unknown;
  };
}
function readExamples(examplesDir: string): readonly ExportedExample[] {
  return fs
    .readdirSync(examplesDir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map(
      (file) =>
        JSON.parse(fs.readFileSync(path.join(examplesDir, file), 'utf8')) as ExportedExample,
    );
}

async function assertExamplesAreServed(
  handle: PlainSpecmaticHandle,
  examples: readonly ExportedExample[],
): Promise<void> {
  for (const example of examples) {
    const request = example['http-request'];
    const expected = example['http-response'];
    const headers: Record<string, string> = {};
    if (request.headers !== undefined) Object.assign(headers, request.headers);
    const body = request.body === undefined ? undefined : JSON.stringify(request.body);
    if (body !== undefined && headers['content-type'] === undefined)
      headers['content-type'] = 'application/json';
    const response = await fetch(`${handle.url}${request.path}`, {
      method: request.method,
      headers,
      body,
    });
    expect(response.status).toBe(expected.status);
    await expect(response.json()).resolves.toEqual(expected.body);
  }
}

const CORPORA = [
  {
    name: 'CRM',
    contractPath: path.resolve('examples/crm/openapi/nuisance-bureau.yaml'),
    examplesDir: path.resolve('examples/crm/openapi/nuisance-bureau_examples'),
  },
  {
    name: 'Stripe',
    // Specmatic 2.46.2 refuses to parse the 7.4 MB official Stripe contract
    // before it can load examples. This compact route-complete contract is
    // test infrastructure for the plain-stub boundary; the corpus itself is
    // still exported and contract-validated against the official document.
    contractPath: path.resolve('tests/fixtures/exported-corpus/stripe-export.yaml'),
    examplesDir: path.resolve('examples/stripe/openapi/stripe-official_examples'),
  },
] as const;

describe.each(CORPORA)('plain Specmatic $name exported corpus', (corpus) => {
  let handle: PlainSpecmaticHandle;
  let examples: readonly ExportedExample[];

  beforeAll(async () => {
    const specmaticJar = await ensureSpecmaticJar();
    examples = readExamples(corpus.examplesDir);
    expect(examples.length).toBeGreaterThan(0);
    handle = await startPlainSpecmatic({
      specmaticJar,
      contractPath: corpus.contractPath,
      examplesDir: corpus.examplesDir,
    });
    await handle.ready();
  }, 180_000);

  afterAll(async () => {
    await handle?.shutdown();
  }, 30_000);

  it('starts without the Potemkin plugin or engine', () => {
    expect(handle.launchArgs).toEqual([
      '-Xmx512m',
      '-XX:+UseSerialGC',
      '-jar',
      expect.stringContaining('specmatic-'),
      'stub',
      '--port',
      String(handle.stubPort),
      '--data',
      corpus.examplesDir,
      corpus.contractPath,
    ]);
    expect(handle.launchArgs).not.toContain(expect.stringContaining('potemkin-stateful-plugin'));
  });

  it('serves every exported example with the exact status and body', async () => {
    expect(examples.some((example) => example['http-request'].path.includes('/'))).toBe(true);
    if (corpus.name === 'CRM') {
      expect(examples.some((example) => example['http-response'].status === 404)).toBe(true);
      expect(examples.some((example) => example['http-response'].status === 422)).toBe(true);
      expect(
        examples
          .filter((example) => example['http-response'].status === 422)
          .every((example) => example['http-request'].body !== undefined),
      ).toBe(true);
    }
    await assertExamplesAreServed(handle, examples);
  }, 120_000);
});
