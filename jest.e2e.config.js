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
