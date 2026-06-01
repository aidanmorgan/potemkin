// Shared per-test teardown registry. Tests (or helpers they call) register a
// cleanup callback here; setupAfterEnv.ts drains the queue in afterEach. Used
// to close TypeScript watchers so a watch handle never outlives a test.

type TeardownFn = () => void | Promise<void>;

const pending: TeardownFn[] = [];

/** Register a cleanup callback to run (once) after the current test. */
export function registerTeardown(fn: TeardownFn): void {
  pending.push(fn);
}

/** Run and clear every registered teardown callback. Errors are swallowed. */
export async function runTeardowns(): Promise<void> {
  while (pending.length > 0) {
    const fn = pending.pop()!;
    try {
      await fn();
    } catch {
      /* best-effort cleanup */
    }
  }
}

// File-scoped teardown registry. Unlike `pending` (drained every afterEach),
// this queue is drained once in afterAll, so resources that must live for the
// whole test file — e.g. a persistent app.listen server shared across all tests
// in a suite (see persistentAgent.ts) — are not torn down between tests.
const pendingFileScoped: TeardownFn[] = [];

/** Register a cleanup callback to run (once) in afterAll for the current file. */
export function registerFileTeardown(fn: TeardownFn): void {
  pendingFileScoped.push(fn);
}

/** Run and clear every file-scoped teardown callback. Errors are swallowed. */
export async function runFileTeardowns(): Promise<void> {
  while (pendingFileScoped.length > 0) {
    const fn = pendingFileScoped.pop()!;
    try {
      await fn();
    } catch {
      /* best-effort cleanup */
    }
  }
}
