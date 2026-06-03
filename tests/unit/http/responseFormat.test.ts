/**
 * Unit tests for src/http/responseFormat.ts — the Tier-5 response-format and
 * pagination-style body transforms. These assert observable shape changes so
 * they would fail if the transforms were gutted to a passthrough.
 */

import { applyResponseFormat, applyPaginationStyle } from '../../../src/http/responseFormat.js';
import type { JsonValue } from '../../../src/types.js';

const ENVELOPE = {
  items: [{ id: 'a' }, { id: 'b' }],
  totalCount: 5,
  offset: 0,
  limit: 2,
  hasMore: true,
} as unknown as JsonValue;

describe('responseFormat — applyResponseFormat', () => {
  describe('plain', () => {
    it('returns the body untouched', () => {
      const body = { id: 'x', name: 'n' } as unknown as JsonValue;
      expect(applyResponseFormat(body, 'plain', 'Lead', '/leads/x')).toBe(body);
    });
  });

  describe('hal', () => {
    it('adds a self link to a single entity without dropping fields', () => {
      const out = applyResponseFormat({ id: 'x', name: 'n' } as unknown as JsonValue, 'hal', 'Lead', '/leads/x') as Record<string, unknown>;
      expect((out as { name: string }).name).toBe('n');
      expect((out._links as { self: { href: string } }).self.href).toBe('/leads/x');
    });

    it('embeds an array collection under _embedded.items', () => {
      const out = applyResponseFormat([{ id: 'a' }] as unknown as JsonValue, 'hal', 'Lead', '/leads') as Record<string, unknown>;
      expect((out._embedded as { items: unknown[] }).items).toHaveLength(1);
      expect((out._links as { self: { href: string } }).self.href).toBe('/leads');
    });

    it('does not clobber existing _links from HATEOAS', () => {
      const out = applyResponseFormat(
        { id: 'x', _links: { related: { href: '/r' } } } as unknown as JsonValue,
        'hal', 'Lead', '/leads/x',
      ) as Record<string, unknown>;
      const links = out._links as Record<string, { href: string }>;
      expect(links.self.href).toBe('/leads/x');
      expect(links.related.href).toBe('/r');
    });
  });

  describe('jsonapi', () => {
    it('shapes a single entity as { data: { type, id, attributes } } and lifts id', () => {
      const out = applyResponseFormat({ id: 'x', name: 'n' } as unknown as JsonValue, 'jsonapi', 'Lead', '/leads/x') as {
        data: { type: string; id: string; attributes: Record<string, unknown> };
      };
      expect(out.data.type).toBe('Lead');
      expect(out.data.id).toBe('x');
      expect(out.data.attributes.id).toBeUndefined();
      expect(out.data.attributes.name).toBe('n');
    });

    it('shapes an array collection as { data: [...] }', () => {
      const out = applyResponseFormat([{ id: 'a' }, { id: 'b' }] as unknown as JsonValue, 'jsonapi', 'Lead', '/leads') as {
        data: { type: string; id: string }[];
      };
      expect(out.data).toHaveLength(2);
      expect(out.data[0]).toMatchObject({ type: 'Lead', id: 'a' });
    });

    it('carries pagination meta when given an envelope collection', () => {
      const out = applyResponseFormat(ENVELOPE, 'jsonapi', 'Lead', '/leads') as {
        data: unknown[];
        meta: { totalCount: number };
      };
      expect(out.data).toHaveLength(2);
      expect(out.meta.totalCount).toBe(5);
    });
  });
});

