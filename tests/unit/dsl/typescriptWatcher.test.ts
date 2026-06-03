import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { startTypescriptWatcher } from '../../../src/dsl/typescriptWatcher.js';
import { registry } from '../../../src/sdk/index.js';
import { BootError } from '../../../src/errors.js';
import * as typescriptScanner from '../../../src/dsl/typescriptScanner.js';
import type { ScannerResult } from '../../../src/dsl/typescriptScanner.js';

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
