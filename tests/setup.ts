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
  // Clear any mock calls between tests
  jest.clearAllMocks();
});