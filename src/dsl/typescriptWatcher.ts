import { BootError } from '../errors.js';
import { scanTypescriptReducers, type TypescriptConfig } from './typescriptScanner.js';

// Chokidar-driven watcher with a single global debounce: after any matched
// file changes, wait debounceMs for the change stream to quiesce, then rescan
// every file and invoke onSwap with the new RegisteredReducer snapshot.
// `start()` returns a stop() handle that closes the watcher (used by tests).

export interface WatcherOptions {
  readonly config: TypescriptConfig;
  readonly cwd: string;
  readonly onSwap: (registered: ReturnType<typeof scanTypescriptReducers> extends Promise<infer R> ? R : never) => Promise<void> | void;
  readonly onError?: (err: Error) => void;
}

export interface Watcher {
  stop(): Promise<void>;
}

const DEFAULT_DEBOUNCE_MS = 200;

export async function startTypescriptWatcher(opts: WatcherOptions): Promise<Watcher> {
  if (process.env['NODE_ENV'] === 'production') {
    throw new BootError(
      'BOOT_ERR_WATCH_IN_PRODUCTION',
      'typescript.watch: true is disabled in production',
      { nodeEnv: 'production' },
    );
  }

  const debounceMs = opts.config.watchDebounceMs ?? DEFAULT_DEBOUNCE_MS;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const chokidar = require('chokidar');

  // Initial scan seeds the registry; the watcher tracks subsequent changes.
  await scanTypescriptReducers(opts.config, { cwd: opts.cwd });

  const patterns: string[] = [];
  for (const entry of opts.config.scan) {
    for (const pat of entry.include) patterns.push(pat);
  }

  const w = chokidar.watch(patterns, {
    cwd: opts.cwd,
    ignored: opts.config.scan.flatMap((e) => e.exclude ?? []),
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 10 },
  });

  let timer: NodeJS.Timeout | null = null;
  const scheduleRescan = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void rescan();
    }, debounceMs);
  };

  const rescan = async (): Promise<void> => {
    try {
      const result = await scanTypescriptReducers(opts.config, { cwd: opts.cwd });
      await opts.onSwap(result);
    } catch (e) {
      opts.onError?.(e as Error);
    }
  };

  w.on('add', scheduleRescan);
  w.on('change', scheduleRescan);
  w.on('unlink', scheduleRescan);
  if (opts.onError) w.on('error', (e: unknown) => opts.onError?.(e as Error));

  return {
    async stop(): Promise<void> {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await w.close();
    },
  };
}
