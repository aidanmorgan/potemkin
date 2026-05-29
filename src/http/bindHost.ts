/**
 * Bind-host resolution (REQ-WIRE-004).
 *
 * Defaults to the literal string `127.0.0.1`. Off-interface listening
 * requires BOTH:
 *   - POTEMKIN_DSL_BIND_HOST=<some value> (or POTEMKIN_STATE_BIND_HOST for
 *     the /_engine/state surface), AND
 *   - POTEMKIN_ALLOW_REMOTE_DSL=1 (or POTEMKIN_ALLOW_REMOTE_STATE=1 for
 *     the state surface).
 *
 * Name resolution is NOT applied — the value used to listen is the literal
 * IP string. Tests assert this against the resolved value.
 */

import { BootError } from '../errors.js';

export type BindSurface = 'dsl' | 'state';

export interface ResolveBindHostOptions {
  /** The env (defaults to `process.env`). Injected for tests. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the bind host for a given surface. Throws
 * BOOT_ERR_REMOTE_DSL_NOT_ALLOWED or BOOT_ERR_REMOTE_STATE_NOT_ALLOWED when
 * the override env is set without the matching allow-remote env.
 *
 * Returns the literal IP string to pass to `server.listen(port, host)`. The
 * returned value is never `localhost` (REQ-WIRE-004 AC-004.3).
 */
export function resolveBindHost(
  surface: BindSurface,
  opts: ResolveBindHostOptions = {},
): string {
  const env = opts.env ?? process.env;
  const overrideKey = surface === 'dsl' ? 'POTEMKIN_DSL_BIND_HOST' : 'POTEMKIN_STATE_BIND_HOST';
  const allowKey = surface === 'dsl' ? 'POTEMKIN_ALLOW_REMOTE_DSL' : 'POTEMKIN_ALLOW_REMOTE_STATE';
  const errorCode =
    surface === 'dsl'
      ? 'BOOT_ERR_REMOTE_DSL_NOT_ALLOWED'
      : 'BOOT_ERR_REMOTE_STATE_NOT_ALLOWED';

  const override = env[overrideKey];
  if (override === undefined || override === '' || override === '127.0.0.1') {
    return '127.0.0.1';
  }
  const allow = env[allowKey];
  if (allow !== '1') {
    throw new BootError(
      errorCode,
      `${overrideKey}=${override} requires ${allowKey}=1`,
      { overrideKey, allowKey, surface },
    );
  }
  // Refuse `localhost` by name (REQ-WIRE-004 AC-004.3 — bind must be a literal IP)
  if (override.toLowerCase() === 'localhost') {
    throw new BootError(
      errorCode,
      `${overrideKey}=localhost is not a literal IP; use 127.0.0.1 or an explicit interface address`,
      { overrideKey, allowKey, surface, value: override },
    );
  }
  return override;
}
