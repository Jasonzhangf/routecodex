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
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
  },
  moduleNameMapper: {
    // Keep existing .js stripping for ESM
    '^(\\.{1,2}/.*)\\.js$': '$1',

    // IMPORTANT: host CI must not depend on local sharedmodule worktree.
    // Map sharedmodule imports used by tests to npm-installed @jsonstudio/llms.
    '^\\.\\./\\.\\./sharedmodule/llmswitch-core/src/(.*)$': '@jsonstudio/llms/dist/$1',
    '^\\.\\./\\.\\./\\.\\./sharedmodule/llmswitch-core/dist/(.*)$': '@jsonstudio/llms/dist/$1',
  },
};

export default config;
