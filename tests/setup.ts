// Runs once per test file before any imports of the system under test.
// Suppress pino logging in tests — verbose stderr writes were racing with
// supertest-driven assertions and producing intermittent 500 responses.
if (process.env['LOG_LEVEL'] === undefined) {
  process.env['LOG_LEVEL'] = 'silent';
}
export {};
