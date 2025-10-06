// Test setup file
import { beforeEach, jest } from '@jest/globals';

// Mock environment variables for testing
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';

// Mock rcc-debugcenter module to avoid ESM import issues
jest.mock('rcc-debugcenter', () => ({
  DebugCenter: jest.fn(),
  DebugEventBus: jest.fn(),
  createDebugLogger: jest.fn(),
  createDebugTimer: jest.fn(),
  default: jest.fn()
}), { virtual: true });

// Global test setup
beforeEach(() => {
  // Clear mock call history between tests; jest.config resetMocks will reset implementations
  jest.clearAllMocks();
});

// Provide a spy-friendly mock for 'yaml' ESM package
jest.mock('yaml', () => ({
  parse: jest.fn((content: string) => ({ mocked: true, content })),
}), { virtual: true });
