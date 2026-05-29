/**
 * Tests for src/http/engineDslHandler.ts (REQ-WIRE-001/003/005).
 */

import {
  handleEngineDsl,
  handleEngineState,
  type DslInstallStore,
  type InstallProducer,
  type InstalledBundle,
  type StateAccessor,
} from '../../../src/http/engineDslHandler.js';
import { computeSpecVersion } from '../../../src/dsl/specVersion.js';

function makeStore(initial: InstalledBundle | null = null): DslInstallStore {
  let cur = initial;
  return {
    get: () => cur,
    install: async (b) => {
      cur = b;
    },
  };
}

function makeProducer(
  bundle: Omit<InstalledBundle, 'specVersion'> | { error: string },
): InstallProducer {
  return {
    install: async (payload) => {
      if ('error' in bundle) {
        const e = new Error(bundle.error);
        (e as { code?: string }).code = 'BOOT_ERR_DSL_SCHEMA_VIOLATION';
        throw e;
      }
      return {
        ...bundle,
        specVersion: computeSpecVersion(payload.modules),
      };
    },
  };
}

describe('handleEngineDsl — install/replay flow (REQ-WIRE-003)', () => {
  it('returns installed{200} for a fresh bundle', async () => {
    const r = await handleEngineDsl(
      {
        modules: [{ path: 'a.yaml', yaml: 'x' }],
        typescript: null,
        specEndpoints: [],
      },
      makeStore(),
      makeProducer({ boundaryCount: 1, yamlReducerCount: 0, tsReducerCount: 0 }),
    );
    expect(r.kind).toBe('installed');
    if (r.kind === 'installed') {
      expect(r.body.boundaryCount).toBe(1);
      expect(r.body.specVersion).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('returns replay{304} when the same bundle is posted again', async () => {
    const modules = [{ path: 'a.yaml', yaml: 'x' }];
    const v = computeSpecVersion(modules);
    const store = makeStore({
      specVersion: v,
      boundaryCount: 1,
      yamlReducerCount: 0,
      tsReducerCount: 0,
    });
    const r = await handleEngineDsl(
      { modules, typescript: null, specEndpoints: [] },
      store,
      makeProducer({ boundaryCount: 9, yamlReducerCount: 9, tsReducerCount: 9 }),
    );
    expect(r.kind).toBe('replay');
    if (r.kind === 'replay') expect(r.specVersion).toBe(v);
  });
});

describe('handleEngineDsl — malformed bundles (REQ-WIRE-001)', () => {
  it('returns badRequest{400} when the payload is malformed', async () => {
    const r = await handleEngineDsl(
      'not an object',
      makeStore(),
      makeProducer({ boundaryCount: 0, yamlReducerCount: 0, tsReducerCount: 0 }),
    );
    expect(r.kind).toBe('badRequest');
    if (r.kind === 'badRequest') {
      expect(r.body.code).toBe('BOOT_ERR_MALFORMED_BUNDLE');
    }
  });
});

describe('handleEngineDsl — install rejected (REQ-WIRE-003 AC-003.2)', () => {
  it('returns badRequest when producer throws and leaves the store unchanged', async () => {
    const installed: InstalledBundle = {
      specVersion: 'prev',
      boundaryCount: 5,
      yamlReducerCount: 5,
      tsReducerCount: 0,
    };
    const store = makeStore(installed);
    const r = await handleEngineDsl(
      { modules: [{ path: 'a.yaml', yaml: 'x' }], typescript: null, specEndpoints: [] },
      store,
      makeProducer({ error: 'bad reducer' }),
    );
    expect(r.kind).toBe('badRequest');
    expect(store.get()).toBe(installed); // unchanged
  });
});

describe('handleEngineDsl — unavailable (REQ-WIRE-003 AC-003.3)', () => {
  it('returns unavailable{503} when not accepting bundles', async () => {
    const r = await handleEngineDsl(
      { modules: [], typescript: null, specEndpoints: [] },
      makeStore(),
      makeProducer({ boundaryCount: 0, yamlReducerCount: 0, tsReducerCount: 0 }),
      { acceptingNewBundles: false },
    );
    expect(r.kind).toBe('unavailable');
  });
});

describe('handleEngineState (REQ-WIRE-005)', () => {
  it('returns found{200} with state + _meta when the aggregate exists', () => {
    const acc: StateAccessor = {
      get: () => ({
        state: { id: 'abc-123', status: 'OPEN' },
        meta: {
          version: 7,
          lastEvent: 'LeadCreated',
          computedFields: ['summary'],
          patchJournal: [{ source: 'reducer', op: 'replace', path: '/status', value: 'OPEN' }],
        },
      }),
    };
    const r = handleEngineState('Lead', 'abc-123', acc);
    expect(r.kind).toBe('found');
    if (r.kind === 'found') {
      expect(r.body['id']).toBe('abc-123');
      expect(r.body['status']).toBe('OPEN');
      const meta = r.body['_meta'] as Record<string, unknown>;
      expect(meta['version']).toBe(7);
      expect(meta['lastEvent']).toBe('LeadCreated');
    }
  });

  it('returns notFound{404} when the aggregate has no events', () => {
    const acc: StateAccessor = { get: () => null };
    const r = handleEngineState('Lead', 'missing', acc);
    expect(r.kind).toBe('notFound');
  });

  it('is side-effect-free — does not mutate the accessor (AC-005.3)', () => {
    let getCount = 0;
    const acc: StateAccessor = {
      get: () => {
        getCount++;
        return null;
      },
    };
    handleEngineState('Lead', 'x', acc);
    handleEngineState('Lead', 'x', acc);
    expect(getCount).toBe(2);
  });
});
