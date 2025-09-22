// Test setup file
import { beforeEach } from '@jest/globals';

// Mock environment variables for testing
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';

// Global test setup
beforeEach(() => {
  // Clear any mock calls between tests
  jest.clearAllMocks();
});