/**
 * Tests for src/http/bindHost.ts (REQ-WIRE-004).
 */

import { resolveBindHost } from '../../../src/http/bindHost.js';
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

describe('resolveBindHost — default (REQ-WIRE-004 AC-004.2)', () => {
  it('returns 127.0.0.1 when the env has no override', () => {
    expect(resolveBindHost('dsl', { env: {} })).toBe('127.0.0.1');
    expect(resolveBindHost('state', { env: {} })).toBe('127.0.0.1');
  });

  it('returns 127.0.0.1 even when override equals 127.0.0.1', () => {
    expect(
      resolveBindHost('dsl', { env: { POTEMKIN_DSL_BIND_HOST: '127.0.0.1' } }),
    ).toBe('127.0.0.1');
  });
});

describe('resolveBindHost — override requires allow-remote (REQ-WIRE-004 AC-004.1)', () => {
  it('refuses POTEMKIN_DSL_BIND_HOST without POTEMKIN_ALLOW_REMOTE_DSL=1', () => {
    expectBootCode(
      () => resolveBindHost('dsl', { env: { POTEMKIN_DSL_BIND_HOST: '0.0.0.0' } }),
      'BOOT_ERR_REMOTE_DSL_NOT_ALLOWED',
    );
  });

  it('allows POTEMKIN_DSL_BIND_HOST when POTEMKIN_ALLOW_REMOTE_DSL=1', () => {
    expect(
      resolveBindHost('dsl', {
        env: { POTEMKIN_DSL_BIND_HOST: '0.0.0.0', POTEMKIN_ALLOW_REMOTE_DSL: '1' },
      }),
    ).toBe('0.0.0.0');
  });

  it('refuses POTEMKIN_STATE_BIND_HOST without POTEMKIN_ALLOW_REMOTE_STATE=1 (AC-004.4)', () => {
    expectBootCode(
      () => resolveBindHost('state', { env: { POTEMKIN_STATE_BIND_HOST: '10.0.0.1' } }),
      'BOOT_ERR_REMOTE_STATE_NOT_ALLOWED',
    );
  });
});

describe('resolveBindHost — refuses "localhost" by name (REQ-WIRE-004 AC-004.3)', () => {
  it('refuses POTEMKIN_DSL_BIND_HOST=localhost even with allow-remote=1', () => {
    expectBootCode(
      () =>
        resolveBindHost('dsl', {
          env: { POTEMKIN_DSL_BIND_HOST: 'localhost', POTEMKIN_ALLOW_REMOTE_DSL: '1' },
        }),
      'BOOT_ERR_REMOTE_DSL_NOT_ALLOWED',
    );
  });
});
