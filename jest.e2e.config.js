/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/e2e'],
  testMatch: ['**/tests/e2e/**/*.e2e-test.ts'],
  testTimeout: 60_000,
  // Serialise JVM startup — running multiple Specmatic instances in parallel
  // exhausts memory and ports.
  maxWorkers: 1,
  // The shared in-process engine and ts-jest's compiler service are owned by
  // the worker for the whole run; forceExit lets the worker's exit cleanup
  // terminate them after Jest has reported all suites.
  forceExit: true,
  // Keep process-global SDK registries, environment overrides, and watchers
  // isolated between suites. Full-stack suites share the same Jest worker.
  setupFilesAfterEnv: ['<rootDir>/tests/e2e/setupAfterEnv.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Map .js imports to .ts sources so ts-jest can resolve them in CommonJS mode.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // ts-jest transformation (inherit from the project tsconfig)
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.json',
      },
    ],
  },
};
