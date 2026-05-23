/**
 * Exhaustive permutation tests for contract/router matchRoute.
 * Targets: src/contract/router.ts (branches ~90% → ≥95%)
 */
import { matchRoute } from '../../../src/contract/router';
import type { OpenApiDoc } from '../../../src/contract/loader';

function makeDoc(): OpenApiDoc {
  return {
    raw: {},
    paths: {
      '/items': {
        get: { operationId: 'listItems' },
        post: { operationId: 'createItem' },
      },
      '/items/{id}': {
        get: { operationId: 'getItem' },
        put: { operationId: 'replaceItem' },
        patch: { operationId: 'updateItem' },
        delete: { operationId: 'deleteItem' },
      },
      '/items/{id}/sub/{subId}': {
        get: { operationId: 'getSubItem' },
        post: { operationId: 'createSubItem' },
      },
      '/items/active': {
        // static path — should win over /items/{id}
        get: { operationId: 'listActiveItems' },
        delete: { operationId: 'deleteAllActive' },
      },
      '/static/path/with/many/segments': {
        get: { operationId: 'deepStatic' },
      },
      '/segments-with-dashes/{xspecial}': {
        get: { operationId: 'dashSegment' },
      },
    },
  };
}

describe('contract/router — permutations', () => {
  const doc = makeDoc();

  // ── Static path matching ──────────────────────────────────────────────────
  describe('static path matching', () => {
    it('GET /items matches', () => {
      const result = matchRoute(doc, 'GET', '/items');
      expect(result?.contractPath).toBe('/items');
      expect(result?.operation).toBeDefined();
    });

    it('POST /items matches', () => {
      const result = matchRoute(doc, 'POST', '/items');
      expect(result?.contractPath).toBe('/items');
      expect(result?.pathParams).toEqual({});
    });

    it('/static/path/with/many/segments matches', () => {
      const result = matchRoute(doc, 'GET', '/static/path/with/many/segments');
      expect(result?.contractPath).toBe('/static/path/with/many/segments');
    });
  });

  // ── Dynamic path param extraction ────────────────────────────────────────
  describe('dynamic path parameters', () => {
    it('GET /items/123 extracts id param', () => {
      const result = matchRoute(doc, 'GET', '/items/123');
      expect(result?.contractPath).toBe('/items/{id}');
      expect(result?.pathParams).toEqual({ id: '123' });
    });

    it('PUT /items/abc extracts id', () => {
      const result = matchRoute(doc, 'PUT', '/items/abc');
      expect(result?.pathParams).toEqual({ id: 'abc' });
    });

    it('PATCH /items/xyz extracts id', () => {
      const result = matchRoute(doc, 'PATCH', '/items/xyz');
      expect(result?.pathParams).toEqual({ id: 'xyz' });
    });

    it('DELETE /items/item-1 extracts id', () => {
      const result = matchRoute(doc, 'DELETE', '/items/item-1');
      expect(result?.pathParams).toEqual({ id: 'item-1' });
    });

    it('nested path /items/123/sub/456 extracts both params', () => {
      const result = matchRoute(doc, 'GET', '/items/123/sub/456');
      expect(result?.contractPath).toBe('/items/{id}/sub/{subId}');
      expect(result?.pathParams).toEqual({ id: '123', subId: '456' });
    });

    it('POST /items/abc/sub/def extracts both params', () => {
      const result = matchRoute(doc, 'POST', '/items/abc/sub/def');
      expect(result?.pathParams).toEqual({ id: 'abc', subId: 'def' });
    });

    it('/segments-with-dashes/my-special-value extracts xspecial param', () => {
      const result = matchRoute(doc, 'GET', '/segments-with-dashes/my-special-value');
      expect(result?.contractPath).toBe('/segments-with-dashes/{xspecial}');
      expect(result?.pathParams['xspecial']).toBe('my-special-value');
    });
  });

  // ── Specificity: static beats dynamic ────────────────────────────────────
  describe('specificity — static beats parameterized', () => {
    it('GET /items/active returns listActiveItems, not getItem', () => {
      const result = matchRoute(doc, 'GET', '/items/active');
      expect(result?.contractPath).toBe('/items/active');
      expect((result?.operation as any).operationId).toBe('listActiveItems');
    });

    it('DELETE /items/active returns deleteAllActive, not deleteItem', () => {
      const result = matchRoute(doc, 'DELETE', '/items/active');
      expect(result?.contractPath).toBe('/items/active');
      expect((result?.operation as any).operationId).toBe('deleteAllActive');
    });
  });

  // ── Method matching ───────────────────────────────────────────────────────
  describe('HTTP method matching', () => {
    it('uppercase GET matches', () => {
      expect(matchRoute(doc, 'GET', '/items')).not.toBeNull();
    });

    it('lowercase get matches (case-insensitive)', () => {
      expect(matchRoute(doc, 'get', '/items')).not.toBeNull();
    });

    it('mixed case Put matches', () => {
      expect(matchRoute(doc, 'Put', '/items/abc')).not.toBeNull();
    });

    it('returns null when method not in path item', () => {
      // /items only has GET and POST, no DELETE
      const result = matchRoute(doc, 'DELETE', '/items');
      expect(result).toBeNull();
    });

    it('returns null for PATCH on /items (no patch defined)', () => {
      const result = matchRoute(doc, 'PATCH', '/items');
      expect(result).toBeNull();
    });
  });

  // ── No-match cases ────────────────────────────────────────────────────────
  describe('no-match cases', () => {
    it('returns null for completely unknown path', () => {
      expect(matchRoute(doc, 'GET', '/unknown')).toBeNull();
    });

    it('returns null for partial path match /items/123/sub (missing subId)', () => {
      expect(matchRoute(doc, 'GET', '/items/123/sub')).toBeNull();
    });

    it('returns null for empty path', () => {
      expect(matchRoute(doc, 'GET', '')).toBeNull();
    });

    it('returns null for root path /', () => {
      expect(matchRoute(doc, 'GET', '/')).toBeNull();
    });

    it('returns null when path has trailing slash not in doc', () => {
      // /items/ should not match /items
      expect(matchRoute(doc, 'GET', '/items/')).toBeNull();
    });

    it('returns null for path with extra segments', () => {
      expect(matchRoute(doc, 'GET', '/items/123/extra')).toBeNull();
    });
  });

  // ── Empty doc ──────────────────────────────────────────────────────────────
  describe('empty OpenAPI document', () => {
    const emptyDoc: OpenApiDoc = { raw: {}, paths: {} };

    it('returns null for any path on empty doc', () => {
      expect(matchRoute(emptyDoc, 'GET', '/items')).toBeNull();
    });
  });

  // ── Deterministic ordering ───────────────────────────────────────────────
  describe('deterministic ordering with multiple candidates', () => {
    const multiDoc: OpenApiDoc = {
      raw: {},
      paths: {
        '/{a}': { get: { operationId: 'root-param' } },
        '/fixed': { get: { operationId: 'root-fixed' } },
        '/fixed/{b}': { get: { operationId: 'fixed-param' } },
        '/fixed/sub': { get: { operationId: 'fixed-sub' } },
      },
    };

    it('static /fixed beats /{a}', () => {
      const result = matchRoute(multiDoc, 'GET', '/fixed');
      expect((result?.operation as any).operationId).toBe('root-fixed');
    });

    it('static /fixed/sub beats /fixed/{b}', () => {
      const result = matchRoute(multiDoc, 'GET', '/fixed/sub');
      expect((result?.operation as any).operationId).toBe('fixed-sub');
    });

    it('/fixed/dynamic-val matches /fixed/{b}', () => {
      const result = matchRoute(multiDoc, 'GET', '/fixed/dynamic-val');
      expect((result?.operation as any).operationId).toBe('fixed-param');
      expect(result?.pathParams).toEqual({ b: 'dynamic-val' });
    });

    it('/anything-else matches /{a}', () => {
      const result = matchRoute(multiDoc, 'GET', '/anything-else');
      expect((result?.operation as any).operationId).toBe('root-param');
      expect(result?.pathParams).toEqual({ a: 'anything-else' });
    });
  });
});
