/**
 * Pure-logic handlers for `POST /_engine/dsl` (REQ-WIRE-001/003) and
 * `GET /_engine/state/{boundary}/{id}` (REQ-WIRE-005).
 *
 * Designed to be wired into the Express gateway during Stage 3; for now
 * they are independently testable and stateful only through the supplied
 * `DslInstallStore` and `StateAccessor`. The host wires real engine
 * components in; tests inject fakes.
 */

import { computeSpecVersion } from '../dsl/specVersion.js';
import { validateDslWirePayload } from '../dsl/wireSchema.js';
import type {
  DslWirePayload,
  DslInstalledResponse,
  DslErrorResponse,
} from '../dsl/wireSchema.js';

// ---------------------------------------------------------------------------
// POST /_engine/dsl
// ---------------------------------------------------------------------------

export interface InstalledBundle {
  readonly specVersion: string;
  readonly boundaryCount: number;
  readonly yamlReducerCount: number;
  readonly tsReducerCount: number;
}

export interface DslInstallStore {
  /** Return the currently-installed bundle, or null when none. */
  get(): InstalledBundle | null;
  /** Atomically install a new bundle, replacing any prior one. */
  install(bundle: InstalledBundle): Promise<void>;
}

/**
 * Result shape for the pure `handleEngineDsl` function. The HTTP wrapper
 * translates `{kind: ...}` into status code + headers + body.
 */
export type EngineDslResult =
  | { kind: 'installed'; body: DslInstalledResponse }
  | { kind: 'replay'; specVersion: string }
  | { kind: 'badRequest'; body: DslErrorResponse }
  | { kind: 'unavailable'; reason: string };

export interface InstallProducer {
  /**
   * Compile the validated payload into an InstalledBundle (or throw a BootError
   * that the caller surfaces as 400). Caller-supplied so engine specifics live
   * outside this transport-layer module.
   */
  install(payload: DslWirePayload): Promise<InstalledBundle>;
}

/**
 * Resolve a POST /_engine/dsl request to an EngineDslResult.
 *
 * Status code mapping (caller):
 *   - installed → 200, body returned
 *   - replay    → 304, header X-Potemkin-Spec-Version: <hash>
 *   - badRequest → 400, body returned
 *   - unavailable → 503
 */
export async function handleEngineDsl(
  raw: unknown,
  store: DslInstallStore,
  producer: InstallProducer,
  opts: { acceptingNewBundles?: boolean } = {},
): Promise<EngineDslResult> {
  if (opts.acceptingNewBundles === false) {
    return { kind: 'unavailable', reason: 'engine is not accepting new DSL right now' };
  }

  // ── Structural validation (REQ-WIRE-001) ──
  let payload: DslWirePayload;
  try {
    payload = validateDslWirePayload(raw);
  } catch (e) {
    return {
      kind: 'badRequest',
      body: {
        code: 'BOOT_ERR_MALFORMED_BUNDLE',
        messages: [(e as Error).message],
      },
    };
  }

  // ── Compute hash, check installed for replay (REQ-WIRE-003) ──
  const specVersion = computeSpecVersion(payload.modules);
  const installed = store.get();
  if (installed && installed.specVersion === specVersion) {
    return { kind: 'replay', specVersion };
  }

  // ── Install (REQ-WIRE-003 AC-003.1) ──
  let bundle: InstalledBundle;
  try {
    bundle = await producer.install(payload);
  } catch (e) {
    return {
      kind: 'badRequest',
      body: {
        code: (e as { code?: string }).code ?? 'BOOT_ERR_DSL_SCHEMA_VIOLATION',
        messages: [(e as Error).message],
      },
    };
  }

  await store.install(bundle);
  return {
    kind: 'installed',
    body: {
      boundaryCount: bundle.boundaryCount,
      yamlReducerCount: bundle.yamlReducerCount,
      tsReducerCount: bundle.tsReducerCount,
      specVersion: bundle.specVersion,
    },
  };
}

// ---------------------------------------------------------------------------
// GET /_engine/state/{boundary}/{id}
// ---------------------------------------------------------------------------

import type { JsonValue, JsonObject } from '../types.js';
import type { JournalEntry } from '../dsl/patches.js';

export interface StateMeta {
  readonly version: number;
  readonly lastEvent: string | null;
  readonly computedFields: readonly string[];
  readonly patchJournal: readonly JournalEntry[];
}

export interface StateBundle {
  readonly state: JsonObject;
  readonly meta: StateMeta;
}

export interface StateAccessor {
  /** Return the projected state + meta for the (boundary, id) aggregate, or null. */
  get(boundary: string, id: string): StateBundle | null;
}

export type EngineStateResult =
  | { kind: 'found'; body: JsonObject }
  | { kind: 'notFound' };

/**
 * Resolve a GET /_engine/state/{boundary}/{id} request.
 *
 * Status code mapping (caller):
 *   - found → 200, body = state with `_meta` block (REQ-WIRE-005 AC-005.1)
 *   - notFound → 404 (REQ-WIRE-005 AC-005.2)
 *
 * Side-effect-free (REQ-WIRE-005 AC-005.3) — only reads from the accessor.
 */
export function handleEngineState(
  boundary: string,
  id: string,
  accessor: StateAccessor,
): EngineStateResult {
  const bundle = accessor.get(boundary, id);
  if (!bundle) return { kind: 'notFound' };
  return {
    kind: 'found',
    body: {
      ...bundle.state,
      _meta: {
        version: bundle.meta.version,
        lastEvent: bundle.meta.lastEvent,
        computedFields: [...bundle.meta.computedFields],
        patchJournal: bundle.meta.patchJournal.map((j) => ({ ...j }) as unknown as JsonValue),
      } as unknown as JsonValue,
    },
  };
}
