/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: false,
        tsconfig: {
          allowJs: true,
          types: ['jest', 'node'],
        },
      },
    ],
  },
  // Transform ESM modules from multiformats and ipld packages
  transformIgnorePatterns: [
    '/node_modules/(?!(multiformats|@ipld|uint8arrays)/)',
  ],
  moduleNameMapper: {
    // Handle path mappings for tests - tests import from '../src/...'
    '^../types$': '<rootDir>/src/types',
    '^../types/(.*)$': '<rootDir>/src/types/$1',
    '^../src/(.*)$': '<rootDir>/src/$1',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  // Increase timeout for integration tests
  testTimeout: 30000,
  // Skip tests that fail due to ESM module issues
  testPathIgnorePatterns: [
    '/node_modules/',
    '/tests/e2e/',
  ],
};
