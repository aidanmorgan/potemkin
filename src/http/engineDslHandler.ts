// Transport-layer handlers for POST /_engine/dsl and
// GET /_engine/state/{boundary}/{id}. State is held by the caller-supplied
// DslInstallStore and StateAccessor; the HTTP wrapper translates the
// returned kind into a status code, headers, and body.

import { computeSpecVersion } from '../dsl/specVersion.js';
import { validateDslWirePayload } from '../dsl/wireSchema.js';
import type {
  DslWirePayload,
  DslInstalledResponse,
  DslErrorResponse,
} from '../dsl/wireSchema.js';

export interface InstalledBundle {
  readonly specVersion: string;
  readonly boundaryCount: number;
  readonly yamlReducerCount: number;
  readonly tsReducerCount: number;
}

export interface DslInstallStore {
  get(): InstalledBundle | null;
  install(bundle: InstalledBundle): Promise<void>;
}

// kind → status: installed → 200, replay → 304 (with X-Potemkin-Spec-Version
// header), badRequest → 400, unavailable → 503.
export type EngineDslResult =
  | { kind: 'installed'; body: DslInstalledResponse }
  | { kind: 'replay'; specVersion: string }
  | { kind: 'badRequest'; body: DslErrorResponse }
  | { kind: 'unavailable'; reason: string };

export interface InstallProducer {
  // Compile the validated payload into an InstalledBundle (or throw a
  // BootError surfaced as 400). Caller-supplied so engine specifics stay
  // outside this transport-layer module.
  install(payload: DslWirePayload): Promise<InstalledBundle>;
}

export async function handleEngineDsl(
  raw: unknown,
  store: DslInstallStore,
  producer: InstallProducer,
  opts: { acceptingNewBundles?: boolean } = {},
): Promise<EngineDslResult> {
  if (opts.acceptingNewBundles === false) {
    return { kind: 'unavailable', reason: 'engine is not accepting new DSL right now' };
  }

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

  const specVersion = computeSpecVersion(payload.modules);
  const installed = store.get();
  if (installed && installed.specVersion === specVersion) {
    return { kind: 'replay', specVersion };
  }

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
  get(boundary: string, id: string): StateBundle | null;
}

// kind → status: found → 200 (body merges state with a _meta block),
// notFound → 404. Side-effect-free.
export type EngineStateResult =
  | { kind: 'found'; body: JsonObject }
  | { kind: 'notFound' };

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
