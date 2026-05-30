// Shared per-test teardown registry. Tests (or helpers they call) register a
// cleanup callback here; setupAfterEnv.ts drains the queue in afterEach. Used
// to close TypeScript watchers (C6) so a watch handle never outlives a test.

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
