// Per-test process.env isolation (potemkin-1ef).
//
// jest runs multiple test files sequentially within a single worker PROCESS, so
// process.env mutations (ENGINE_ROUTES_TTL_SECONDS, ALLOWED_ORIGINS, ADMIN_TOKEN,
// LOG_LEVEL, OTEL_*, etc.) leak across files in the same worker and cause
// intermittent failures (a test observing env state another test set/left).
// Snapshot env before each test and restore it after, so every test sees a
// pristine, isolated environment regardless of what others do.

let envSnapshot: Record<string, string | undefined>;

beforeEach(() => {
  envSnapshot = { ...process.env };
});

afterEach(() => {
  // Remove keys added during the test.
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key];
  }
  // Restore keys that were changed or deleted during the test.
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

export {};
