/** @type {import('ts-jest').JestConfigWithTsJest} */
// Consumer-side example tests (examples/<name>/tests). These boot the FULL
// Specmatic stack (Java + plugin JAR) and drive the example through the stub, so
// they are e2e-tier: serialised, long timeout, NOT part of `npm test`.
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/examples'],
  testMatch: ['**/examples/**/tests/**/*.test.ts'],
  testTimeout: 60_000,
  // Serialise JVM startup — multiple Specmatic stubs in parallel exhaust ports/memory.
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
