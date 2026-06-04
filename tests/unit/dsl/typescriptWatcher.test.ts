import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { startTypescriptWatcher } from '../../../src/dsl/typescriptWatcher.js';
import { registry } from '../../../src/sdk/index.js';
import { BootError } from '../../../src/errors.js';
import * as typescriptScanner from '../../../src/dsl/typescriptScanner.js';
import type { ScannerResult } from '../../../src/dsl/typescriptScanner.js';
import { createTsScriptRegistry } from '../../../src/engine/tsScriptRegistry.js';
import type { RegisteredScript } from '../../../src/sdk/index.js';

async function makeTree(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-ts-watch-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
  return root;
}

/** Returns a deferred promise and a resolve function to settle it externally. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  await registry.reset();
});

describe('typescriptWatcher — production guard', () => {
  it('throws when NODE_ENV=production', async () => {
    const prior = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    let caught: BootError | null = null;
    try {
      await startTypescriptWatcher({
        config: { scan: [{ include: ['*.ts'] }], watch: true },
        cwd: process.cwd(),
        onSwap: async () => {},
      });
    } catch (e) {
      if (e instanceof BootError) caught = e;
    } finally {
      if (prior === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = prior;
    }
    expect(caught?.code).toBe('BOOT_ERR_WATCH_IN_PRODUCTION');
  });
});

describe('typescriptWatcher — debounced rescan', () => {
  it('rescans after a file change and invokes onSwap with the new registry snapshot', async () => {
    const root = await makeTree({
      'src/r/a.ts': `require('@potemkin/sdk').reducer({ boundary: 'A', event: 'E1' }, () => []);`,
    });

    const swaps: number[] = [];
    const w = await startTypescriptWatcher({
      config: { scan: [{ include: ['src/r/**/*.ts'] }], watch: true, watchDebounceMs: 50 },
      cwd: root,
      onSwap: (r) => {
        swaps.push(r.registered.length);
      },
    });

    try {
      // Wait briefly so the watcher's stability-threshold has time to attach.
      await new Promise((r) => setTimeout(r, 100));
      await fs.writeFile(
        path.join(root, 'src/r/b.ts'),
        `require('@potemkin/sdk').reducer({ boundary: 'B', event: 'E2' }, () => []);`,
        'utf8',
      );
      // Poll for up to 3s for the rescan to fire.
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && swaps.length === 0) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(swaps.length).toBeGreaterThanOrEqual(1);
      expect(swaps[swaps.length - 1]).toBe(2);
    } finally {
      await w.stop();
    }
  });
});

