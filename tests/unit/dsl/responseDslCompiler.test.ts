/**
 * Tests for src/dsl/responseDslCompiler.ts (REQ-RESP-001/002/003/004).
 */

import {
  compileResponseHateoas,
  compileResponseDeprecation,
  compileResponseMask,
  compileResponseDsl,
} from '../../../src/dsl/responseDslCompiler.js';
import { applyPatches } from '../../../src/dsl/patches.js';

describe('compileResponseHateoas (REQ-RESP-001)', () => {
  it('emits a merge against /_links carrying every rel', () => {
    const patches = compileResponseHateoas([
      { rel: 'self', href: '/leads/1' },
      { rel: 'next', href: '/leads/1/next' },
    ]);
    expect(patches.length).toBe(1);
    expect(patches[0]).toMatchObject({
      op: 'merge',
      path: '/_links',
      value: {
        self: { href: '/leads/1' },
        next: { href: '/leads/1/next' },
      },
    });
  });

  it('returns [] when there are no entries', () => {
    expect(compileResponseHateoas([])).toEqual([]);
  });

  it('when applied via applyPatches, body._links carries the rels', () => {
    const patches = compileResponseHateoas([{ rel: 'self', href: '/x' }]);
    const { newState } = applyPatches({ _links: {} }, patches, 'hateoas');
    expect(newState).toEqual({ _links: { self: { href: '/x' } } });
  });
});

describe('compileResponseDeprecation (REQ-RESP-002)', () => {
  it('emits a Deprecation: true header patch when only deprecation is configured', () => {
    const patches = compileResponseDeprecation({});
    expect(patches).toContainEqual({
      op: 'add',
      path: '/headers/Deprecation',
      value: 'true',
    });
  });

  it('emits Sunset header when sunset is provided', () => {
    const patches = compileResponseDeprecation({ sunset: '2026-12-31' });
    expect(patches).toContainEqual({
      op: 'add',
      path: '/headers/Sunset',
      value: new Date('2026-12-31').toUTCString(),
    });
  });

  it('emits Link successor-version when replacement is set', () => {
    const patches = compileResponseDeprecation({ replacement: '/v2/leads' });
    expect(patches).toContainEqual({
      op: 'add',
      path: '/headers/Link',
      value: '</v2/leads>; rel="successor-version"',
    });
  });

  it('emits no patches when input is undefined', () => {
    expect(compileResponseDeprecation(undefined)).toEqual([]);
  });

  it('emits Deprecation: <HTTP-date> when a real date is configured', () => {
    const patches = compileResponseDeprecation({ date: '2025-01-01T00:00:00.000Z' });
    const dep = patches.find((p) => p.path === '/headers/Deprecation') as any;
    expect(dep).toBeDefined();
    expect(dep.value).toBe(new Date('2025-01-01T00:00:00.000Z').toUTCString());
    expect(dep.value).not.toBe('true');
  });

  it('still emits Deprecation: true when date is the epoch sentinel', () => {
    const epochIso = new Date(0).toISOString();
    const patches = compileResponseDeprecation({ date: epochIso });
    const dep = patches.find((p) => p.path === '/headers/Deprecation') as any;
    expect(dep).toBeDefined();
    expect(dep.value).toBe('true');
  });

  it('falls back to the raw string (not "Invalid Date") when date is unparseable', () => {
    const patches = compileResponseDeprecation({ date: 'soon' });
    const dep = patches.find((p) => p.path === '/headers/Deprecation') as any;
    expect(dep).toBeDefined();
    expect(dep.value).toBe('soon');
    expect(dep.value).not.toBe('Invalid Date');
  });

  it('emits HTTP-date Deprecation alongside sunset and successor Link', () => {
    const patches = compileResponseDeprecation({
      date: '2025-06-01T00:00:00.000Z',
      sunset: '2025-12-31',
      replacement: '/v2/leads',
    });
    const dep = patches.find((p) => p.path === '/headers/Deprecation') as any;
    const sunset = patches.find((p) => p.path === '/headers/Sunset') as any;
    const link = patches.find((p) => p.path === '/headers/Link') as any;
    expect(dep.value).toBe(new Date('2025-06-01T00:00:00.000Z').toUTCString());
    expect(sunset.value).toBe(new Date('2025-12-31').toUTCString());
    expect(String(link.value)).toContain('rel="successor-version"');
  });
});

describe('compileResponseMask', () => {
  it('emits a remove patch per field', () => {
    expect(compileResponseMask(['ssn', 'dob'])).toEqual([
      { op: 'remove', path: '/ssn' },
      { op: 'remove', path: '/dob' },
    ]);
  });

  it('preserves explicit RFC 6901 paths', () => {
    expect(compileResponseMask(['/customer/ssn'])).toEqual([
      { op: 'remove', path: '/customer/ssn' },
    ]);
  });

  it('returns [] when fields is empty', () => {
    expect(compileResponseMask([])).toEqual([]);
  });

  it('when applied, the masked fields disappear from the body', () => {
    const patches = compileResponseMask(['ssn']);
    const { newState } = applyPatches({ id: 'a', ssn: '123' }, patches, 'mask');
    expect(newState).toEqual({ id: 'a' });
  });
});

describe('compileResponseDsl — bundles all three categories (REQ-RESP-004)', () => {
  it('returns separate batches for hateoas / deprecation / mask', () => {
    const out = compileResponseDsl({
      hateoas: [{ rel: 'self', href: '/x' }],
      deprecation: { sunset: '2026-12-31' },
      mask: ['ssn'],
    });
    expect(out.hateoas.length).toBe(1);
    expect(out.deprecation.length).toBe(2); // Deprecation + Sunset
    expect(out.mask.length).toBe(1);
  });

  it('empty input produces all-empty batches', () => {
    const out = compileResponseDsl({});
    expect(out.hateoas).toEqual([]);
    expect(out.deprecation).toEqual([]);
    expect(out.mask).toEqual([]);
  });
});
