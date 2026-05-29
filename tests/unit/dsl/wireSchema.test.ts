/**
 * Tests for src/dsl/wireSchema.ts (REQ-WIRE-001).
 */

import { validateDslWirePayload } from '../../../src/dsl/wireSchema.js';
import { BootError } from '../../../src/errors.js';

function expectBootCode(fn: () => unknown, code: string): void {
  let caught: BootError | null = null;
  try {
    fn();
  } catch (e) {
    if (e instanceof BootError) caught = e;
  }
  expect(caught?.code).toBe(code);
}

describe('validateDslWirePayload — well-formed inputs', () => {
  it('accepts a minimal valid payload', () => {
    const p = validateDslWirePayload({
      modules: [{ path: 'a.yaml', yaml: 'boundary: A\n' }],
      typescript: null,
      specEndpoints: [{ specId: 'crm-v1', path: '/leads', method: 'POST' }],
    });
    expect(p.modules.length).toBe(1);
    expect(p.specEndpoints[0].method).toBe('POST'); // uppercased
  });

  it('AC-001.2: zero modules is valid (empty DSL)', () => {
    expect(() =>
      validateDslWirePayload({ modules: [], typescript: null, specEndpoints: [] }),
    ).not.toThrow();
  });

  it('AC-001.3: typescript: null skips the TS pipeline', () => {
    const p = validateDslWirePayload({ modules: [], typescript: null, specEndpoints: [] });
    expect(p.typescript).toBeNull();
  });

  it('AC-001.3: typescript object is preserved verbatim', () => {
    const p = validateDslWirePayload({
      modules: [],
      typescript: { scan: [{ include: ['x'] }] },
      specEndpoints: [],
    });
    expect(p.typescript).toEqual({ scan: [{ include: ['x'] }] });
  });

  it('uppercases method on every spec endpoint', () => {
    const p = validateDslWirePayload({
      modules: [],
      typescript: null,
      specEndpoints: [{ specId: 's', path: '/x', method: 'post' }],
    });
    expect(p.specEndpoints[0].method).toBe('POST');
  });
});

describe('validateDslWirePayload — malformed inputs (REQ-WIRE-001 AC-001.1)', () => {
  it('throws BOOT_ERR_MALFORMED_BUNDLE on a non-object payload', () => {
    expectBootCode(
      () => validateDslWirePayload('not an object'),
      'BOOT_ERR_MALFORMED_BUNDLE',
    );
  });

  it('throws BOOT_ERR_MALFORMED_BUNDLE when modules is missing', () => {
    expectBootCode(
      () => validateDslWirePayload({ typescript: null, specEndpoints: [] }),
      'BOOT_ERR_MALFORMED_BUNDLE',
    );
  });

  it('throws BOOT_ERR_MALFORMED_BUNDLE when a module is missing path', () => {
    expectBootCode(
      () =>
        validateDslWirePayload({
          modules: [{ yaml: '' }],
          typescript: null,
          specEndpoints: [],
        }),
      'BOOT_ERR_MALFORMED_BUNDLE',
    );
  });

  it('throws BOOT_ERR_MALFORMED_BUNDLE when typescript is a non-object value', () => {
    expectBootCode(
      () =>
        validateDslWirePayload({
          modules: [],
          typescript: 'invalid',
          specEndpoints: [],
        }),
      'BOOT_ERR_MALFORMED_BUNDLE',
    );
  });

  it('throws BOOT_ERR_MALFORMED_BUNDLE when a specEndpoint is missing method', () => {
    expectBootCode(
      () =>
        validateDslWirePayload({
          modules: [],
          typescript: null,
          specEndpoints: [{ specId: 'x', path: '/y' }],
        }),
      'BOOT_ERR_MALFORMED_BUNDLE',
    );
  });
});
