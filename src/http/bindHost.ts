// Returns the IP string to pass to server.listen(port, host). Defaults to
// the literal 127.0.0.1. Off-interface listening requires both the
// BIND_HOST env and the matching ALLOW_REMOTE flag; 'localhost' by name is
// rejected so the listen address is always a literal IP.

import { BootError } from '../errors.js';

export type BindSurface = 'dsl' | 'state';

export interface ResolveBindHostOptions {
  // Env override (defaults to process.env). Injected for tests.
  readonly env?: NodeJS.ProcessEnv;
}

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
  if (override.toLowerCase() === 'localhost') {
    throw new BootError(
      errorCode,
      `${overrideKey}=localhost is not a literal IP; use 127.0.0.1 or an explicit interface address`,
      { overrideKey, allowKey, surface, value: override },
    );
  }
  return override;
}
