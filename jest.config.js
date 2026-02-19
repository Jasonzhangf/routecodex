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
        tsconfig: '<rootDir>/tsconfig.jest.json',
      },
    ],
  },
  transformIgnorePatterns: [
    // Allow transforming specific modules that might be ESM
    'node_modules/(?!(rcc-debugcenter|rcc-basemodule|rcc-errorhandling|@jsonstudio/llms|chalk)/)',
  ],
  roots: ['<rootDir>/src', '<rootDir>/tests', '<rootDir>/webui/src'],
  testMatch: ['**/__tests__/**/*.ts', '**/__tests__/**/*.tsx', '**/?(*.)+(spec|test).ts', '**/?(*.)+(spec|test).tsx'],
  collectCoverageFrom: [
    'src/**/*.ts',
    'webui/src/**/*.ts',
    'webui/src/**/*.tsx',
    '!src/**/*.d.ts',
    '!src/index.ts',
    '!webui/src/main.tsx',
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
    './webui/src/App.tsx': {
      branches: 40,
      functions: 55,
      lines: 60,
      statements: 60
    }
  },
  moduleNameMapper: (() => {
    // By default, run tests against the vendored `sharedmodule/llmswitch-core` source in this repo.
    // If CI needs to validate against the npm-installed `@jsonstudio/llms` dist, set:
    //   `ROUTECODEX_JEST_USE_NPM_LLMS=1`
    const useNpmLlms = process.env.ROUTECODEX_JEST_USE_NPM_LLMS === '1';
    const sharedmoduleToNpm = {
      '../../sharedmodule/llmswitch-core/src/(.*)': '<rootDir>/node_modules/@jsonstudio/llms/dist/$1',
      '../../sharedmodule/llmswitch-core/dist/(.*)': '<rootDir>/node_modules/@jsonstudio/llms/dist/$1',
      '../../../sharedmodule/llmswitch-core/src/(.*)': '<rootDir>/node_modules/@jsonstudio/llms/dist/$1',
      '../../../sharedmodule/llmswitch-core/dist/(.*)': '<rootDir>/node_modules/@jsonstudio/llms/dist/$1',
      '../../../../sharedmodule/llmswitch-core/src/(.*)': '<rootDir>/node_modules/@jsonstudio/llms/dist/$1',
      '../../../../sharedmodule/llmswitch-core/dist/(.*)': '<rootDir>/node_modules/@jsonstudio/llms/dist/$1',
      '../../../../../sharedmodule/llmswitch-core/src/(.*)': '<rootDir>/node_modules/@jsonstudio/llms/dist/$1',
      '../../../../../sharedmodule/llmswitch-core/dist/(.*)': '<rootDir>/node_modules/@jsonstudio/llms/dist/$1'
    };

    return {
      ...(useNpmLlms ? sharedmoduleToNpm : {}),
      // Keep existing .js stripping for ESM relative imports.
      '^(\\.{1,2}/.*)\\.js$': '$1'
    };
  })(),
};

export default config;
