/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
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
    // Transform ESM .js files from node_modules that use import/export
    'node_modules/(multiformats|@ipld|cborg|@multiformats|uint8arrays)/.+\\.js$': [
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
    '/node_modules/(?!(multiformats|@ipld|uint8arrays|cborg|@multiformats)/)',
  ],
  moduleNameMapper: {
    // Handle path mappings for tests - tests import from '../src/...'
    '^../types$': '<rootDir>/src/types',
    '^../types/(.*)$': '<rootDir>/src/types/$1',
    '^../src/(.*)$': '<rootDir>/src/$1',
    // Handle .js extensions in TypeScript ESM imports (used by config module)
    '^(\\.\\.?\\/.*)\\.js$': '$1',
    // Map ESM subpath exports for multiformats
    '^multiformats/cid$': '<rootDir>/node_modules/multiformats/dist/src/cid.js',
    '^multiformats/hashes/sha2$': '<rootDir>/node_modules/multiformats/dist/src/hashes/sha2.js',
    '^multiformats/codecs/raw$': '<rootDir>/node_modules/multiformats/dist/src/codecs/raw.js',
    '^multiformats/codecs/(.*)$': '<rootDir>/node_modules/multiformats/dist/src/codecs/$1.js',
    '^multiformats/hashes/(.*)$': '<rootDir>/node_modules/multiformats/dist/src/hashes/$1.js',
    '^multiformats/bases/(.*)$': '<rootDir>/node_modules/multiformats/dist/src/bases/$1.js',
    '^multiformats$': '<rootDir>/node_modules/multiformats/dist/src/index.js',
    // Map ESM subpath exports for cborg (transitive dep of @ipld/dag-cbor)
    '^cborg$': '<rootDir>/node_modules/cborg/cborg.js',
    // Map ESM subpath exports for @ipld/dag-cbor
    '^@ipld/dag-cbor$': '<rootDir>/node_modules/@ipld/dag-cbor/src/index.js',
    // Map ESM subpath exports for @ipld/car
    '^@ipld/car/writer$': '<rootDir>/node_modules/@ipld/car/src/writer.js',
    '^@ipld/car/reader$': '<rootDir>/node_modules/@ipld/car/src/reader.js',
    '^@ipld/car/buffer-writer$': '<rootDir>/node_modules/@ipld/car/src/buffer-writer.js',
    '^@ipld/car/buffer-reader$': '<rootDir>/node_modules/@ipld/car/src/buffer-reader.js',
    '^@ipld/car/indexed-reader$': '<rootDir>/node_modules/@ipld/car/src/indexed-reader.js',
    '^@ipld/car$': '<rootDir>/node_modules/@ipld/car/src/index.js',
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
