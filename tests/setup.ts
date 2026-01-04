import { jest } from '@jest/globals';

// Disable retry logic inside Jest itself; the runtime code now owns retries.
jest.retryTimes(0);

export {};
