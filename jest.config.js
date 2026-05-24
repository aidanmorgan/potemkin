/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  collectCoverageFrom: ['src/**/*.ts'],
  coveragePathIgnorePatterns: ['/node_modules/', 'src/index\\.ts'],
  coverageThreshold: {
    global: {
      statements: 80,
      branches: 80,
      functions: 80,
      lines: 80,
    },
  },
  testMatch: ['**/*.test.ts', '**/*.spec.ts'],
  // Exclude CLI contract tests — they require Java and a live Specmatic jar.
  // Run them with: npm run test:contract
  testPathIgnorePatterns: [
    '/node_modules/',
    '/tests/integration/specmatic-cli/',
    '/tests/e2e/',
  ],
  moduleFileExtensions: ['ts', 'js', 'json'],
  setupFilesAfterEach: ['<rootDir>/tests/setup.ts'],
  // Map .js imports to .ts sources so ts-jest can resolve them in CommonJS mode.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
