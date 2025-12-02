import { jest } from '@jest/globals';

jest.mock('../sharedmodule/llmswitch-core/dist/router/virtual-router/error-center.js', () => ({
  providerErrorCenter: { emit: jest.fn() }
}), { virtual: true });

jest.mock('../sharedmodule/llmswitch-core/dist/router/virtual-router/types.js', () => ({}), { virtual: true });
