import { assertNoRemovedReducerKeys, assertNoInlineScripts, REMOVED_REDUCER_KEYS } from '../../../src/dsl/removedSyntax';
import { validateBoundaryConfig } from '../../../src/dsl/schema';
import { BootError } from '../../../src/errors';

describe('removedSyntax — single reducer-mutation key policy (A3)', () => {
  it('lists assign, append and assignAll as removed', () => {
    expect([...REMOVED_REDUCER_KEYS].sort()).toEqual(['append', 'assign', 'assignAll']);
  });

  it.each(['assign', 'append', 'assignAll'])(
    'throws BOOT_ERR_REMOVED_SYNTAX when a reducer carries %s',
    (key) => {
      try {
        assertNoRemovedReducerKeys({ on: 'Ev', [key]: {} }, 'reducers[0]');
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(BootError);
        expect((e as BootError).code).toBe('BOOT_ERR_REMOVED_SYNTAX');
      }
    },
  );

  it('accepts a reducer that carries only patches', () => {
    expect(() =>
      assertNoRemovedReducerKeys({ on: 'Ev', patches: [] }, 'reducers[0]'),
    ).not.toThrow();
  });

  it('validateBoundaryConfig rejects the removed keys', () => {
    const raw = {
      boundary: 'B',
      contract_path: '/b',
      behaviors: [],
      reducers: [{ on: 'Ev', assign: { field: '"v"' } }],
      event_catalog: [{ type: 'Ev', payload_template: {} }],
    };
    let code: string | undefined;
    try {
      validateBoundaryConfig(raw);
    } catch (e) {
      code = (e as BootError).code;
    }
    expect(code).toBe('BOOT_ERR_REMOVED_SYNTAX');
  });


});

describe('removedSyntax — inline scripts removal (B3)', () => {
  it('assertNoInlineScripts throws BOOT_ERR_REMOVED_SYNTAX when scripts: key is present', () => {
    let caught: BootError | undefined;
    try {
      assertNoInlineScripts({ scripts: [{ name: 'foo', code: 'export default fn() {}' }] }, 'root');
    } catch (e) {
      caught = e as BootError;
    }
    expect(caught).toBeInstanceOf(BootError);
    expect(caught!.code).toBe('BOOT_ERR_REMOVED_SYNTAX');
  });

  it('assertNoInlineScripts message names @Script as the replacement', () => {
    let caught: BootError | undefined;
    try {
      assertNoInlineScripts({ scripts: [] }, 'root');
    } catch (e) {
      caught = e as BootError;
    }
    expect(caught).toBeInstanceOf(BootError);
    expect(caught!.message).toContain('@Script');
  });

  it('assertNoInlineScripts message names ts:<id> as the sentinel form', () => {
    let caught: BootError | undefined;
    try {
      assertNoInlineScripts({ scripts: [{ name: 'foo', code: 'return 1' }] }, 'root');
    } catch (e) {
      caught = e as BootError;
    }
    expect(caught).toBeInstanceOf(BootError);
    expect(caught!.message).toContain('ts:<id>');
  });

  it('assertNoInlineScripts does not throw when scripts: key is absent', () => {
    expect(() => assertNoInlineScripts({ boundary: 'B', contract_path: '/b' }, 'root')).not.toThrow();
  });

  it('validateBoundaryConfig rejects a boundary containing scripts: with BOOT_ERR_REMOVED_SYNTAX', () => {
    const raw = {
      boundary: 'B',
      contract_path: '/b',
      behaviors: [],
      reducers: [],
      event_catalog: [],
      scripts: [{ name: 'fn', code: 'export default function() {}' }],
    };
    let code: string | undefined;
    try {
      validateBoundaryConfig(raw);
    } catch (e) {
      code = (e as BootError).code;
    }
    expect(code).toBe('BOOT_ERR_REMOVED_SYNTAX');
  });
});