describe('responseFormat — applyPaginationStyle', () => {
  it('envelope wraps a bare array', () => {
    const out = applyPaginationStyle([{ id: 'a' }, { id: 'b' }] as unknown as JsonValue, 'envelope', {}, '/leads');
    const body = out.body as { items: unknown[]; totalCount: number };
    expect(body.items).toHaveLength(2);
    expect(body.totalCount).toBe(2);
  });

  it('raw unwraps an envelope to a bare array', () => {
    const out = applyPaginationStyle(ENVELOPE, 'raw', {}, '/leads');
    expect(Array.isArray(out.body)).toBe(true);
    expect((out.body as unknown[]).length).toBe(2);
  });

  it('link-header emits a next Link when more pages exist', () => {
    const out = applyPaginationStyle(ENVELOPE, 'link-header', {}, '/leads');
    expect(Array.isArray(out.body)).toBe(true);
    expect(out.headers['Link']).toContain('offset=2');
    expect(out.headers['Link']).toContain('rel="next"');
    expect(out.headers['X-Total-Count']).toBe('5');
  });

  it('link-header emits a prev Link when not on the first page', () => {
    const env = { items: [{ id: 'c' }], totalCount: 5, offset: 2, limit: 1, hasMore: true } as unknown as JsonValue;
    const out = applyPaginationStyle(env, 'link-header', {}, '/leads');
    expect(out.headers['Link']).toContain('rel="prev"');
    expect(out.headers['Link']).toContain('rel="next"');
  });

  it('leaves a single (non-collection) entity untouched', () => {
    const body = { id: 'x' } as unknown as JsonValue;
    const out = applyPaginationStyle(body, 'envelope', {}, '/leads/x');
    expect(out.body).toBe(body);
  });

  describe('link-header preserves extra query params in next/prev URLs', () => {
    it('includes status and sort params alongside updated offset in next link', () => {
      const env = { items: [{ id: 'a' }, { id: 'b' }], totalCount: 10, offset: 0, limit: 2, hasMore: true } as unknown as JsonValue;
      const out = applyPaginationStyle(env, 'link-header', { status: 'active', sort: 'name', offset: '0', limit: '2' }, '/leads');
      const link = out.headers['Link']!;
      expect(link).toContain('status=active');
      expect(link).toContain('sort=name');
      expect(link).toContain('offset=2');
      expect(link).toContain('limit=2');
      expect(link).toContain('rel="next"');
    });

    it('includes status and sort params in prev link with updated offset', () => {
      const env = { items: [{ id: 'c' }], totalCount: 10, offset: 4, limit: 2, hasMore: true } as unknown as JsonValue;
      const out = applyPaginationStyle(env, 'link-header', { status: 'active', sort: 'name', offset: '4', limit: '2' }, '/leads');
      const link = out.headers['Link']!;
      expect(link).toContain('status=active');
      expect(link).toContain('sort=name');
      // prev offset = max(0, 4 - 2) = 2
      expect(link).toContain('offset=2');
      expect(link).toContain('rel="prev"');
      expect(link).toContain('rel="next"');
    });

    it('drops cursor param from next/prev link URLs', () => {
      const env = { items: [{ id: 'a' }, { id: 'b' }], totalCount: 10, offset: 2, limit: 2, hasMore: true } as unknown as JsonValue;
      const out = applyPaginationStyle(env, 'link-header', { status: 'active', cursor: 'abc123', offset: '2', limit: '2' }, '/leads');
      const link = out.headers['Link']!;
      expect(link).not.toContain('cursor=');
      expect(link).toContain('status=active');
    });

    it('handles array-valued query params by emitting one pair per element', () => {
      const env = { items: [{ id: 'a' }], totalCount: 5, offset: 0, limit: 1, hasMore: true } as unknown as JsonValue;
      const out = applyPaginationStyle(env, 'link-header', { tag: ['foo', 'bar'], offset: '0', limit: '1' }, '/leads');
      const link = out.headers['Link']!;
      expect(link).toContain('tag=foo');
      expect(link).toContain('tag=bar');
    });

    it('empty query (no extra params) still produces correct next URL', () => {
      const out = applyPaginationStyle(ENVELOPE, 'link-header', {}, '/leads');
      const link = out.headers['Link']!;
      expect(link).toContain('offset=2');
      expect(link).toContain('limit=2');
      expect(link).toContain('rel="next"');
    });

    it('URL-encodes special characters in param values', () => {
      const env = { items: [{ id: 'a' }], totalCount: 5, offset: 0, limit: 1, hasMore: true } as unknown as JsonValue;
      const out = applyPaginationStyle(env, 'link-header', { q: 'hello world', offset: '0', limit: '1' }, '/leads');
      const link = out.headers['Link']!;
      // URLSearchParams encodes spaces as '+' (application/x-www-form-urlencoded)
      expect(link).toContain('q=hello+world');
    });
  });
});
