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
  });
});
