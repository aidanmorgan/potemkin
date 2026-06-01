/**
 * Coverage backfill for contract/loader.ts
 *
 * Uncovered lines:
 *  - 115: normalisePaths early return when rawPaths is null/array/non-object
 *  - 160: loadOpenApi string source → file path branch (parseTarget = source)
 */

import { loadOpenApi } from '../../../src/contract/loader';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('contract/loader.ts additional coverage', () => {

  // ── Line 115: normalisePaths early return for null/array rawPaths ────────────

  describe('normalisePaths with null/array paths (line 115 guard)', () => {
    it('handles OpenAPI document with paths as an empty object', async () => {
      // Valid OpenAPI with explicit empty paths
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Empty Paths', version: '1' },
        paths: {},
      };
      const doc = await loadOpenApi(spec);
      expect(doc.paths).toBeDefined();
      expect(Object.keys(doc.paths)).toHaveLength(0);
    });

    it('returns empty paths when document paths is null (line 115 early return)', async () => {
      // SwaggerParser.dereference passes through paths: null unchanged.
      // Passing an object with paths: null directly → normalisePaths hits the early return at line 115.
      const doc = await loadOpenApi({
        openapi: '3.0.0',
        info: { title: 'Null Paths', version: '1' },
        paths: null,
      } as any);
      // With paths: null, normalisePaths returns {} immediately (line 115)
      expect(doc.paths).toEqual({});
    });

    it('returns empty paths when document paths is an array (line 115)', async () => {
      // SwaggerParser.dereference passes through paths: [] unchanged.
      // Array is not a valid paths object → normalisePaths early return at line 115.
      const doc = await loadOpenApi({
        openapi: '3.0.0',
        info: { title: 'Array Paths', version: '1' },
        paths: [] as any,
      } as any);
      expect(doc.paths).toEqual({});
    });

    it('returns empty paths when document paths is a string (line 115)', async () => {
      // paths as a non-object primitive → normalisePaths early return at line 115.
      const doc = await loadOpenApi({
        openapi: '3.0.0',
        info: { title: 'String Paths', version: '1' },
        paths: 'not-an-object' as any,
      } as any);
      expect(doc.paths).toEqual({});
    });
  });

  // ── Line 160: loadOpenApi string source → file path branch ──────────────────
  // The file-path/URL branch passes the string directly to SwaggerParser.dereference.
  // We use an actual temp file that SwaggerParser can read, exercising the file path branch.

  describe('loadOpenApi string source — file path branch (line 160)', () => {
    it('loads from a real file path string (passes string directly to SwaggerParser)', async () => {

      // Write a minimal valid OpenAPI spec to a temp file
      const tmpDir = os.tmpdir();
      const tmpFile = path.join(tmpDir, `test-spec-${Date.now()}.json`);
      const minimalSpec = JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Temp File Spec', version: '1.0.0' },
        paths: {
          '/test': {
            get: {
              operationId: 'getTest',
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      });

      fs.writeFileSync(tmpFile, minimalSpec, 'utf8');

      try {
        // Passing an absolute file path → hits the file path branch (line 160)
        // where parseTarget = source (the string is passed directly to SwaggerParser.dereference)
        const doc = await loadOpenApi(tmpFile);
        expect(doc.paths).toBeDefined();
        expect(doc.paths['/test']).toBeDefined();
      } finally {
        // Clean up temp file
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      }
    });
  });

  // ── Line 37: normalisePaths with null/non-object rawPaths ────────────────────

  describe('normalisePaths path item guard (line 37/119)', () => {

    it('handles OpenAPI path item with a non-HTTP key gracefully', async () => {
      // normalisePaths only looks at HTTP_METHODS keys; other keys are ignored
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Mixed Keys', version: '1' },
        paths: {
          '/things': {
            get: {
              operationId: 'listThings',
              responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'array' } } } } },
            },
            // 'summary' is a path-level key, not an HTTP method — should be ignored
            summary: 'Things path',
          },
        },
      };
      const doc = await loadOpenApi(spec as any);
      expect(doc.paths['/things']?.['get']).toBeDefined();
      // 'summary' is not an HTTP method so it should not appear
      expect(doc.paths['/things']?.['summary']).toBeUndefined();
    });
  });

  // ── Line 115: operation without parameters ───────────────────────────────────

  describe('operation without parameters (line 115)', () => {
    it('operation with no parameters key gets empty parameters array', async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'No Params', version: '1' },
        paths: {
          '/things': {
            get: {
              operationId: 'listThings',
              responses: {
                '200': {
                  description: 'OK',
                  content: {
                    'application/json': {
                      schema: { type: 'array', items: { type: 'object' } },
                    },
                  },
                },
              },
              // no 'parameters' key at all
            },
          },
        },
      };

      const doc = await loadOpenApi(spec);
      const op = doc.paths['/things']?.['get'];
      expect(op).toBeDefined();
      // parameters should be empty array since no parameters were provided
      expect(op?.parameters).toEqual([]);
    });

    it('operation with null parameters gets empty array', async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Null Params', version: '1' },
        paths: {
          '/things': {
            post: {
              operationId: 'createThing',
              parameters: null,
              requestBody: {
                content: {
                  'application/json': {
                    schema: { type: 'object' },
                  },
                },
              },
              responses: { '201': { description: 'Created' } },
            },
          },
        },
      };

      const doc = await loadOpenApi(spec as any);
      const op = doc.paths['/things']?.['post'];
      expect(op).toBeDefined();
      expect(op?.parameters).toEqual([]);
    });
  });

  // ── Line 160: operation with no response schemas ─────────────────────────────

  describe('operation without response schemas (line 160)', () => {
    it('responseSchemas is undefined when no responses have content', async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'No Schemas', version: '1' },
        paths: {
          '/things': {
            delete: {
              operationId: 'deleteThing',
              responses: {
                '204': {
                  description: 'No Content',
                  // no 'content' key → no responseSchemas
                },
              },
            },
          },
        },
      };

      const doc = await loadOpenApi(spec);
      const op = doc.paths['/things']?.['delete'];
      expect(op).toBeDefined();
      // responseSchemas should be undefined since no content/schema was found
      expect(op?.responseSchemas).toBeUndefined();
    });

    it('responseSchemas is undefined when responses object is empty', async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Empty Responses', version: '1' },
        paths: {
          '/things': {
            get: {
              operationId: 'getThings',
              responses: {},
            },
          },
        },
      };

      const doc = await loadOpenApi(spec);
      const op = doc.paths['/things']?.['get'];
      expect(op?.responseSchemas).toBeUndefined();
    });

    it('ignores response entries with no content key', async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Response No Content', version: '1' },
        paths: {
          '/things': {
            get: {
              operationId: 'getThings',
              responses: {
                '200': {
                  description: 'OK',
                  // has description but no content → should be skipped
                },
                '404': {
                  description: 'Not Found',
                },
              },
            },
          },
        },
      };

      const doc = await loadOpenApi(spec);
      const op = doc.paths['/things']?.['get'];
      // Both responses have no content → responseSchemas = undefined
      expect(op?.responseSchemas).toBeUndefined();
    });
  });

  // ── extractParameters: filters invalid param entries ────────────────────────

  describe('extractParameters with invalid entries', () => {
    it('skips parameters with invalid in value (e.g. cookie)', async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Bad Params', version: '1' },
        paths: {
          '/things/{id}': {
            get: {
              operationId: 'getThing',
              parameters: [
                { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
                { name: 'bad', in: 'cookie', required: false }, // invalid 'in' value → skipped
                { name: 42, in: 'query' }, // non-string name → skipped
                null, // null entry → skipped
              ],
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      const doc = await loadOpenApi(spec as any);
      const op = doc.paths['/things/{id}']?.['get'];
      // Only the valid 'id' parameter should be extracted
      // 'cookie' in value is invalid; non-string name is invalid; null is invalid
      expect(op?.parameters).toHaveLength(1);
      expect(op?.parameters?.[0]?.name).toBe('id');
    });

    it('skips null and array parameter entries', async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Bad Param Entries', version: '1' },
        paths: {
          '/things': {
            get: {
              operationId: 'listThings',
              parameters: [
                null,
                [],
                'string-param',
                { name: 'valid', in: 'query' },
              ],
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      const doc = await loadOpenApi(spec as any);
      const op = doc.paths['/things']?.['get'];
      // Only the valid 'valid' parameter should be extracted
      expect(op?.parameters?.some(p => p.name === 'valid')).toBe(true);
    });
  });

  // ── Line 60: extractOperation returns undefined for null/non-object rawOp ────

  describe('extractOperation with null/non-object rawOp (line 60)', () => {
    it('skips path item keys that are null (line 60 null-rawOp branch)', async () => {
      // When a path has a method key set to null, extractOperation is called with null
      // → line 60: rawOp === null → returns undefined → skipped
      const doc = await loadOpenApi({
        openapi: '3.0.0',
        info: { title: 'Null Op', version: '1' },
        paths: {
          '/things': {
            get: null, // ← extractOperation(null) → returns undefined at line 60
            post: {
              operationId: 'createThing',
              responses: { '201': { description: 'Created' } },
            },
          },
        },
      } as any);
      // null get is skipped, post is extracted
      expect(doc.paths['/things']?.['get']).toBeUndefined();
      expect(doc.paths['/things']?.['post']).toBeDefined();
    });

    it('skips path item keys that are arrays (line 60 array-rawOp branch)', async () => {
      // When a path item method is an array, extractOperation returns undefined
      const doc = await loadOpenApi({
        openapi: '3.0.0',
        info: { title: 'Array Op', version: '1' },
        paths: {
          '/things': {
            get: [], // ← Array.isArray → returns undefined at line 60
          },
        },
      } as any);
      expect(doc.paths['/things']?.['get']).toBeUndefined();
    });
  });

  // ── Line 87: skip null/non-object response entries ───────────────────────────

  describe('extractOperation skips null response entries (line 87)', () => {
    it('skips response entries that are null (line 87 null-resp branch)', async () => {
      // responses['200'] = null → line 87: resp === null → continue
      const doc = await loadOpenApi({
        openapi: '3.0.0',
        info: { title: 'Null Resp', version: '1' },
        paths: {
          '/things': {
            get: {
              operationId: 'getThings',
              responses: {
                '200': null,  // ← null response → line 87 continue
                '404': { description: 'Not Found', content: { 'application/json': { schema: { type: 'object' } } } },
              },
            },
          },
        },
      } as any);
      const op = doc.paths['/things']?.['get'];
      // null response is skipped; 404 has content so it should appear in responseSchemas
      expect(op?.responseSchemas?.['200']).toBeUndefined();
      expect(op?.responseSchemas?.['404']).toBeDefined();
    });
  });

  // ── Line 93: skip null/non-object application/json entries ──────────────────

  describe('extractOperation skips null json content entries (line 93)', () => {
    it('skips response where application/json is null (line 93 null-json branch)', async () => {
      // responses['200'].content['application/json'] = null → line 93: json === null → continue
      const doc = await loadOpenApi({
        openapi: '3.0.0',
        info: { title: 'Null Json', version: '1' },
        paths: {
          '/things': {
            get: {
              operationId: 'getThings',
              responses: {
                '200': {
                  description: 'OK',
                  content: {
                    'application/json': null, // ← null → line 93 continue
                  },
                },
              },
            },
          },
        },
      } as any);
      const op = doc.paths['/things']?.['get'];
      // null application/json is skipped → responseSchemas should be undefined
      expect(op?.responseSchemas).toBeUndefined();
    });
  });

  // ── Line 119: skip null/non-object path items ───────────────────────────────

  describe('normalisePaths skips null path items (line 119)', () => {
    it('skips path items that are null (line 119 null-pathItem branch)', async () => {
      // rawPaths['/null-path'] = null → line 119: rawPathItem === null → continue
      const doc = await loadOpenApi({
        openapi: '3.0.0',
        info: { title: 'Null Path Item', version: '1' },
        paths: {
          '/null-path': null, // ← line 119: continue
          '/valid-path': {
            get: {
              operationId: 'getValid',
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      } as any);
      // null path item is skipped
      expect(doc.paths['/null-path']).toBeUndefined();
      expect(doc.paths['/valid-path']).toBeDefined();
    });

    it('skips path items that are arrays (line 119 array-pathItem branch)', async () => {
      const doc = await loadOpenApi({
        openapi: '3.0.0',
        info: { title: 'Array Path Item', version: '1' },
        paths: {
          '/array-path': [] as any, // ← Array.isArray → line 119: continue
          '/valid-path': {
            get: {
              operationId: 'getValid',
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      } as any);
      expect(doc.paths['/array-path']).toBeUndefined();
      expect(doc.paths['/valid-path']).toBeDefined();
    });
  });
});
