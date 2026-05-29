// Wire types + validation for the POST /_engine/dsl request body.
// Shared by the HTTP handler and standalone loader callers.

import { BootError } from '../errors.js';

export interface DslWireModule {
  readonly path: string;
  readonly yaml: string;
}

export interface DslWireSpecEndpoint {
  readonly specId: string;
  readonly path: string;
  readonly method: string;
}

export interface DslWirePayload {
  readonly modules: readonly DslWireModule[];
  readonly typescript: object | null;
  readonly specEndpoints: readonly DslWireSpecEndpoint[];
}

export interface DslInstalledResponse {
  readonly boundaryCount: number;
  readonly yamlReducerCount: number;
  readonly tsReducerCount: number;
  readonly specVersion: string;
}

export interface DslErrorResponse {
  readonly code: string;
  readonly messages: readonly string[];
  readonly moduleLocations?: readonly { path: string; line?: number }[];
}

// Validate POST /_engine/dsl request body. Throws BootError with code
// BOOT_ERR_MALFORMED_BUNDLE on any structural failure.
export function validateDslWirePayload(raw: unknown): DslWirePayload {
  if (!isObject(raw)) {
    throw mkError('payload must be a JSON object');
  }

  const modules = (raw as Record<string, unknown>)['modules'];
  if (!Array.isArray(modules)) {
    throw mkError('"modules" must be an array (may be empty)');
  }
  const validatedModules: DslWireModule[] = [];
  for (let i = 0; i < modules.length; i++) {
    const m = modules[i];
    if (!isObject(m)) throw mkError(`modules[${i}] must be an object`);
    if (typeof m['path'] !== 'string' || (m['path'] as string).length === 0) {
      throw mkError(`modules[${i}].path must be a non-empty string`);
    }
    if (typeof m['yaml'] !== 'string') {
      throw mkError(`modules[${i}].yaml must be a string`);
    }
    validatedModules.push({ path: m['path'] as string, yaml: m['yaml'] as string });
  }

  // null and absent both skip the TS discovery pipeline.
  const typescriptRaw = (raw as Record<string, unknown>)['typescript'];
  let typescript: object | null = null;
  if (typescriptRaw !== undefined && typescriptRaw !== null) {
    if (!isObject(typescriptRaw)) {
      throw mkError('"typescript" must be an object or null');
    }
    typescript = typescriptRaw;
  }

  const specEndpoints = (raw as Record<string, unknown>)['specEndpoints'];
  if (!Array.isArray(specEndpoints)) {
    throw mkError('"specEndpoints" must be an array (may be empty)');
  }
  const validatedEps: DslWireSpecEndpoint[] = [];
  for (let i = 0; i < specEndpoints.length; i++) {
    const e = specEndpoints[i];
    if (!isObject(e)) throw mkError(`specEndpoints[${i}] must be an object`);
    if (typeof e['specId'] !== 'string') {
      throw mkError(`specEndpoints[${i}].specId must be a string`);
    }
    if (typeof e['path'] !== 'string') {
      throw mkError(`specEndpoints[${i}].path must be a string`);
    }
    if (typeof e['method'] !== 'string') {
      throw mkError(`specEndpoints[${i}].method must be a string`);
    }
    validatedEps.push({
      specId: e['specId'] as string,
      path: e['path'] as string,
      method: (e['method'] as string).toUpperCase(),
    });
  }

  return { modules: validatedModules, typescript, specEndpoints: validatedEps };
}

function mkError(message: string): BootError {
  return new BootError('BOOT_ERR_MALFORMED_BUNDLE', message, { message });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
