import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RuntimeSystem } from '../../../src/runtime/system';
import {
  parseExportedCorpusExample,
  seedRuntimeFromExportedExamples,
} from '../../../src/conformance/exportedCorpus';

describe('exported conformance corpus parsing', () => {
  it('returns a typed example after validating the JSON boundary', () => {
    const example = parseExportedCorpusExample({
      'http-request': { method: 'get', path: '/leads/(id:uuid)' },
      'http-response': { status: 200, body: { id: 'lead-1' } },
    });

    expect(example).toEqual({
      request: { method: 'GET', path: '/leads/(id:uuid)' },
      response: { status: 200, body: { id: 'lead-1' } },
    });
  });

  it('accepts extension methods but rejects malformed external records', () => {
    expect(
      parseExportedCorpusExample({
        'http-request': { method: 'REPORT', path: '/health' },
        'http-response': { status: 207, body: null },
      }),
    ).toEqual({
      request: { method: 'REPORT', path: '/health' },
      response: { status: 207, body: null },
    });
    expect(parseExportedCorpusExample({ 'http-request': { method: 'GET' } })).toBeUndefined();
    expect(
      parseExportedCorpusExample({
        'http-request': { method: 'GET', path: '/health' },
        'http-response': { status: 99, body: {} },
      }),
    ).toBeUndefined();
  });

  describe('directory loading', () => {
    let directory: string;

    beforeEach(() => {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'potemkin-exported-corpus-'));
    });

    afterEach(() => {
      fs.rmSync(directory, { recursive: true, force: true });
    });

    it('reports invalid JSON with the source filename', () => {
      const source = path.join(directory, 'broken.json');
      fs.writeFileSync(source, '{"http-request":', 'utf8');

      expect(() =>
        seedRuntimeFromExportedExamples({} as unknown as RuntimeSystem, directory),
      ).toThrow(`Invalid exported corpus JSON in ${source}`);
    });

    it('reports malformed examples with the source filename', () => {
      const source = path.join(directory, 'malformed.json');
      fs.writeFileSync(
        source,
        JSON.stringify({ 'http-request': { method: 'GET', path: '/health' } }),
        'utf8',
      );

      expect(() =>
        seedRuntimeFromExportedExamples({} as unknown as RuntimeSystem, directory),
      ).toThrow(`Malformed exported corpus example in ${source}`);
    });
  });
});
