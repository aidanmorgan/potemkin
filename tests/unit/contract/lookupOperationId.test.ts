import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadOpenApi, lookupOperationId } from '../../../src/contract/loader';

const sampleDoc = {
  openapi: '3.0.0',
  info: { title: 'Test', version: '1.0.0' },
  paths: {
    '/leads': {
      get: { operationId: 'listLeads', responses: {} },
      post: { operationId: 'createLead', responses: {} },
    },
    '/leads/{id}': {
      get: { operationId: 'getLead', responses: {} },
      patch: { operationId: 'patchLead', responses: {} },
    },
    '/leads/{id}/qualify': {
      post: { operationId: 'qualifyLead', responses: {} },
    },
    // Operation with no operationId declared — must be skipped by the index.
    '/health': {
      get: { responses: {} },
    },
  },
};

describe('contract/lookupOperationId', () => {
  it('exports lookupOperationId from loader', () => {
    expect(typeof lookupOperationId).toBe('function');
  });

  it('resolves a collection POST to its operationId', async () => {
    const doc = await loadOpenApi(sampleDoc);
    expect(lookupOperationId(doc, '/leads', 'POST')).toBe('createLead');
  });

  it('resolves a templated sub-path POST to its operationId', async () => {
    const doc = await loadOpenApi(sampleDoc);
    expect(lookupOperationId(doc, '/leads/{id}/qualify', 'POST')).toBe('qualifyLead');
  });

  it('resolves a GET on a collection', async () => {
    const doc = await loadOpenApi(sampleDoc);
    expect(lookupOperationId(doc, '/leads', 'GET')).toBe('listLeads');
  });

  it('resolves a PATCH on a templated path', async () => {
    const doc = await loadOpenApi(sampleDoc);
    expect(lookupOperationId(doc, '/leads/{id}', 'PATCH')).toBe('patchLead');
  });

  it('matches method case-insensitively (lowercase post)', async () => {
    const doc = await loadOpenApi(sampleDoc);
    expect(lookupOperationId(doc, '/leads', 'post')).toBe('createLead');
  });

  it('returns undefined for an unknown method on a known path', async () => {
    const doc = await loadOpenApi(sampleDoc);
    expect(lookupOperationId(doc, '/leads', 'DELETE')).toBeUndefined();
  });

  it('returns undefined for an unknown path', async () => {
    const doc = await loadOpenApi(sampleDoc);
    expect(lookupOperationId(doc, '/nonexistent', 'GET')).toBeUndefined();
  });

  it('returns undefined when the matched operation declares no operationId', async () => {
    const doc = await loadOpenApi(sampleDoc);
    expect(lookupOperationId(doc, '/health', 'GET')).toBeUndefined();
  });

  it('works against a hand-built doc literal without a prebuilt index', () => {
    const literal = {
      raw: {},
      paths: {
        '/leads': { post: { operationId: 'createLead' } },
      },
    };
    expect(lookupOperationId(literal, '/leads', 'POST')).toBe('createLead');
    expect(lookupOperationId(literal, '/leads', 'GET')).toBeUndefined();
  });

  describe('AC-B1.5: all CRM operationIds resolvable', () => {
    it('resolves every operationId declared in the CRM contract', async () => {
      const specPath = path.join(
        __dirname,
        '../../fixtures/crm/openapi/nuisance-bureau.yaml',
      );
      const doc = await loadOpenApi(specPath);

      // Collect every (path, method, operationId) from the loaded paths and
      // assert each is resolvable through lookupOperationId.
      const declared: Array<{ path: string; method: string; operationId: string }> = [];
      for (const [p, item] of Object.entries(doc.paths)) {
        for (const [method, op] of Object.entries(item)) {
          if (op?.operationId) {
            declared.push({ path: p, method, operationId: op.operationId });
          }
        }
      }

      expect(declared.length).toBe(26);
      for (const { path: p, method, operationId } of declared) {
        expect(lookupOperationId(doc, p, method)).toBe(operationId);
      }

      // Spot-check the two canonical examples from the task.
      expect(lookupOperationId(doc, '/leads', 'POST')).toBe('createLead');
      expect(lookupOperationId(doc, '/leads/{id}/qualify', 'POST')).toBe('qualifyLead');
      expect(fs.existsSync(specPath)).toBe(true);
    });
  });
});
