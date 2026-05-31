/**
 * Unit tests for the forwarding response-pipeline helpers (pure functions).
 * Each block isolates one concern shared with the gateway so a regression in the
 * helper is caught without booting the full engine.
 */

import {
  resolveBoundaryLatencyMs,
  shouldReturnNotModified,
  lastModifiedFromBody,
  isSingleEntityBody,
  applyDebugEnvelope,
  lowercaseHeaders,
  splitBoundaryFaults,
  corsPreflightHeaders,
} from '../../../src/forwarding/responsePipeline.js';
import type { FaultRule } from '../../../src/dsl/types.js';

describe('responsePipeline helpers', () => {
  describe('resolveBoundaryLatencyMs', () => {
    it('returns 0 when no latency is configured', () => {
      expect(resolveBoundaryLatencyMs(undefined)).toBe(0);
      expect(resolveBoundaryLatencyMs({})).toBe(0);
    });
    it('returns fixed_ms when set', () => {
      expect(resolveBoundaryLatencyMs({ fixed_ms: 50 })).toBe(50);
    });
    it('samples within [min_ms, max_ms] and adds fixed_ms', () => {
      for (let i = 0; i < 50; i++) {
        const ms = resolveBoundaryLatencyMs({ min_ms: 10, max_ms: 20, fixed_ms: 5 });
        expect(ms).toBeGreaterThanOrEqual(15);
        expect(ms).toBeLessThanOrEqual(25);
      }
    });
  });

  describe('shouldReturnNotModified', () => {
    it('matches If-None-Match ignoring surrounding quotes', () => {
      expect(shouldReturnNotModified({ etag: '"5"', ifNoneMatch: '"5"' })).toBe(true);
      expect(shouldReturnNotModified({ etag: '"5"', ifNoneMatch: '5' })).toBe(true);
      expect(shouldReturnNotModified({ etag: '"5"', ifNoneMatch: '"4"' })).toBe(false);
    });
    it('304s a future If-Modified-Since and ignores a malformed one', () => {
      const lastModified = new Date('2026-01-01T00:00:00Z').toUTCString();
      const future = new Date('2027-01-01T00:00:00Z').toUTCString();
      const past = new Date('2025-01-01T00:00:00Z').toUTCString();
      expect(shouldReturnNotModified({ lastModified, ifModifiedSince: future })).toBe(true);
      expect(shouldReturnNotModified({ lastModified, ifModifiedSince: past })).toBe(false);
      expect(shouldReturnNotModified({ lastModified, ifModifiedSince: 'not-a-date' })).toBe(false);
    });
    it('returns false when no conditional headers are present', () => {
      expect(shouldReturnNotModified({ etag: '"5"' })).toBe(false);
    });
  });

  describe('lastModifiedFromBody', () => {
    it('derives an HTTP-date from updatedAt', () => {
      const iso = '2026-05-30T12:00:00.000Z';
      expect(lastModifiedFromBody({ updatedAt: iso })).toBe(new Date(iso).toUTCString());
    });
    it('returns undefined when updatedAt is absent or unparseable', () => {
      expect(lastModifiedFromBody({})).toBeUndefined();
      expect(lastModifiedFromBody({ updatedAt: 'nope' })).toBeUndefined();
      expect(lastModifiedFromBody([])).toBeUndefined();
      expect(lastModifiedFromBody(null)).toBeUndefined();
    });
  });

  describe('isSingleEntityBody', () => {
    it('is true only for plain objects', () => {
      expect(isSingleEntityBody({ id: 'x' })).toBe(true);
      expect(isSingleEntityBody([])).toBe(false);
      expect(isSingleEntityBody(null)).toBe(false);
      expect(isSingleEntityBody('s')).toBe(false);
    });
  });

  describe('applyDebugEnvelope', () => {
    const ev = {
      eventId: 'e1', type: 'X', aggregateId: 'a1', sequenceVersion: 1,
      timestamp: 't', payload: { a: 1 }, causedBy: null,
    };
    const base = {
      body: { id: 'a1' }, events: [ev], boundary: 'B', intent: 'query' as const,
      targetId: 'a1', dryRun: false, method: 'GET', path: '/x',
    };
    it('is a no-op when neither flag is set', () => {
      expect(applyDebugEnvelope({ ...base, includeEvents: false, echo: false })).toEqual({ id: 'a1' });
    });
    it('attaches _events when includeEvents is set', () => {
      const out = applyDebugEnvelope({ ...base, includeEvents: true, echo: false }) as Record<string, unknown>;
      expect(Array.isArray(out['_events'])).toBe(true);
      expect((out['_events'] as unknown[]).length).toBe(1);
    });
    it('attaches _debug when echo is set', () => {
      const out = applyDebugEnvelope({ ...base, includeEvents: false, echo: true }) as Record<string, unknown>;
      expect((out['_debug'] as { intent: string }).intent).toBe('query');
    });
  });

  describe('lowercaseHeaders', () => {
    it('lowercases every key', () => {
      expect(lowercaseHeaders({ 'If-Match': '"1"', 'X-A': 'b' })).toEqual({ 'if-match': '"1"', 'x-a': 'b' });
    });
  });

  describe('corsPreflightHeaders', () => {
    it('includes the three CORS headers', () => {
      const h = corsPreflightHeaders();
      expect(h['access-control-allow-origin']).toBeDefined();
      expect(h['access-control-allow-methods']).toBeDefined();
      expect(h['access-control-allow-headers']).toBeDefined();
    });
  });

  describe('splitBoundaryFaults', () => {
    const rule = (name: string, boundary?: string): FaultRule => ({
      name,
      match: { condition: 'true', ...(boundary ? { boundary } : {}) },
      response: { status: 500 },
    });
    it('routes boundary-scoped rules to boundary and the rest to global', () => {
      const { boundary, global } = splitBoundaryFaults(
        [rule('a', 'Lead'), rule('b'), rule('c', 'Call')],
        'Lead',
      );
      expect(boundary.map(r => r.name)).toEqual(['a']);
      expect(global.map(r => r.name)).toEqual(['b', 'c']);
    });
    it('handles undefined faults', () => {
      expect(splitBoundaryFaults(undefined, 'Lead')).toEqual({ boundary: [], global: [] });
    });
  });
});
