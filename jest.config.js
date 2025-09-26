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
        isolatedModules: true,
        tsconfig: {
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          verbatimModuleSyntax: false,
        },
      },
    ],
  },
  transformIgnorePatterns: [
    'node_modules/(?!(rcc-debugcenter|rcc-basemodule|rcc-basemodule-adv|rcc-errorhandling)/)',
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
    '^rcc-debugcenter$': '<rootDir>/node_modules/rcc-debugcenter/dist/index.esm.js',
    '^rcc-basemodule$': '<rootDir>/node_modules/rcc-basemodule/dist/index.esm.js',
    '^rcc-basemodule-adv$': '<rootDir>/node_modules/rcc-basemodule-adv/dist/index.esm.js',
    '^rcc-errorhandling$': '<rootDir>/node_modules/rcc-errorhandling/dist/index.esm.js',
  },
  };

export default config;