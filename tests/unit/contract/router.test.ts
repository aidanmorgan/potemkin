import { matchRoute } from '../../../src/contract/router';
import type { OpenApiDoc } from '../../../src/contract/loader';

function makeDoc(paths: Record<string, Record<string, object>>): OpenApiDoc {
  return {
    raw: {},
    paths: paths as OpenApiDoc['paths'],
  };
}

describe('contract/router', () => {
  describe('matchRoute', () => {
    it('matches a simple path', () => {
      const doc = makeDoc({
        '/loans': { get: { operationId: 'listLoans' } },
      });
      const result = matchRoute(doc, 'GET', '/loans');
      expect(result).not.toBeNull();
      expect(result?.contractPath).toBe('/loans');
    });

    it('returns null for unmatched path', () => {
      const doc = makeDoc({
        '/loans': { get: {} },
      });
      const result = matchRoute(doc, 'GET', '/accounts');
      expect(result).toBeNull();
    });

    it('returns null for unmatched method', () => {
      const doc = makeDoc({
        '/loans': { get: {} },
      });
      const result = matchRoute(doc, 'POST', '/loans');
      expect(result).toBeNull();
    });

    it('extracts path parameters', () => {
      const doc = makeDoc({
        '/loans/{id}': { get: {} },
      });
      const result = matchRoute(doc, 'GET', '/loans/abc-123');
      expect(result).not.toBeNull();
      expect(result?.pathParams).toEqual({ id: 'abc-123' });
    });

    it('extracts multiple path parameters', () => {
      const doc = makeDoc({
        '/loans/{id}/items/{itemId}': { get: {} },
      });
      const result = matchRoute(doc, 'GET', '/loans/loan1/items/item2');
      expect(result).not.toBeNull();
      expect(result?.pathParams).toEqual({ id: 'loan1', itemId: 'item2' });
    });

    it('is case-insensitive for HTTP method', () => {
      const doc = makeDoc({
        '/loans': { get: {} },
      });
      expect(matchRoute(doc, 'get', '/loans')).not.toBeNull();
      expect(matchRoute(doc, 'GET', '/loans')).not.toBeNull();
    });

    it('more-specific static path wins over parameterized path', () => {
      const doc = makeDoc({
        '/loans/{id}': { get: { operationId: 'getLoan' } },
        '/loans/active': { get: { operationId: 'getActive' } },
      });
      const result = matchRoute(doc, 'GET', '/loans/active');
      expect(result?.operation.operationId).toBe('getActive');
    });

    it('falls back to parameterized path when static does not match', () => {
      const doc = makeDoc({
        '/loans/{id}': { get: { operationId: 'getLoan' } },
        '/loans/active': { get: { operationId: 'getActive' } },
      });
      const result = matchRoute(doc, 'GET', '/loans/other-id');
      expect(result?.operation.operationId).toBe('getLoan');
    });

    it('returns the operation from the matched route', () => {
      const doc = makeDoc({
        '/loans': { post: { operationId: 'createLoan' } },
      });
      const result = matchRoute(doc, 'POST', '/loans');
      expect(result?.operation.operationId).toBe('createLoan');
    });

    it('handles empty path params when no template params', () => {
      const doc = makeDoc({
        '/loans': { get: {} },
      });
      const result = matchRoute(doc, 'GET', '/loans');
      expect(result?.pathParams).toEqual({});
    });

    it('returns null when doc has no paths', () => {
      const doc = makeDoc({});
      expect(matchRoute(doc, 'GET', '/loans')).toBeNull();
    });

    it('decodes a percent-encoded path parameter (a%20b resolves to "a b")', () => {
      const doc = makeDoc({
        '/customers/{id}': { get: {} },
      });
      const result = matchRoute(doc, 'GET', '/customers/a%20b');
      expect(result).not.toBeNull();
      expect(result?.pathParams).toEqual({ id: 'a b' });
    });

    it('decodes multiple percent-encoded path parameters', () => {
      const doc = makeDoc({
        '/customers/{id}/orders/{orderId}': { get: {} },
      });
      const result = matchRoute(doc, 'GET', '/customers/a%20b/orders/order%2F1');
      expect(result).not.toBeNull();
      expect(result?.pathParams).toEqual({ id: 'a b', orderId: 'order/1' });
    });

    it('falls back to the raw value when a path parameter contains a malformed percent-sequence (%ZZ)', () => {
      const doc = makeDoc({
        '/customers/{id}': { get: {} },
      });
      const result = matchRoute(doc, 'GET', '/customers/a%ZZb');
      expect(result).not.toBeNull();
      expect(result?.pathParams).toEqual({ id: 'a%ZZb' });
    });

    it('does not throw for a malformed percent-sequence — falls back gracefully', () => {
      const doc = makeDoc({
        '/items/{id}': { get: {} },
      });
      expect(() => matchRoute(doc, 'GET', '/items/%zz')).not.toThrow();
      const result = matchRoute(doc, 'GET', '/items/%zz');
      expect(result?.pathParams).toEqual({ id: '%zz' });
    });

    it('plain UUIDs (no percent-encoding) are unaffected by the decode step', () => {
      const doc = makeDoc({
        '/loans/{id}': { get: {} },
      });
      const uuid = '01234567-89ab-cdef-0123-456789abcdef';
      const result = matchRoute(doc, 'GET', `/loans/${uuid}`);
      expect(result).not.toBeNull();
      expect(result?.pathParams).toEqual({ id: uuid });
    });
  });
});
