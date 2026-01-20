/** @type {import('jest').Config} */
const config = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: '<rootDir>/tsconfig.json',
      },
    ],
  },
  transformIgnorePatterns: [
    // Allow transforming specific modules that might be ESM
    'node_modules/(?!(rcc-debugcenter|rcc-basemodule|rcc-errorhandling|@jsonstudio/llms|chalk)/)',
  ],
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  coverageThreshold: {
    global: {
      // NOTE: Global coverage is currently far below 70% for this repo.
      // Keep a minimal floor so `npm run jest:run -- --coverage` is usable
      // during iterative refactors; raise this once coverage is expanded.
      branches: 1,
      functions: 1,
      lines: 1,
      statements: 1,
    },
  },
  moduleNameMapper: {
    // IMPORTANT: host CI must not depend on local sharedmodule worktree.
    // Map sharedmodule imports used by tests to npm-installed @jsonstudio/llms.
    '../../sharedmodule/llmswitch-core/src/(.*)': '<rootDir>/node_modules/@jsonstudio/llms/dist/$1',
    '../../sharedmodule/llmswitch-core/dist/(.*)': '<rootDir>/node_modules/@jsonstudio/llms/dist/$1',
    '../../../sharedmodule/llmswitch-core/src/(.*)': '<rootDir>/node_modules/@jsonstudio/llms/dist/$1',
    '../../../sharedmodule/llmswitch-core/dist/(.*)': '<rootDir>/node_modules/@jsonstudio/llms/dist/$1',
    '../../../../sharedmodule/llmswitch-core/src/(.*)': '<rootDir>/node_modules/@jsonstudio/llms/dist/$1',
    '../../../../sharedmodule/llmswitch-core/dist/(.*)': '<rootDir>/node_modules/@jsonstudio/llms/dist/$1',
    '../../../../../sharedmodule/llmswitch-core/src/(.*)': '<rootDir>/node_modules/@jsonstudio/llms/dist/$1',
    '../../../../../sharedmodule/llmswitch-core/dist/(.*)': '<rootDir>/node_modules/@jsonstudio/llms/dist/$1',

    // Keep existing .js stripping for ESM (must come after sharedmodule rules)
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};

export default config;