describe('typescriptWatcher — in-flight guard (no concurrent rescans)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('coalesces a second change event that arrives while the first rescan is in-flight — no BOOT_ERR_REDUCER_CONFLICT, onError is never called for a conflict, and exactly one follow-up rescan runs', async () => {
    // Arrange deferred promises for the two triggered rescans (the initial scan
    // resolves immediately so startTypescriptWatcher can complete).
    const emptyResult: ScannerResult = { files: [], registered: [], scripts: [] };
    const d1 = deferred<ScannerResult>(); // first triggered rescan (held in-flight)
    const d2 = deferred<ScannerResult>(); // coalesced follow-up rescan
    let rescanCallCount = 0; // counts only post-start rescan calls (not the initial one)

    // The initial call inside startTypescriptWatcher resolves immediately.
    // Subsequent calls (triggered rescans) use our deferreds.
    const spy = jest.spyOn(typescriptScanner, 'scanTypescriptReducers').mockImplementation(() => {
      if (rescanCallCount === 0) {
        // First triggered rescan — hold it in-flight.
        rescanCallCount++;
        return d1.promise;
      } else if (rescanCallCount === 1) {
        // Coalesced follow-up rescan.
        rescanCallCount++;
        return d2.promise;
      }
      // Any unexpected extra call — resolve immediately so the test can surface the assertion.
      rescanCallCount++;
      return Promise.resolve(emptyResult);
    });

    const errors: Error[] = [];
    const swapResults: ScannerResult[] = [];

    // Pre-create the watched directory and an initial file so chokidar can
    // watch it from the start; changes to files in this tree will fire events.
    const root = await makeTree({
      'src/r/seed.ts': `// placeholder so chokidar has an existing dir to watch`,
    });

    // Reset the mock so that the FIRST call (initial scan) resolves immediately,
    // then subsequent calls use the deferred logic above.
    spy.mockRestore();
    const spyFinal = jest.spyOn(typescriptScanner, 'scanTypescriptReducers').mockImplementation(() => {
      const callIndex = rescanCallCount;
      rescanCallCount++;
      if (callIndex === 0) {
        // Call 0: initial scan inside startTypescriptWatcher — resolve immediately.
        return Promise.resolve(emptyResult);
      } else if (callIndex === 1) {
        // Call 1: first triggered rescan — hold in-flight.
        return d1.promise;
      } else if (callIndex === 2) {
        // Call 2: coalesced follow-up rescan.
        return d2.promise;
      }
      // Any unexpected extra call.
      return Promise.resolve(emptyResult);
    });

    const w = await startTypescriptWatcher({
      config: { scan: [{ include: ['src/r/**/*.ts'] }], watch: true, watchDebounceMs: 10 },
      cwd: root,
      onSwap: (r) => { swapResults.push(r); },
      onError: (e) => { errors.push(e); },
    });

    try {
      // Give chokidar time to attach to the watched directory.
      await new Promise((r) => setTimeout(r, 150));

      // Write a file to trigger the first chokidar change event → scheduleRescan
      // → after debounce fires, rescan() is called → d1 starts (scanInFlight = true).
      await fs.writeFile(
        path.join(root, 'src/r/a.ts'),
        `require('@potemkin/sdk').reducer({ boundary: 'A', event: 'E1' }, () => []);`,
        'utf8',
      );

      // Poll until the first triggered rescan has started (callIndex 1 reached).
      const startDeadline = Date.now() + 4000;
      while (Date.now() < startDeadline && rescanCallCount < 2) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(rescanCallCount).toBe(2); // initial(0) + first rescan(1)

      // Now write a second file while d1 is still in-flight.
      // The in-flight guard must set scanPending=true and NOT call scanTypescriptReducers again.
      await fs.writeFile(
        path.join(root, 'src/r/b.ts'),
        `require('@potemkin/sdk').reducer({ boundary: 'B', event: 'E2' }, () => []);`,
        'utf8',
      );

      // Wait long enough for chokidar to fire scheduleRescan and the debounce to
      // expire — the guard must absorb this without starting a new scan.
      await new Promise((r) => setTimeout(r, 300));

      // The guard must NOT have advanced to call index 2 yet.
      expect(rescanCallCount).toBe(2);

      // Resolve the first rescan — this should trigger the coalesced follow-up.
      d1.resolve(emptyResult);

      // Poll until the follow-up rescan starts (callIndex 2 reached).
      const followUpDeadline = Date.now() + 4000;
      while (Date.now() < followUpDeadline && rescanCallCount < 3) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(rescanCallCount).toBe(3); // initial + first rescan + one follow-up

      // Resolve the follow-up — no further scan should be triggered.
      d2.resolve(emptyResult);
      await new Promise((r) => setTimeout(r, 150)); // let microtasks drain

      // No BOOT_ERR_REDUCER_CONFLICT error (or any error) reached onError.
      const conflictErrors = errors.filter((e) =>
        e.message.includes('BOOT_ERR_REDUCER_CONFLICT'),
      );
      expect(conflictErrors).toHaveLength(0);
      expect(errors).toHaveLength(0);

      // Exactly 3 scan invocations — no extra concurrent call.
      expect(spyFinal).toHaveBeenCalledTimes(3);
    } finally {
      await w.stop();
    }
  });
});

// ── TsScriptRegistry swap mechanism ──────────────────────────────────────────
//
// These tests exercise the mutable holder directly (no real chokidar watcher
// needed).  The mechanism used in boot.ts is:
//
//   1. createTsScriptRegistry(initialScripts) returns a holder that implements
//      ScriptRegistry and is placed into dsl.scriptRegistry.
//   2. The onSwap callback calls tsScriptRegistry.swap(result.scripts).
//   3. Every subsequent call to dsl.scriptRegistry.get(boundary, name) resolves
//      against the NEW @Script functions because the holder's `current` pointer
//      is updated atomically inside swap().
//
// Because dsl.scriptRegistry is read at UoW time (not captured at boot time),
// all in-flight and future UoWs see the new functions immediately after swap().

