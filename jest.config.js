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
    'node_modules/(?!(rcc-debugcenter|rcc-basemodule|rcc-errorhandling)/)',
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
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  maxWorkers: '50%',
  verbose: false,
  testTimeout: 30000,
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^rcc-debugcenter$': '<rootDir>/tests/mocks/rcc-debugcenter.ts',
    '^rcc-basemodule$': '<rootDir>/tests/mocks/rcc-basemodule.ts',
    '^rcc-errorhandling$': '<rootDir>/tests/mocks/rcc-errorhandling.ts',
    '.*modules/llmswitch/core-loader\\.js$': '<rootDir>/tests/mocks/core-loader.ts',
    '^yaml$': '<rootDir>/tests/mocks/yaml.js',
  },
};

export default config;
