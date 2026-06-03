/**
 * Engine-only e2e config.
 *
 * Runs the subset of e2e suites that exercise behaviour living entirely in the
 * Node engine and reach it ONLY through the engine HTTP surface (the
 * /_engine/forward + /_admin endpoints). These suites boot via
 * `startEngineOnlyApp` — no Specmatic JVM, no Kotlin plugin — so they run
 * UNCONDITIONALLY, including on CI hosts with no Java available.
 *
 * As more suites migrate to `startEngineOnlyApp`, add their path to
 * `engineOnlySuites` below. Suites that still require the full Specmatic stack
 * (anything touching `app.stubUrl`) stay in jest.e2e.config.js.
 *
 *   npm run test:e2e:engine   # this config (no Java required)
 *   npm run test:e2e          # full suite (requires Java + Specmatic)
 */

/** Engine-only suites — boot via startEngineOnlyApp, no JVM. */
const engineOnlySuites = [
  '26-concurrency-idempotency',
  '38-security-headers',
  '45-polish-features',
  '47-api-versioning',
  // Feature-example suites (one illustrative YAML example per framework feature).
  '60-reducer-patch-ops',
  '61-identity-key',
  '62-behavior-header-match',
  '63-saga-compensation',
  '64-webhook-hmac',
  '65-latency',
  '66-reactions-fanout',
  '67-annotation-script',
  '68-composition',
  '69-strict-schema',
  '70-seeds-engine-only',
];

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/e2e'],
  testMatch: engineOnlySuites.map((name) => `**/tests/e2e/${name}.e2e-test.ts`),
  testTimeout: 60_000,
  maxWorkers: 1,
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.json',
      },
    ],
  },
};