describe('TsScriptRegistry — swap updates get() to the new @Script function', () => {
  function makeScript(id: string, returnValue: unknown): RegisteredScript {
    return { id, fn: () => returnValue, source: `test:${id}` };
  }

  it('get() returns the initial function before any swap', () => {
    const initial = makeScript('computeScore', 42);
    const reg = createTsScriptRegistry([initial]);

    const handle = reg.get('Lead', 'computeScore');
    expect(handle).toBeDefined();
    expect(handle!.fn({} as never)).toBe(42);
  });

  it('get() returns the NEW function immediately after swap()', () => {
    const initial = makeScript('computeScore', 42);
    const reg = createTsScriptRegistry([initial]);

    const updated = makeScript('computeScore', 99);
    reg.swap([updated]);

    const handle = reg.get('Lead', 'computeScore');
    expect(handle).toBeDefined();
    expect(handle!.fn({} as never)).toBe(99);
  });

  it('get() returns undefined for an id removed from the snapshot after swap()', () => {
    const initial = makeScript('computeScore', 42);
    const reg = createTsScriptRegistry([initial]);

    reg.swap([]); // empty snapshot — script no longer present

    expect(reg.get('Lead', 'computeScore')).toBeUndefined();
  });

  it('size() reflects the number of scripts after swap()', () => {
    const reg = createTsScriptRegistry([makeScript('s1', 1), makeScript('s2', 2)]);
    expect(reg.size()).toBe(2);

    reg.swap([makeScript('s1', 10), makeScript('s2', 20), makeScript('s3', 30)]);
    expect(reg.size()).toBe(3);
  });

  it('an id present before swap but absent after resolves to the new snapshot only', () => {
    const reg = createTsScriptRegistry([makeScript('scannedFn', 'original'), makeScript('dropped', 'gone')]);

    reg.swap([makeScript('scannedFn', 'updated')]);

    expect(reg.get('Lead', 'scannedFn')!.fn({} as never)).toBe('updated');
    expect(reg.get('Lead', 'dropped')).toBeUndefined();
  });
});

describe('typescriptWatcher — onSwap callback receives scripts in result', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('onSwap result.scripts is the scripts array returned by scanTypescriptReducers', async () => {
    const scriptEntry: RegisteredScript = { id: 'myScript', fn: () => 'v1', source: 'test' };
    const mockResult: ScannerResult = {
      files: [],
      registered: [],
      scripts: [scriptEntry],
    };

    jest.spyOn(typescriptScanner, 'scanTypescriptReducers').mockResolvedValue(mockResult);

    const { promises: fsp } = await import('node:fs');
    const osp = await import('node:path');
    const osp2 = await import('node:os');
    const root = await fsp.mkdtemp(osp.join(osp2.tmpdir(), 'potemkin-ts-watch-scripts-'));
    await fsp.mkdir(osp.join(root, 'src'), { recursive: true });
    await fsp.writeFile(osp.join(root, 'src', 'seed.ts'), '// seed', 'utf8');

    const swapScripts: RegisteredScript[][] = [];

    const w = await startTypescriptWatcher({
      config: { scan: [{ include: ['src/**/*.ts'] }], watch: true, watchDebounceMs: 10 },
      cwd: root,
      onSwap: (r) => { swapScripts.push([...r.scripts]); },
    });

    try {
      await fsp.writeFile(osp.join(root, 'src', 'a.ts'), '// change', 'utf8');

      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && swapScripts.length === 0) {
        await new Promise((r2) => setTimeout(r2, 30));
      }

      expect(swapScripts.length).toBeGreaterThanOrEqual(1);
      const lastSwap = swapScripts[swapScripts.length - 1];
      expect(lastSwap).toHaveLength(1);
      expect(lastSwap[0].id).toBe('myScript');
    } finally {
      await w.stop();
    }
  });
});
