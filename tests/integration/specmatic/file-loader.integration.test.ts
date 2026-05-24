/**
 * file-loader.integration.test.ts
 *
 * Tests the loadExpectationsFromDirectory function and file-sourced stubs
 * pre-populated in the expectation store at boot time.
 */

import * as path from 'path';
import request from 'supertest';
import type { BootedSystem } from '../../../src/engine/boot.js';
import { bootSystem } from '../../../src/engine/boot.js';
import { createGateway } from '../../../src/http/gateway.js';
import { loadBankingFixture } from '../_helpers/inline-fixture.js';
import { loadExpectationsFromDirectory } from '../../../src/specmatic/loader.js';

// The stub fixtures live at tests/fixtures/specmatic-stubs/
const STUB_DIR = path.resolve(__dirname, '../../fixtures/specmatic-stubs');

describe('file-loader.integration', () => {
  describe('loadExpectationsFromDirectory', () => {
    it('returns 3 expectations from the fixture directory (recursive)', async () => {
      const entries = await loadExpectationsFromDirectory(STUB_DIR);
      expect(entries.length).toBe(3);
    });

    it('each entry has request with method and path', async () => {
      const entries = await loadExpectationsFromDirectory(STUB_DIR);
      for (const entry of entries) {
        expect(typeof entry.request.method).toBe('string');
        expect(typeof entry.request.path).toBe('string');
      }
    });

    it('each entry has response with numeric status', async () => {
      const entries = await loadExpectationsFromDirectory(STUB_DIR);
      for (const entry of entries) {
        expect(typeof entry.response.status).toBe('number');
      }
    });

    it('includes the customer-001.json stub for GET /customers/seed-1', async () => {
      const entries = await loadExpectationsFromDirectory(STUB_DIR);
      const customer = entries.find(
        (e) => e.request.path === '/customers/seed-1' && e.request.method === 'GET',
      );
      expect(customer).toBeDefined();
      expect((customer!.response.body as Record<string, unknown>)['id']).toBe('seed-1');
    });

    it('includes the loan-list.json stub for GET /loans with query', async () => {
      const entries = await loadExpectationsFromDirectory(STUB_DIR);
      const loan = entries.find(
        (e) => e.request.path === '/loans' && e.request.method === 'GET',
      );
      expect(loan).toBeDefined();
      expect(loan!.request.queryParameters).toEqual({ status: 'ACTIVE' });
    });

    it('includes the nested subdir stub for GET /customers/seed-nested', async () => {
      const entries = await loadExpectationsFromDirectory(STUB_DIR);
      const nested = entries.find(
        (e) => e.request.path === '/customers/seed-nested',
      );
      expect(nested).toBeDefined();
      expect((nested!.response.body as Record<string, unknown>)['name']).toBe('Nested Stub Customer');
    });

    it('returns empty array for a non-existent directory (no throw)', async () => {
      const entries = await loadExpectationsFromDirectory('/no/such/dir/at/all');
      expect(entries).toEqual([]);
    });

    it('filePath field is set to the absolute path of each loaded file', async () => {
      const entries = await loadExpectationsFromDirectory(STUB_DIR);
      for (const entry of entries) {
        expect(path.isAbsolute(entry.filePath)).toBe(true);
        expect(entry.filePath.endsWith('.json')).toBe(true);
      }
    });
  });

  describe('file-sourced stubs via specmaticStubDir at boot', () => {
    let agent: ReturnType<typeof request>;
    let sys: BootedSystem;

    beforeEach(async () => {
      const fixture = await loadBankingFixture();
      sys = await bootSystem({ ...fixture, specmaticStubDir: STUB_DIR });
      const app = createGateway(sys);
      agent = request(app);
    });

    it('boot pre-populates 3 file-sourced expectations in the store', () => {
      const fileStubs = sys.expectations.list().filter((e) => e.source === 'file');
      expect(fileStubs.length).toBe(3);
    });

    it('GET /customers/seed-1 returns the file-sourced stub response', async () => {
      const res = await agent.get('/customers/seed-1').expect(200);
      expect(res.body.id).toBe('seed-1');
      expect(res.body.name).toBe('Seed Customer One');
    });

    it('GET /customers/seed-nested returns the nested subdir stub', async () => {
      const res = await agent.get('/customers/seed-nested').expect(200);
      expect(res.body.id).toBe('seed-nested');
      expect(res.body.name).toBe('Nested Stub Customer');
    });

    it('DELETE /_specmatic/expectations clears ALL expectations (including file-source)', async () => {
      // Verify file stubs active before
      await agent.get('/customers/seed-1').expect(200);

      // Clear all
      await agent.delete('/_specmatic/expectations').expect(200);

      // File stubs are gone — entity does not exist in CQRS → 404
      await agent.get('/customers/seed-1').expect(404);

      expect(sys.expectations.size()).toBe(0);
    });
  });
});
